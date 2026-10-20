// 投稿预检：解析 issue 表单 → 逐链接下载脚本（超时自动重试 3 次）→ 恶意特征扫描 + 疑似音源判定 + 子进程沙箱实测
// → 结果评论到 issue（内嵌机器可读 MARKET-STATS 标记供 build.mjs 提取）。
// 由 precheck.yml 触发（issue opened/edited），需 env：GH_TOKEN、ISSUE_NUMBER、GITHUB_REPOSITORY。
// 安全设计：沙箱在独立子进程跑，环境变量剥空（无 GH_TOKEN）；每 issue 最多预检 3 次防滥用。
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanMalware } from './scan-malware.mjs'
import { classifyEntry, extractMeta } from './source-rules.mjs'
import { parseForm, classifyLink, releaseAssets, gh } from './form.mjs'
import { extractJsLinks as extractJsLinksFrom } from './precheck-lib.mjs'

var token = process.env.GH_TOKEN            // 读接口用（提额防限流，无需写权限）
var commentToken = process.env.COMMENT_TOKEN || token  // 写评论用（须有 issues:write，传 GITHUB_TOKEN）
var repo = process.env.GITHUB_REPOSITORY
var num = parseInt(process.env.ISSUE_NUMBER, 10)
if (!token || !repo || !num) { console.error('缺少 GH_TOKEN / GITHUB_REPOSITORY / ISSUE_NUMBER'); process.exit(1) }

var WORKER = fileURLToPath(new URL('./lx-sandbox.mjs', import.meta.url))
var MAX_FILES_PER_REPO = 100      // 每仓库最多扫描的 .js 文件数
var MAX_SANDBOX_PER_LINK = 30     // 每链接最多沙箱实测的疑似音源脚本数
var SANDBOX_BUDGET_MS = 8 * 60 * 1000  // 每链接沙箱总预算 8 分钟
var MAX_PRECHECKS_PER_ISSUE = 3   // 每 issue 最多预检次数（防反复编辑刷预检）

var FETCH_TIMEOUT = 10000   // 单次下载超时
var FETCH_RETRIES = 3       // 下载超时重试次数（Actions 出海访问国内源波动大，超时多为瞬时）

var lines = []
function say(s) { lines.push(s); console.log(s) }

function isAbortErr(e) {
  return e && (e.name === 'AbortError' || /abort/i.test(String(e.message || e)))
}

function fetchOnce(url) {
  return new Promise(function (resolve, reject) {
    var ctrl = new AbortController()
    var t = setTimeout(function () { ctrl.abort() }, FETCH_TIMEOUT)
    fetch(url, { headers: { 'User-Agent': 'lx-hunter-market' }, redirect: 'follow', signal: ctrl.signal }).then(function (res) {
      clearTimeout(t)
      if (!res.ok) { reject(new Error('HTTP ' + res.status)); return }
      res.text().then(resolve, function (e) { clearTimeout(t); reject(e) })
    }, function (e) { clearTimeout(t); reject(e) })
  })
}

// 只对超时重试（HTTP 404/403 等确定性失败重试无意义）；重试耗尽后报中文原因
function fetchText(url) {
  var lastErr = null
  function attempt(n) {
    return fetchOnce(url).catch(function (e) {
      if (!isAbortErr(e)) throw e
      lastErr = e
      if (n >= FETCH_RETRIES) throw new Error('下载超时（已重试 ' + FETCH_RETRIES + ' 次）')
      return new Promise(function (r) { setTimeout(r, 1000) }).then(function () { return attempt(n + 1) })
    })
  }
  return attempt(0)
}

