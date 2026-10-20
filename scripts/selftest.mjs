// 本地自测：表单解析 + 链接分类 + 恶意扫描（无需网络）。跑：node scripts/selftest.mjs
import { scanMalware } from './scan-malware.mjs'
import { classifyEntry, extractMeta } from './source-rules.mjs'
import { parseForm, classifyLink, gh } from './form.mjs'
import { extractJsLinks } from './precheck-lib.mjs'
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import assert from 'node:assert'

// ---- 表单解析 ----
var body = [
  '### 提交前请确认',
  '',
  '### 音源名称',
  '',
  '星海音乐源 v2.3.11',
  '',
  '### 链接地址',
  '',
  'https://github.com/user/lx-sources',
  'https://example.com/star-sea.js',
  'user2/repo-two',
  '',
  '### 说明（可选）',
  '',
  '支持网易/QQ',
  '',
  '### 提交确认',
  '',
  '- [X] 我有权分享该音源，链接可公开访问',
  '- [x] 该音源不含恶意代码（窃取 Cookie / 设备信息 / 剪贴板等）',
  '- [ ] 我了解收录后任何人都可通过插件订阅到该链接'
].join('\n')

var f = parseForm(body)
assert.equal(f.name, '星海音乐源 v2.3.11', '名称解析')
assert.deepEqual(f.links, [
  'https://github.com/user/lx-sources',
  'https://example.com/star-sea.js',
  'https://github.com/user2/repo-two'
], '链接解析（含 owner/repo 简写）')
assert.equal(f.confirmChecked, 2, '勾选计数')
assert.equal(f.confirmAll, false, '未全勾判定')

var f2 = parseForm(body.replace('- [ ] 我了解', '- [x] 我了解'))
assert.equal(f2.confirmAll, true, '全勾判定')
assert.equal(parseForm('### 说明\n\n_No response_').notes, '', '说明留空占位符清空')
assert.equal(parseForm('### 链接地址\n\n[名.js](https://github.com/user-attachments/files/1/a.js)').links[0], 'https://github.com/user-attachments/files/1/a.js', 'markdown 附件链接剥尾括号')
assert.equal(classifyLink('https://github.com/user-attachments/files/12345/my-source.js').type, 'js', '拖入的 .js 附件 URL')
console.log('表单解析 ok')

// ---- 链接分类 ----
assert.deepEqual(classifyLink('https://github.com/a/b'), { type: 'repo', repo: 'a/b', url: 'https://github.com/a/b' })
assert.equal(classifyLink('https://github.com/a/b/tree/main').repo, 'a/b', 'tree 链接归一')
assert.equal(classifyLink('https://x.com/s.js?type=1').type, 'js', '带参数直链')
assert.equal(classifyLink('https://x.com/vers.php').type, 'page', '发布页类型')
assert.equal(classifyLink('ftp://x.com/s.js'), null, '不支持的协议')
// Releases 链接归一
assert.deepEqual(classifyLink('https://github.com/a/b/releases'), { type: 'release', repo: 'a/b', tag: '', url: 'https://github.com/a/b/releases' }, 'releases 列表页')
assert.deepEqual(classifyLink('https://github.com/a/b/releases/latest'), { type: 'release', repo: 'a/b', tag: '', url: 'https://github.com/a/b/releases/latest' }, 'latest')
assert.deepEqual(classifyLink('https://github.com/a/b/releases/tag/v1.2.0/'), { type: 'release', repo: 'a/b', tag: 'v1.2.0', url: 'https://github.com/a/b/releases/tag/v1.2.0/' }, 'tag 页')
assert.equal(classifyLink('https://github.com/a/b/releases/download/v1.2.0/lx-source.js').type, 'js', '资产 .js 直链')
assert.deepEqual(classifyLink('https://github.com/a/b/releases/download/v1.2.0/pack.zip'), { type: 'release', repo: 'a/b', tag: 'v1.2.0', url: 'https://github.com/a/b/releases/download/v1.2.0/pack.zip' }, '资产非 .js 按 Release 处理')
console.log('链接分类 ok（含 Releases 归一）')

