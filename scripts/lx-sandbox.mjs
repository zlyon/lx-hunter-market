// 沙箱 worker：单独进程跑待测音源脚本（零凭据——父进程 spawn 时环境变量已剥空）。
// Node vm 不是安全边界，安全前提就是本进程内无任何机密，最坏情况只是浪费一台一次性 runner。
// 用法：node lx-sandbox.mjs <脚本文件> <结果输出文件>
// 结果 JSON：{ loadable, inited, sourceCount, platforms:{wy:{status,message}...}, usablePlatforms:[], loadError }
import { readFileSync, writeFileSync } from 'node:fs'
import vm from 'node:vm'
import nodeCrypto from 'node:crypto'
import nodeZlib from 'node:zlib'

var scriptPath = process.argv[2]
var outPath = process.argv[3]
var ALLOW_PRIVATE = process.env.MK_ALLOW_PRIVATE === '1' // 仅本地自测用：允许私有地址通过音频校验

var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
var PLATFORMS = ['wy', 'tx', 'kw', 'kg', 'mg']
var TEST_SONGS = {
  wy: [{ name: '海阔天空', info: { songmid: '347230' } }],
  tx: [{ name: '晴天', info: { songmid: '0039MnYb0qxYhV' } }],
  kw: [{ name: '晴天', info: { songmid: '838607' } }],
  kg: [{ name: '晴天', info: { hash: '30ece05c17d4e9ec8ba0ef9f96e7a07c' } }],
  mg: [{ name: '晴天', info: { copyrightId: '69984639', songmid: '69984639' } }]
}

function result(res) {
  writeFileSync(outPath, JSON.stringify(res))
  process.exit(0)
}
// 进程级硬顶：2 分钟
setTimeout(function () { result({ loadable: false, loadError: 'worker 总超时' }) }, 120000).unref()

function fail(msg) { result({ loadable: false, loadError: msg }) }

// ---------- 音频链接校验（与插件 verifyUrl 同款：私有地址拒绝 + Range 拉头 + 魔数/content-type） ----------
function looksAudio(headAscii, b0, b1) {
  if (headAscii.slice(0, 3) === 'ID3') return true
  if (b0 === 0xff && (b1 & 0xe0) === 0xe0) return true
  var four = headAscii.slice(0, 4)
  if (four === 'fLaC' || four === 'OggS' || four === 'RIFF') return true
  if (headAscii.slice(4, 8) === 'ftyp') return true
  return false
}

function verifyUrl(url) {
  return new Promise(function (resolve) {
    var u
    try { u = new URL(url) } catch (e) { resolve({ ok: false, reason: '无效 URL' }); return }
    var host = (u.hostname || '').toLowerCase()
    if (!ALLOW_PRIVATE && (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host))) {
      resolve({ ok: false, reason: '私有/本地地址，疑似假链接' }); return
    }
    var ctrl = new AbortController()
    var t = setTimeout(function () { ctrl.abort() }, 6000)
    fetch(url, { headers: { Range: 'bytes=0-16383', 'User-Agent': UA }, signal: ctrl.signal }).then(function (res) {
      var ct = ''
      try { ct = res.headers.get('content-type') || '' } catch (e) {}
      if (/json|text\/html|text\/plain/i.test(ct)) { clearTimeout(t); resolve({ ok: false, reason: '返回 ' + ct + '，非音频' }); return }
      if (!res.ok && res.status !== 206) { clearTimeout(t); resolve({ ok: false, reason: 'HTTP ' + res.status }); return }
      return res.arrayBuffer().then(function (ab) {
        clearTimeout(t)
        var bytes = new Uint8Array(ab)
        var ascii = ''
        for (var i = 0; i < Math.min(bytes.length, 16); i++) ascii += String.fromCharCode(bytes[i])
        var ok = looksAudio(ascii, bytes[0], bytes[1]) || /audio|octet-stream/i.test(ct)
        resolve(ok ? { ok: true } : { ok: false, reason: '非音频内容 (' + (ct || '未知') + ')' })
      })
    }).catch(function (e) {
      clearTimeout(t)
      resolve({ ok: false, reason: String(e && e.message || e).slice(0, 80) })
    })
  })
}

// ---------- 沙箱环境（与插件 BOOTSTRAP 同款语义；__go_send 换成本地事件队列） ----------
var code = readFileSync(scriptPath, 'utf8')
var events = []
var silentConsole = { log: function () {}, warn: function () {}, error: function () {}, info: function () {}, debug: function () {} }