// 沙箱子进程：环境变量剥空，只留 PATH/HOME；120s 硬顶击杀
function sandboxCheck(code) {
  return new Promise(function (resolve) {
    var dir = mkdtempSync(join(tmpdir(), 'mk-sandbox-'))
    var sf = join(dir, 'src.js')
    var of = join(dir, 'out.json')
    writeFileSync(sf, code)
    var child = spawn(process.execPath, [WORKER, sf, of], {
      env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '' },
      stdio: 'ignore'
    })
    var done = false
    function finish(r) {
      if (done) return
      done = true
      try { rmSync(dir, { recursive: true, force: true }) } catch (e) {}
      resolve(r)
    }
    var t = setTimeout(function () { child.kill('SIGKILL'); finish({ loadable: false, loadError: '沙箱硬超时' }) }, 120000)
    child.on('exit', function () {
      clearTimeout(t)
      try {
        var r = JSON.parse(readFileSync(of, 'utf8'))
        finish(r)
      } catch (e) { finish({ loadable: false, loadError: '无结果输出' }) }
    })
    child.on('error', function (e) { clearTimeout(t); finish({ loadable: false, loadError: 'worker 启动失败' }) })
  })
}

// 发布页（音源列表页）：抓 HTML 提取 .js 链接
function extractJsLinks(html, pageUrl) {
  return extractJsLinksFrom(html, pageUrl, MAX_FILES_PER_REPO)
}

// 直链：直接取内容；发布页：抓 HTML 提取 js 链接；
// 仓库：取 git tree 的 .js，没有则兜底扫 Releases 资产；Release 页/资产：走 Releases API 拿 .js 资产
// 返回 { scripts, via }：via 标记脚本来源（tree / releases / page / js），供报告与收录端区分
function collectScripts(link) {
  if (link.type === 'js') {
    return fetchText(link.url).then(function (code) { return { via: 'js', scripts: [{ url: link.url, path: link.url, code: code }] } })
  }
  if (link.type === 'page') {
    return fetchText(link.url).then(function (html) {
      var urls = extractJsLinks(html, link.url)
      if (!urls.length) throw new Error('发布页里没有提取到 .js 链接')
      return { via: 'page', scripts: urls.map(function (u) { return { url: u, path: u, code: null } }) }
    })
  }
  if (link.type === 'release') {
    return releaseAssets(link.repo, link.tag, token, MAX_FILES_PER_REPO).then(function (assets) {
      if (!assets.length) throw new Error(link.tag ? ('Release ' + link.tag + ' 里没有 .js 资产') : '该仓库的 Releases 里没有 .js 资产')
      return { via: 'releases', scripts: assets.map(function (a) { return { url: a.url, path: a.name, code: null } }) }
    })
  }
  return gh('/repos/' + link.repo + '/git/trees/HEAD?recursive=1', token).then(function (tree) {
    var items = (tree.tree || []).filter(function (it) {
      return it.type === 'blob' && /\.js$/i.test(it.path || '')
    }).slice(0, MAX_FILES_PER_REPO)
    if (items.length) {
      var rawBase = 'https://raw.githubusercontent.com/' + link.repo + '/HEAD/'
      return { via: 'tree', scripts: items.map(function (it) { return { url: rawBase + it.path.split('/').map(encodeURIComponent).join('/'), path: it.path, code: null } }) }
    }
    // 仓库里没有 .js：兜底扫 Releases 资产（脚本只挂在 Release 的仓库很常见）
    return releaseAssets(link.repo, '', token, MAX_FILES_PER_REPO).then(function (assets) {
      if (!assets.length) throw new Error('仓库和其 Releases 里都没有找到 .js 脚本')
      return { via: 'releases', scripts: assets.map(function (a) { return { url: a.url, path: a.name, code: null } }) }
    })
  })
}

