// 构建社区精选：收集带 approved 标签的开放 issue → data/community.json + dist/（Pages 站点）。
// 由 build.yml 触发（定时/手动/push），需 env：GH_TOKEN、GITHUB_REPOSITORY。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs'
import { parseForm, classifyLink, releaseAssets, gh } from './form.mjs'

var token = process.env.GH_TOKEN
var repo = process.env.GITHUB_REPOSITORY
if (!token || !repo) { console.error('缺少 GH_TOKEN / GITHUB_REPOSITORY'); process.exit(1) }

var DATA_FILE = 'data/community.json'
var old = { schema: 1, updatedAt: '', count: 0, sources: [] }
if (existsSync(DATA_FILE)) {
  try { old = JSON.parse(readFileSync(DATA_FILE, 'utf8')) } catch (e) { /* 损坏则重建 */ }
}
// 以链接为键保留首次审核时间
var prevByKey = {}
;(old.sources || []).forEach(function (s) { prevByKey[s.url] = s })

function listApproved(page, acc) {
  return gh('/repos/' + repo + '/issues?labels=approved&state=open&per_page=100&page=' + page, token).then(function (list) {
    if (!Array.isArray(list) || !list.length) return acc
    acc = acc.concat(list)
    if (list.length < 100) return acc
    return listApproved(page + 1, acc)
  })
}

// 从 issue 评论里取最新的 MARKET-STATS 标记（预检机器可读统计）
function issueStats(num) {
  return gh('/repos/' + repo + '/issues/' + num + '/comments?per_page=100', token).then(function (comments) {
    var stats = null
    ;(comments || []).forEach(function (c) {
      var body = String(c.body || '')
      var re = /<!--MARKET-STATS\s+(\{.*?\})\s*-->/g
      var m
      while ((m = re.exec(body))) {
        try { stats = JSON.parse(m[1]) } catch (e) { /* 忽略坏块 */ }
      }
    })
    return stats
  }).catch(function () { return null })
}

