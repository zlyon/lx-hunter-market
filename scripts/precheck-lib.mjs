// 预检公共工具（独立模块：selftest 可安全导入，precheck.mjs 导入即执行主流程）
// 发布页（音源列表页）：从 HTML 提取 .js 链接（src/href 相对路径按页面归一 + 正文绝对 URL），与插件端同思路
export function extractJsLinks(html, pageUrl, cap) {
  var out = []
  var seen = {}
  function push(u) {
    try {
      if (/^\/\//.test(u)) u = 'https:' + u
      var abs = new URL(u, pageUrl).href
      if (!/^https?:/i.test(abs) || seen[abs]) return
      seen[abs] = true
      out.push(abs)
    } catch (e) { /* 非法 URL 忽略 */ }
  }
  var re = /(?:src|href)\s*=\s*["']([^"']+\.js(?:\?[^"']*)?)["']/gi
  var m
  while ((m = re.exec(html))) push(m[1])
  var re2 = /https?:\/\/[^\s"'<>()]+\.js(?:\?[^\s"'<>()]*)?/gi
  while ((m = re2.exec(html))) push(m[0])
  return out.slice(0, cap || 100)
}