// ---- 发布页 js 链接提取 ----
var pageHtml = [
  '<html><body>',
  '<a href="/files/star.js">星海</a>',
  '<script src="https://cdn.example.com/abs.js?v=2"></script>',
  '<a href="//mirror.example.org/rel.js">协议相对</a>',
  '<a href="mailto:x@y.com">不是链接</a>',
  '正文裸链接 https://else.example.net/naked.js?ver=1 结束',
  '</body></html>'
].join('\n')
var js = extractJsLinks(pageHtml, 'https://pub.example.com/vers.php?a=1')
assert.ok(js.indexOf('https://pub.example.com/files/star.js') !== -1, '相对路径按页面归一')
assert.ok(js.indexOf('https://cdn.example.com/abs.js?v=2') !== -1, '绝对 src 提取')
assert.ok(js.indexOf('https://mirror.example.org/rel.js') !== -1, '协议相对归一')
assert.ok(js.indexOf('https://else.example.net/naked.js?ver=1') !== -1, '正文裸链接提取')
assert.ok(js.every(function (u) { return u.indexOf('mailto:') === -1 }), '非 http 丢弃')
console.log('发布页提取 ok（' + js.length + ' 个链接）')

// ---- 恶意扫描 ----
var clean = "var music = { platforms: { wy: { get: function(b){ return fetch('https://api.x.com/?id=' + b) } } } }"
assert.deepEqual(scanMalware(clean), [], '干净脚本不误报')
assert.ok(scanMalware('eval(atob("YWJj"))').length > 0, '解码执行')
assert.ok(scanMalware('var c = document.cookie;').length > 0, '读 Cookie')
assert.ok(scanMalware('var id = hwid;').length > 0, '设备标识')
assert.ok(scanMalware('x'.repeat(400)).length === 0, '普通长文本不误报 Base64')
assert.ok(scanMalware('localStorage.getItem("k")').length > 0, '读本地存储')
console.log('恶意扫描 ok')

// ---- 疑似音源判定 ----
var srcCode = "lx.on(lx.EVENT_NAMES.request, function (h) { return 'http://x/' + h.info.musicInfo.songmid + '.mp3' })"
assert.equal(classifyEntry('lx-source.js', srcCode), true, '音源判定-命中')
assert.equal(classifyEntry('utils.js', 'var a = 1'), false, '音源判定-排除网页 JS')
assert.equal(extractMeta('/*!\n * @name 测试源\n * @version 1.0.0\n */\nvar a=1').name, '测试源', 'meta 提取')
console.log('疑似音源判定 ok')

// ---- 沙箱端到端（本地 HTTP 服假音频 + MK_ALLOW_PRIVATE 放行私有地址）----
function sandboxSelftest() {
  return new Promise(function (resolve, reject) {
    var body = Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4, 5, 6, 7, 8])
    var server = http.createServer(function (req, res) {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
      res.end(body)
    })
    server.listen(0, '127.0.0.1', function () {
      var port = server.address().port
      var fake = [
        "lx.on(lx.EVENT_NAMES.request, function (h) {",
        "  if (h.source !== 'wy') throw new Error('不支持该平台')",
        "  return 'http://127.0.0.1:" + port + "/test.mp3'",
        "})",
        "lx.send(lx.EVENT_NAMES.inited, { status: true, sources: { wy: { name: '自测源', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } })"
      ].join('\n')
      var dir = mkdtempSync(join(tmpdir(), 'mk-selftest-'))
      var sf = join(dir, 'src.js')
      var of = join(dir, 'out.json')
      writeFileSync(sf, fake)
      var worker = join(dirname(fileURLToPath(import.meta.url)), 'lx-sandbox.mjs')
      var child = spawn(process.execPath, [worker, sf, of], {
        env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', MK_ALLOW_PRIVATE: '1' },
        stdio: 'ignore'
      })
      var t = setTimeout(function () { child.kill('SIGKILL'); server.close(); reject(new Error('沙箱自测超时')) }, 60000)
      child.on('exit', function () {
        clearTimeout(t)
        try {
          var r = JSON.parse(readFileSync(of, 'utf8'))
          assert.equal(r.loadable, true, '脚本可加载')
          assert.equal(r.sourceCount, 1, '注册音源数')
          assert.equal(r.platforms.wy.status, 'usable', 'wy 平台实测可用')
          assert.equal(r.platforms.tx.status, 'failed', '未支持平台判失败')
          server.close()
          rmSync(dir, { recursive: true, force: true })
          console.log('沙箱端到端 ok（wy 可用 / tx 失败 / 音源计数 1）')
          resolve()
        } catch (e) { server.close(); reject(e) }
      })
      child.on('error', function (e) { clearTimeout(t); server.close(); reject(e) })
    })
  })
}

sandboxSelftest().then(function () {
  console.log('✅ selftest 全部通过')
}).catch(function (e) {
  console.error('❌ selftest 失败：' + (e.message || e))
  process.exit(1)
})
