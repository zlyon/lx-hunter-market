// 构建社区精选：收集带 approved 标签的开放 issue → data/community.json + dist/（Pages 站点）。
// 由 build.yml 触发（定时/手动/push），需 env：GH_TOKEN、GITHUB_REPOSITORY。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs'
import { parseForm, classifyLink, gh } from './form.mjs'

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
        return { usable: l.usable || 0, source: l.source == null ? null : l.source, jsTotal: l.jsTotal || 0, at: agg.at }
      }
    }
    return null // 新格式但没这条链接（如预检失败的链接）：不显示统计
  }
  var sources = []
  var seen = {}
  var next = Promise.resolve()
  issues.forEach(function (issue) {
    next = next.then(function () {
      return issueStats(issue.number).then(function (stats) {
        var form = parseForm(issue.body)
        if (!form.links.length) return
        form.links.forEach(function (u) {
          var link = classifyLink(u)
          if (!link) return
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
            stats: statsFor(link.url, stats) || (prev && prev.stats) || null
          })
        })
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
    var out = { schema: 1, updatedAt: new Date().toISOString(), count: sources.length, sources: sources }
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
    writeFileSync('dist/community.json', JSON.stringify(out))
    console.log('构建完成：' + sources.length + ' 个收录（来自 ' + issues.length + ' 个 approved issue）')
  })
}).catch(function (e) {
  console.error('构建失败：' + (e.message || e))
  process.exit(1)
})