var body
gh('/repos/' + repo + '/issues/' + num, token).then(function (issue) {
  // 防滥用：本 issue 已有的预检报告数达上限则不再跑
  return gh('/repos/' + repo + '/issues/' + num + '/comments?per_page=100', token).then(function (comments) {
    var mine = (comments || []).filter(function (c) {
      // 评论者可能是 Bot（GITHUB_TOKEN）也可能是维护者账号（PAT），一律按报告标记计数
      return String(c.body || '').indexOf('自动预检报告') !== -1
    })
    if (mine.length >= MAX_PRECHECKS_PER_ISSUE) {
      console.log('本 issue 已预检 ' + mine.length + ' 次，达到上限，跳过（如需重测请联系维护者删除旧报告）')
      process.exit(0)
    }
    body = parseForm(issue.body)
    if (!body.links.length) throw new Error('没有解析到任何链接，请检查「链接地址」一栏')
    if (!body.confirmAll) throw new Error('提交确认未全部勾选，请编辑 issue 补勾选')
    say('## 🤖 自动预检报告\n')
    say('解析到 **' + body.links.length + '** 个链接，确认勾选 ' + body.confirmChecked + '/' + body.confirmTotal + '。\n')
    var jobs = body.links.map(function (u) {
      var link = classifyLink(u)
      if (!link) return Promise.resolve({ url: u, type: 'invalid', ok: false, flags: [], jsTotal: 0, note: '不支持的链接类型（仅支持 .js 直链 / GitHub 仓库 / GitHub Releases / 音源发布页）' })
      return collectScripts(link).then(function (res) {
        var scripts = res.scripts
        var via = res.via
        var flags = []
        var jsTotal = 0, sourceCount = 0, sandboxed = 0, usableCount = 0, suspectCount = 0
        var usablePlats = []
        var sandboxBudgetEnd = Date.now() + SANDBOX_BUDGET_MS
        var sandboxSkipped = false
        var perScript = [] // 逐脚本结果（via=releases 时写入 MARKET-STATS，收录端展开为逐资产条目）
        var next = Promise.resolve()
        scripts.forEach(function (s) {
          var rec = { url: s.url, js: 1, source: 0, usable: 0, suspect: 0 }
          if (via === 'releases') perScript.push(rec)
          next = next.then(function () {
            var got = s.code != null ? Promise.resolve(s.code) : fetchText(s.url)
            return got.then(function (code) {
              jsTotal++
              var f = scanMalware(code)
              f.forEach(function (x) { if (flags.indexOf(x) === -1) flags.push(x) })
              if (!classifyEntry(s.path, code)) return // 非音源 JS：插件也不抓，不计入统计
              sourceCount++
              rec.source = 1
              if (f.length) { suspectCount++; rec.suspect = 1 }
              if (sandboxSkipped || Date.now() > sandboxBudgetEnd) { sandboxSkipped = true; return }
              if (sandboxed >= MAX_SANDBOX_PER_LINK) { sandboxSkipped = true; return }
              sandboxed++
              return sandboxCheck(code).then(function (r) {
                if (r && r.usablePlatforms && r.usablePlatforms.length) {
                  usableCount++
                  rec.usable = 1
                  if (usablePlats.indexOf(r.usablePlatforms.join('/')) === -1) usablePlats.push(r.usablePlatforms.join('/'))
                }
              })
            }).catch(function (e) {
              jsTotal++
              flags.push('脚本下载失败（' + String(e.message || e).slice(0, 60) + '）')
            })
          })
        })
        return next.then(function () {
          var viaNote = via === 'releases' ? '（脚本来自 Releases 资产' + (link.type === 'repo' ? '，仓库内无 .js' : '') + '）' : ''
          return {
            url: u, type: link.type, repo: link.repo || '', ok: flags.length === 0, flags: flags,
            jsTotal: jsTotal, sourceCount: sourceCount, sandboxed: sandboxed, usableCount: usableCount,
            suspectCount: suspectCount, usablePlats: usablePlats, via: via, assets: via === 'releases' ? perScript : null,
            note: '扫描 ' + jsTotal + ' 个脚本' + viaNote + (sandboxSkipped ? ' · 沙箱预算/数量用尽，部分音源未实测' : '')
          }
        })
      }).catch(function (e) {
        return { url: u, type: (link && link.type) || '?', ok: false, flags: [], jsTotal: 0, sourceCount: null, usableCount: 0, suspectCount: 0, note: String(e.message || e).slice(0, 120) }
      })
    })
    return Promise.all(jobs)
  })
}).then(function (results) {
  var totJs = 0, totSource = 0, totUsable = 0, totSuspect = 0
  results.forEach(function (r) {
    totJs += r.jsTotal || 0
    totSource += r.sourceCount || 0
    totUsable += r.usableCount || 0
    totSuspect += r.suspectCount || 0
  })
  say('### 📊 实测统计\n')
  say('- 音源脚本：**' + totSource + '** 个（共扫描 ' + totJs + ' 个 JS，非音源网页 JS 不计入）')
  say('- 沙箱实测可用（任意平台取链成功）：**' + totUsable + '** 个')
  say('- 疑似恶意特征：**' + totSuspect + '** 个\n')
  say('| 链接 | 类型 | 音源/可用 | 结果 | 说明 |')
  say('|---|---|---|---|---|')
  var allOk = true
  results.forEach(function (r) {
    var verdict
    if (r.type === 'invalid') { verdict = '❌'; allOk = false }
    else if (r.flags.length) { verdict = '⚠️ 可疑'; allOk = false }
    else if (r.jsTotal != null && r.jsTotal === 0) { verdict = '❌'; allOk = false }
    else verdict = '✅'
    var srcCol = r.sourceCount != null ? r.sourceCount + ' / ' + r.usableCount + (r.usablePlats && r.usablePlats.length ? '（' + r.usablePlats.join('; ') + '）' : '') : '—'
    say('| ' + r.url + ' | ' + ({ repo: '仓库', js: '直链', page: '发布页', release: 'Release' }[r.type] || r.type) + ' | ' + srcCol + ' | ' + verdict + ' | ' + (r.note || '') + (r.flags.length ? '；特征：' + r.flags.join('、') : '') + ' |')
  })
  say('')
  say('> 「可用」为**审核时快照**：Actions 网络环境与客户端不同，部分平台可能误判为不可用；音源后续更新内容会由插件端每次爬取时重新扫描与沙箱实测。')
  say('')
  if (allOk) {
    say('✅ **预检通过**：未发现恶意特征。等待维护者人工审核（通过后会打 `approved` 标签并收录）。')
  } else {
    say('⚠️ **预检发现异常**（见上表）。不必然是恶意——特征扫描是静态规则，存在误报；维护者会结合实际情况审核。')
  }
  // 机器可读统计标记：build.mjs 从评论中提取写进 community.json
  // links 为逐链接统计（build 按 URL 匹配给每条收录）；via=releases 的链接带 assets 逐资产结果，
  // 收录端把 Release 链接展开成逐资产 .js 直链条目（插件端按直链订阅，不认识 release 类型）
  say('\n<!--MARKET-STATS ' + JSON.stringify({
    jsTotal: totJs, source: totSource, usable: totUsable, suspect: totSuspect, at: new Date().toISOString(),
    links: results.map(function (r) {
      var l = { url: r.url, type: r.type, jsTotal: r.jsTotal || 0, source: r.sourceCount == null ? null : r.sourceCount, usable: r.usableCount || 0, suspect: r.suspectCount || 0 }
      if (r.via) l.via = r.via
      if (r.assets && r.assets.length) l.assets = r.assets
      return l
    })
  }) + '-->')
  return fetch('https://api.github.com/repos/' + repo + '/issues/' + num + '/comments', {
    method: 'POST',
    headers: { 'User-Agent': 'lx-hunter-market', 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + commentToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: lines.join('\n') })
  })
}).then(function (res) {
  if (!res.ok) throw new Error('评论发布失败 HTTP ' + res.status)
  console.log('预检报告已评论到 issue #' + num)
}).catch(function (e) {
  var msg = '## 🤖 自动预检\n\n❌ **预检未通过**：' + (e.message || e) + '\n\n请编辑本 issue 修正后预检会自动重跑（同一 issue 最多预检 3 次）。'
  fetch('https://api.github.com/repos/' + repo + '/issues/' + num + '/comments', {
    method: 'POST',
    headers: { 'User-Agent': 'lx-hunter-market', 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + commentToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: msg })
  }).then(function () { process.exit(0) }, function () { process.exit(1) })
  console.error('预检失败：' + (e.message || e))
})