listApproved(1, []).then(function (issues) {
  // 逐链接统计：MARKET-STATS 带 links 数组时按 URL 精确匹配，避免整条 issue 的汇总被套到每个链接上
  function statsFor(sUrl, agg) {
    if (!agg) return null
    if (!Array.isArray(agg.links)) return agg // 旧格式（仅汇总）
    for (var i = 0; i < agg.links.length; i++) {
      if (agg.links[i].url === sUrl) {
        var l = agg.links[i]
        var out = { usable: l.usable || 0, source: l.source == null ? null : l.source, jsTotal: l.jsTotal || 0, at: agg.at }
        if (l.via) out.via = l.via
        if (l.assets) out.assets = l.assets
        return out
      }
    }
    return null // 新格式但没这条链接（如预检失败的链接）：不显示统计
  }
  var sources = []
  var seen = {}
  // 单条收录（原逻辑）
  function pushOne(issue, form, link, matched) {
    var key = link.url
    if (seen[key]) return
    seen[key] = true
    var prev = prevByKey[key]
    sources.push({
      name: form.name || issue.title.replace(/^\[音源收录\]\s*/, '') || key,
      url: link.url,
      repo: link.repo || '',
      type: link.type,
      notes: (form.notes || '').slice(0, 200),
      submitter: issue.user ? issue.user.login : '',
      issue: issue.number,
      approvedAt: (prev && prev.approvedAt) || issue.updated_at || new Date().toISOString(),
      stats: matched || (prev && prev.stats) || null
    })
  }
  // 单个 Release 资产 → 一条 .js 直链条目（插件端只认 repo/js/page，存 release 页 URL 插件取不到脚本）
  function assetName(a) {
    return String(a.name || decodeURIComponent(String(a.url).split('/').pop().split('?')[0])).replace(/\.js$/i, '')
  }
  function pushAsset(issue, form, link, a, matched, multi) {
    if (seen[a.url]) return
    seen[a.url] = true
    var base = assetName(a)
    var mStats = null
    if (matched && Array.isArray(matched.assets)) {
      for (var i = 0; i < matched.assets.length; i++) {
        if (matched.assets[i].url === a.url) {
          mStats = { usable: matched.assets[i].usable || 0, source: matched.assets[i].source, jsTotal: matched.assets[i].js || 1, at: matched.at }
          break
        }
      }
    }
    var prev = prevByKey[a.url]
    sources.push({
      name: ((form.name || issue.title.replace(/^\[音源收录\]\s*/, '') || base) + (multi ? ' · ' + base : '')),
      url: a.url,
      repo: link.repo || '',
      type: 'js',
      notes: (form.notes || '').slice(0, 200),
      submitter: issue.user ? issue.user.login : '',
      issue: issue.number,
      approvedAt: (prev && prev.approvedAt) || issue.updated_at || new Date().toISOString(),
      stats: mStats || (prev && prev.stats) || null
    })
  }
  // 逐链接处理：Release 链接 / 脚本来自 Release 资产的仓库链接 → 展开为逐资产条目；其余原样单条
  function handleLink(issue, form, u, stats) {
    var link = classifyLink(u)
    if (!link) return Promise.resolve()
    // 预检没测出音源脚本的链接（仓库/Release 里没有 .js / 扫描失败）直接抛弃，不入库不展示
    var matched = statsFor(link.url, stats)
    if (matched && (matched.source == null || (matched.source === 0 && matched.jsTotal === 0))) {
      console.log('跳过（无音源脚本）: ' + link.url)
      return Promise.resolve()
    }
    var expand = link.type === 'release' || (link.type === 'repo' && matched && matched.via === 'releases')
    if (expand) {
      // 资产清单优先取预检统计里带的逐资产结果；预检缺失（旧 issue）时回退现查 Releases API
      var fromStats = ((matched && matched.assets) || []).filter(function (a) { return a && a.url && a.source === 1 })
      var listP = fromStats.length
        ? Promise.resolve(fromStats.map(function (a) { return { url: a.url, name: assetName(a) } }))
        : releaseAssets(link.repo, link.tag || '', token, 100)
      return listP.then(function (assets) {
        if (!assets.length) { console.log('跳过（Release 里没有 .js 资产）: ' + link.url); return }
        assets.forEach(function (a) { pushAsset(issue, form, link, a, matched, assets.length > 1) })
      }).catch(function (e) { console.log('Release 解析失败 ' + link.url + ': ' + (e.message || e)) })
    }
    pushOne(issue, form, link, matched)
    return Promise.resolve()
  }
  var next = Promise.resolve()
  issues.forEach(function (issue) {
    next = next.then(function () {
      return issueStats(issue.number).then(function (stats) {
        var form = parseForm(issue.body)
        if (!form.links.length) return
        var chain = Promise.resolve()
        form.links.forEach(function (u) {
          chain = chain.then(function () { return handleLink(issue, form, u, stats) })
        })
        return chain
      })
    })
  })
  return next.then(function () {
    // 重名消解：一条投稿带多个链接时标题相同（如「其他音源仓库」×8），改用 URL 派生标识
    function refLabel(s) {
      if (s.repo) return s.repo
      try {
        var u = new URL(s.url)
        var segs = u.pathname.split('/').filter(Boolean)
        var last = segs[segs.length - 1] || ''
        if (/\.js$/i.test(last)) return last.replace(/\.js$/i, '')
        return u.host + (u.pathname !== '/' ? u.pathname.slice(0, 30) : '')
      } catch (e) { return s.url.slice(0, 40) }
    }
    var nameCount = {}
    sources.forEach(function (s) { nameCount[s.name] = (nameCount[s.name] || 0) + 1 })
    sources.forEach(function (s) { if (nameCount[s.name] > 1) s.name = refLabel(s) })
    sources.sort(function (a, b) { return a.approvedAt < b.approvedAt ? -1 : 1 })
    // 收录内容无实质变化时沿用旧 updatedAt：避免每次构建都产生空提交、也消除并发构建的提交竞争
    var stamp = JSON.stringify(old.sources || []) === JSON.stringify(sources) && old.updatedAt ? old.updatedAt : new Date().toISOString()
    var out = { schema: 1, updatedAt: stamp, count: sources.length, sources: sources }
    mkdirSync('data', { recursive: true })
    writeFileSync(DATA_FILE, JSON.stringify(out, null, 2) + '\n')

    // Pages 站点产物：site/* + community.json 放同级，前端相对路径取
    // 注意：本机 Node 22.22.2 的 cpSync 在含中文的路径下会静默硬崩（exit 127），改用手动递归复制
    function copyDir(src, dest) {
      mkdirSync(dest, { recursive: true })
      readdirSync(src, { withFileTypes: true }).forEach(function (ent) {
        var s = src + '/' + ent.name, d = dest + '/' + ent.name
        if (ent.isDirectory()) copyDir(s, d)
        else copyFileSync(s, d)
      })
    }
    copyDir('site', 'dist')
    // 资源缓存击穿：把 dist/index.html 里的 BUILD 占位替换为构建时间戳（保留 ?v= 前缀）
    var idxHtml = readFileSync('dist/index.html', 'utf8').replace(/BUILD/g, String(Date.now()))
    if (!/\?v=\d{13}/.test(idxHtml)) throw new Error('资源缓存参数替换失败，index.html 引用异常')
    writeFileSync('dist/index.html', idxHtml)
    writeFileSync('dist/community.json', JSON.stringify(out))
    console.log('构建完成：' + sources.length + ' 个收录（来自 ' + issues.length + ' 个 approved issue）')
  })
}).catch(function (e) {
  console.error('构建失败：' + (e.message || e))
  process.exit(1)
})
