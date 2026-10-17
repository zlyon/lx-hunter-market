// issue 表单解析 + 链接归一 —— precheck.mjs 与 build.mjs 共用。
// 表单响应是 markdown：每题呈现为 "### 题目标题\n\n内容"。按标题切分提取。

// 从 issue body 提取表单字段（按 ### 标题匹配，忽略大小写与空白差异）
export function parseForm(body) {
  var out = { name: '', links: [], notes: '', confirmAll: false, confirmChecked: 0, confirmTotal: 0 }
  var text = String(body || '')
  var sections = text.split(/^###\s+/m)
  for (var i = 0; i < sections.length; i++) {
    var sec = sections[i]
    var nl = sec.indexOf('\n')
    if (nl < 0) continue
    var head = sec.slice(0, nl).trim()
    var val = sec.slice(nl + 1).trim()
    var h = head.replace(/\s+/g, '')
    if (val === '_No response_') val = '' // 表单可选项留空时 GitHub 的占位符
    if (h.indexOf('音源名称') === 0) {
      out.name = val.split('\n')[0].trim()
    } else if (h.indexOf('链接地址') === 0) {
      var lines = val.split('\n')
      for (var j = 0; j < lines.length; j++) {
        var line = lines[j].trim()
        if (!line || /^[-*<>|]/.test(line)) continue // 跳过空行/引用/表格残余
        var m = line.match(/https?:\/\/\S+/)
        if (m) out.links.push(m[0].replace(/[),.;!'"»]+$/, '')) // 剥掉误吸的 markdown 尾标点
        else {
          // 支持 owner/repo 简写
          var r = line.match(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
          if (r) out.links.push('https://github.com/' + r[0])
        }
      }
    } else if (h.indexOf('说明') === 0) {
      out.notes = val
    } else if (h.indexOf('提交确认') === 0) {
      var cks = val.match(/^\s*[-*]\s+\[x\]/gim)
      out.confirmChecked = cks ? cks.length : 0
      var all = val.match(/^\s*[-*]\s+\[(?:x| )\]/gim)
      out.confirmTotal = all ? all.length : 0
      out.confirmAll = out.confirmTotal > 0 && out.confirmChecked === out.confirmTotal
    }
  }
  return out
}

// 链接分类归一：GitHub 仓库 / .js 直链 / 音源发布页（挂着一堆 .js 的列表页）；不支持返回 null
export function classifyLink(url) {
  var u = String(url || '').trim()
  var m = u.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(?:tree|blob)\/[^/]+)?\/?$/i)
  if (m) return { type: 'repo', repo: m[1] + '/' + m[2].replace(/\.git$/i, ''), url: u }
  if (/^https?:\/\/.+/i.test(u) && /\.js(\?|#|$)/i.test(u)) return { type: 'js', url: u }
  if (/^https?:\/\//i.test(u)) return { type: 'page', url: u }
  return null
}

// GitHub API 请求（零依赖，Node 22 全局 fetch）
export function gh(path, token, accept) {
  return fetch('https://api.github.com' + path, {
    headers: {
      'User-Agent': 'lx-hunter-market',
      'Accept': accept || 'application/vnd.github+json',
      'Authorization': 'Bearer ' + token
    }
  }).then(function (res) {
    if (!res.ok) throw new Error('GitHub API ' + res.status + ': ' + path)
    return res.json()
  })
}
