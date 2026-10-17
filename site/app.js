var list = document.getElementById('list')
var meta = document.getElementById('meta')
var q = document.getElementById('q')
var onlyOk = document.getElementById('onlyOk')
var all = []
var curType = 'all'

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  })
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString('zh-CN') } catch (e) { return '' }
}

/* 统计口径：source=疑似音源脚本数，usable=沙箱实测可用数；source 为 null 表示预检未测出 */
function statOf(s) {
  var st = s.stats
  if (!st || typeof st.usable !== 'number' || typeof st.source !== 'number' || !st.source) return null
  return st
}

function renderOverview() {
  var totSource = 0, totUsable = 0, pending = 0
  all.forEach(function (s) {
    var st = statOf(s)
    if (st) { totSource += st.source; totUsable += st.usable }
    else pending++
  })
  document.getElementById('ovCount').textContent = all.length
  document.getElementById('ovSource').textContent = totSource
  document.getElementById('ovUsable').textContent = totUsable
  document.getElementById('ovPending').textContent = pending
}

function render() {
  var kw = q.value.trim().toLowerCase()
  var rows = all.filter(function (s) {
    if (curType !== 'all' && s.type !== curType) return false
    if (onlyOk.checked && !statOf(s)) return false
    if (!kw) return true
    return (s.name + ' ' + s.url + ' ' + s.repo + ' ' + s.submitter).toLowerCase().indexOf(kw) !== -1
  })
  meta.textContent = '显示 ' + rows.length + ' / ' + all.length
  if (!rows.length) {
    list.innerHTML = '<div class="empty">' + (all.length ? '没有匹配的收录' : '暂无收录 — 点右上角「投稿收录」提交第一个') + '</div>'
    return
  }
  list.innerHTML = rows.map(function (s) {
    var typeTxt = s.type === 'repo' ? '仓库' : s.type === 'page' ? '发布页' : '直链'
    var st = statOf(s)
    var meter = '', statline = ''
    if (st) {
      var pct = Math.round(st.usable / st.source * 100)
      var cls = st.usable > 0 ? 'ok' : 'zero'
      meter = '<div class="meter' + (st.usable > 0 ? '' : ' zero') + '"><i style="width:' + Math.max(pct, st.usable > 0 ? 4 : 100) + '%"></i></div>'
      statline = '<div class="statline">' +
        '<span class="' + cls + '">实测可用 ' + st.usable + ' / ' + st.source + '</span>' +
        (st.jsTotal ? '<span class="dim">扫描 ' + st.jsTotal + ' 个脚本</span>' : '') +
        (st.at ? '<span class="dim">测于 ' + fmtDate(st.at) + '</span>' : '') +
        '</div>'
    } else {
      statline = '<div class="statline"><span class="dim">暂无实测统计</span></div>'
    }
    return '<div class="item">' +
      '<div class="head"><span class="name">' + esc(s.name) + '</span>' +
      '<span class="chip">' + typeTxt + '</span>' +
      (s.submitter ? '<span class="by">by ' + esc(s.submitter) + (s.approvedAt ? ' · 收录于 ' + fmtDate(s.approvedAt) : '') + '</span>' : '') +
      '</div>' +
      meter + statline +
      '<div class="row"><span class="url">' + esc(s.url) + '</span>' +
      '<button data-copy="' + esc(s.url) + '">复制链接</button>' +
      '<a href="' + esc(s.issue ? 'https://github.com/zlyon/lx-hunter-market/issues/' + s.issue : s.url) + '" target="_blank" rel="noopener"><button>审核记录</button></a>' +
      '</div>' +
      (s.notes ? '<div class="notes">' + esc(s.notes) + '</div>' : '') +
      '</div>'
  }).join('')
  var btns = list.querySelectorAll('button[data-copy]')
  for (var i = 0; i < btns.length; i++) {
    ;(function (el) {
      el.onclick = function () {
        var url = el.getAttribute('data-copy')
        function done(ok) {
          el.textContent = ok ? '已复制' : '复制失败'
          setTimeout(function () { el.textContent = '复制链接' }, 1200)
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(function () { done(true) }, function () { done(false) })
        } else {
          var ta = document.createElement('textarea')
          ta.value = url
          document.body.appendChild(ta)
          ta.select()
          var ok = document.execCommand('copy')
          document.body.removeChild(ta)
          done(ok)
        }
      }
    })(btns[i])
  }
}

/* 类型筛选 chips */
var chips = document.getElementById('chips').querySelectorAll('.chip')
for (var c = 0; c < chips.length; c++) {
  ;(function (el) {
    el.onclick = function () {
      for (var k = 0; k < chips.length; k++) chips[k].classList.remove('on')
      el.classList.add('on')
      curType = el.getAttribute('data-t')
      render()
    }
  })(chips[c])
}

fetch('community.json').then(function (r) {
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return r.json()
}).then(function (d) {
  all = d.sources || []
  renderOverview()
  render()
  document.getElementById('updatedAt').textContent = '更新于 ' + new Date(d.updatedAt).toLocaleString('zh-CN')
}).catch(function (e) {
  list.innerHTML = '<div class="empty">数据加载失败（' + esc(e.message || e) + '）</div>'
  meta.textContent = ''
})

q.addEventListener('input', render)
onlyOk.addEventListener('change', render)