function toBuf(b) { return Buffer.isBuffer(b) ? b : Buffer.from(String(b), 'utf8') }
var sandbox = {
  Buffer: Buffer,
  fetch: fetch,
  console: silentConsole,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  crypto: {
    md5: function (s) { return nodeCrypto.createHash('md5').update(toBuf(s)).digest('hex') },
    aesEncrypt: function (data, mode, key, iv) {
      var algo = String(mode || 'aes-128-cbc').toLowerCase()
      try {
        var c = nodeCrypto.createCipheriv(algo, toBuf(key), iv != null ? toBuf(iv) : Buffer.alloc(16))
        return Buffer.concat([c.update(toBuf(data)), c.final()]).toString('base64')
      } catch (e) { return '' }
    },
    rsaEncrypt: function (data, key) {
      try { return nodeCrypto.publicEncrypt({ key: String(key), padding: nodeCrypto.constants.RSA_PKCS1_PADDING }, toBuf(data)).toString('base64') } catch (e) { return '' }
    },
    randomBytes: function (n) { return nodeCrypto.randomBytes(n || 16) }
  },
  zlib: {
    inflate: function (b) { try { return nodeZlib.inflateSync(toBuf(b)) } catch (e) { return Buffer.alloc(0) } },
    gunzip: function (b) { try { return nodeZlib.gunzipSync(toBuf(b)) } catch (e) { return Buffer.alloc(0) } },
    deflate: function (b) { try { return nodeZlib.deflateSync(toBuf(b)) } catch (e) { return Buffer.alloc(0) } },
    gzip: function (b) { try { return nodeZlib.gzipSync(toBuf(b)) } catch (e) { return Buffer.alloc(0) } }
  },
  __go_send: function (name, data) { events.push({ name: name, data: data }) }
}
var ctx = vm.createContext(sandbox)

var BOOTSTRAP = [
  "'use strict';",
  'var _eventHandlers = new Map();',
  'var _registeredSources = {};',
  'globalThis.lx = {',
  "  version: '2.0.0', env: 'desktop', platform: 'web',",
  '  currentScriptInfo: { name: "", description: "", version: "", author: "", homepage: "", rawScript: "" },',
  '  EVENT_NAMES: { request: "request", inited: "inited", updateAlert: "updateAlert" },',
  '  utils: {',
  '    buffer: {',
  '      from: function(d, e) { return Buffer.from(d, e); },',
  '      bufToString: function(b, f) { return (b !== null && typeof b === "object" && typeof b.toString === "function") ? b.toString(f || "utf8") : Buffer.from(b, "binary").toString(f || "utf8"); }',
  '    },',
  '    crypto: {',
  "      md5: function(s) { return crypto.md5(s || ''); },",
  '      aesEncrypt: function(b, m, k, iv) { return crypto.aesEncrypt(b, m, k, iv); },',
  '      rsaEncrypt: function(b, k) { return crypto.rsaEncrypt(b, k); },',
  '      randomBytes: function(n) { return crypto.randomBytes(n); }',
  '    },',
  '    zlib: {',
  '      inflate: function(b) { return zlib.inflate(b); },',
  '      deflate: function(b) { return zlib.deflate(b); }',
  '    }',
  '  },',
  '  request: function(url, options, callback) {',
  '    if (typeof options === "function") { callback = options; options = {}; }',
  '    options = options || {};',
  '    var method = (options.method || "GET").toUpperCase();',
  '    var headers = options.headers || {};',
  '    var bodyContent = options.body || null;',
  '    if (options.form) {',
  '      bodyContent = options.form;',
  '      if (typeof bodyContent === "object") {',
  '        var parts = [];',
  '        for (var k in bodyContent) parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(bodyContent[k]));',
  '        bodyContent = parts.join("&");',
  '        if (!headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/x-www-form-urlencoded";',
  '      }',
  '    }',
  '    if (bodyContent !== null && typeof bodyContent === "object") {',
  '      bodyContent = JSON.stringify(bodyContent);',
  '      if (!headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/json";',
  '    }',
  '    var aborted = false, called = false;',
  '    function safe(err, resp, body) {',
  '      if (aborted || called) return; called = true;',
  '      if (typeof callback === "function") { try { callback(err, resp, body); } catch (e) {} }',
  '    }',
  '    fetch(url, { method: method, headers: headers, body: bodyContent }).then(function(resp) {',
  '      if (aborted) return;',
  '      return resp.text().then(function(text) {',
  '        if (aborted) return;',
  '        var body = text; try { body = JSON.parse(text); } catch (_) {}',
  '        safe(null, { statusCode: resp.status, statusMessage: resp.statusText || "", headers: resp.headers || {}, body: body }, body);',
  '      });',
  '    }).catch(function(err) {',
  '      if (aborted) return;',
  '      safe(new Error((err && err.message) ? err.message : String(err)), null, null);',
  '    });',
  '    return function() { aborted = true; };',
  '  },',
  '  send: function(eventName, data) {',
  '    if (eventName === "inited" && data && data.sources) _registeredSources = data.sources;',
  '    if (typeof __go_send === "function") { try { __go_send(eventName, JSON.stringify(data)); } catch (e) {} }',
  '  },',
  '  on: function(eventName, handler) { _eventHandlers.set(eventName, handler); },',
  '  _dispatch: function(requestId, eventName, data) {',
  '    var handler = _eventHandlers.get(eventName);',
  '    if (typeof handler !== "function") {',
  '      if (typeof __go_send === "function") __go_send("dispatchError", JSON.stringify({ id: requestId, error: "No handler registered for event: " + eventName }));',
  '      return;',
  '    }',
  '    var settled = false;',
  '    function sendResult(v) { if (settled) return; settled = true; if (typeof __go_send === "function") __go_send("dispatchResult", JSON.stringify({ id: requestId, result: v })); }',
  '    function sendError(e) { if (settled) return; settled = true; if (typeof __go_send === "function") __go_send("dispatchError", JSON.stringify({ id: requestId, error: (e && e.message) ? e.message : String(e) })); }',
  '    try {',
  '      var result = handler(data);',
  '      if (result && typeof result.then === "function") {',
  '        var t = setTimeout(function() { sendError(new Error("dispatch timeout")); }, 6000);',
  '        result.then(function(v) { clearTimeout(t); sendResult(v); }, function(e) { clearTimeout(t); sendError(e); });',
  '      } else sendResult(result);',
  '    } catch (err) { sendError(err); }',
  '  },',
  '  _getSources: function() { return _registeredSources; }',
  '};',
  'globalThis.window = globalThis;',
  'globalThis.global = globalThis;'
].join('\n')

