// 疑似音源识别 + 脚本元信息提取 —— 与 lx-hunter 插件 main.js 同款规则，两端保持同步。
export function classifyEntry(path, content) {
  var fname = String(path || '').split('/').pop() || ''
  var score = 0
  if (/音源|源|source|lx-source/i.test(fname)) score += 2
  if (/^(lx|src|source)[-_ .]/i.test(fname)) score += 1
  if (content) {
    if (/globalThis\.lx\b|globalThis\[.lx.\]/.test(content)) score += 3
    if (/EVENT_NAMES/.test(content)) score += 2
    if (/lx\.on\s*\(|LX\.on\s*\(/.test(content)) score += 2
    if (/musicSources|musicUrl/.test(content)) score += 2
    if (/@name\s|@description\s/.test(content)) score += 1
    if (/on\(\s*['"]request['"]/.test(content)) score += 2
  }
  return score >= 5
}

export function extractMeta(code) {
  var meta = { name: '', description: '', version: '', author: '', homepage: '' }
  var block = String(code || '').match(/\/\*[!*][\s\S]*?\*\//)
  if (!block) return meta
  var pairs = { name: /@name\s+(.+)/, version: /@version\s+(.+)/, description: /@description\s+(.+)/, author: /@author\s+(.+)/, homepage: /@homepage\s+(.+)/ }
  for (var k in pairs) {
    var m = block[0].match(pairs[k])
    if (m && m[1]) meta[k] = m[1].trim()
  }
  return meta
}