try { vm.runInContext(BOOTSTRAP, ctx, { timeout: 5000 }) } catch (e) { fail('沙箱引导失败: ' + String(e && e.message || e)) }

// 注入 scriptInfo 后执行脚本
try { vm.runInContext('globalThis.lx.currentScriptInfo = ' + JSON.stringify({ name: '', description: '', version: '', author: '', homepage: '', rawScript: code }) + ';', ctx, { timeout: 5000 }) } catch (e) {}
try { vm.runInContext(code, ctx, { timeout: 10000 }) } catch (e) { fail('脚本初始化异常: ' + String(e && e.message || e).slice(0, 160)) }

// 等待 inited（脚本同步/异步注册）
var waited = 0
function waitInited() {
  var sources = vm.runInContext('globalThis.lx._getSources()', ctx)
  if (sources && typeof sources === 'object' && Object.keys(sources).length) return sources
  if (waited >= 10000) return null
  waited += 200
  return new Promise(function (r) { setTimeout(r, 200) }).then(waitInited)
}

Promise.resolve(waitInited()).then(function (sources) {
  if (!sources) fail("脚本未调用 lx.send('inited', …)")
  var sourceCount = Object.keys(sources).length
  var platforms = {}
  var usablePlatforms = []
  var queue = PLATFORMS.slice()
  var started = Date.now()
  function waitEvent(reqId) {
    return new Promise(function (resolve) {
      var n = 0
      function poll() {
        for (var i = 0; i < events.length; i++) {
          var ev = events[i]
          if (ev.name !== 'dispatchResult' && ev.name !== 'dispatchError') continue
          var d
          try { d = JSON.parse(ev.data) } catch (e) { continue }
          if (d.id !== reqId) continue
          events.splice(0, i + 1)
          return resolve({ name: ev.name, data: d })
        }
        if (n >= 8000) return resolve(null)
        n += 150
        setTimeout(poll, 150)
      }
      poll()
    })
  }
  function next() {
    if (!queue.length) return Promise.resolve()
    // 单脚本预算 90s：超了剩下的平台标 skipped
    if (Date.now() - started > 90000) {
      queue.forEach(function (p) { platforms[p] = { status: 'skipped', message: '预算用尽未测' } })
      queue.length = 0
      return Promise.resolve()
    }
    var src = queue.shift()
    var songs = TEST_SONGS[src] || []
    if (!songs.length) { platforms[src] = { status: 'skipped', message: '无测试歌曲' }; return next() }
    var song = songs[0]
    var reqId = 'mk_' + Date.now() + '_' + Math.floor(Math.random() * 1e6)
    var payload = { source: src, action: 'musicUrl', info: { type: '128k', musicInfo: song.info } }
    try {
      vm.runInContext('globalThis.lx._dispatch(' + JSON.stringify(reqId) + ', "request", ' + JSON.stringify(payload) + ');', ctx, { timeout: 5000 })
    } catch (e) {
      platforms[src] = { status: 'failed', message: 'dispatch 异常' }
      return next()
    }
    return waitEvent(reqId).then(function (ev) {
      var done = function (status, message) {
        platforms[src] = { status: status, message: String(message || '').slice(0, 80) }
        return next()
      }
      if (!ev) return done('failed', '无响应')
      if (ev.name === 'dispatchError') return done('failed', String(ev.data.error || '脚本失败'))
      var ret = ev.data.result
      if (typeof ret === 'string' && ret.indexOf('http') === 0) {
        return verifyUrl(ret).then(function (v) {
          if (v.ok) {
            usablePlatforms.push(src)
            return done('usable', '试听「' + song.name + '」返回真实音频')
          }
          return done('failed', '链接不可播: ' + v.reason)
        })
      }
      return done('failed', ret == null || ret === '' ? '返回空链接' : '返回异常: ' + String(ret).slice(0, 60))
    })
  }
  return next().then(function () {
    result({ loadable: true, inited: true, sourceCount: sourceCount, platforms: platforms, usablePlatforms: usablePlatforms, loadError: null })
  })
}).catch(function (e) {
  fail(String(e && e.message || e).slice(0, 160))
})
