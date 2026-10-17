var list = document.getElementById('list')
var meta = document.getElementById('meta')
var q = document.getElementById('q')
var all = []

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  })
}

function render() {
  var kw = q.value.trim().toLowerCase()
  var rows = all.filter(function (s) {
    if (!kw) return true
    return (s.name + ' ' + s.url + ' ' + s.repo + ' ' + s.submitter).toLowerCase().indexOf(kw) !== -1
  })
  if (!rows.length) {
    list.innerHTML = '<div class="empty">' + (all.length ? '没有匹配的收录' : '暂无收录 — 点右上角「投稿收录」提交第一个') + '</div>'
    return
  }
  list.innerHTML = rows.map(function (s) {
    var typeTxt = s.type === 'repo' ? '仓库' : '直链'
    var st = s.stats
    var usableBadge = ''
    if (st && typeof st.usable === 'number' && typeof st.source === 'number' && st.source > 0) {
      usableBadge = '<span class="type ub">审核时实测可用 ' + st.usable + '/' + st.source + '</span>'
    }
    return '<div class="item">' +
      '<div class="row1"><span class="name">' + esc(s.name) + '</span>' +
      '<span class="type">' + typeTxt + '</span>' + usableBadge +
      (s.submitter ? '<span class="by">by ' + esc(s.submitter) + '</span>' : '') +
      '</div>' +
      '<div class="row2"><span class="url">' + esc(s.url) + '</span>' +
      '<button data-copy="' + esc(s.url) + '">复制链接</button>' +
      '<a href="' + esc(s.issue ? 'https://github.com/zlyon/lx-hunter-market/issues/' + s.issue : s.url) + '" target="_blank" rel="noopener"><button>详情</button></a>' +
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

fetch('community.json').then(function (r) {
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return r.json()
}).then(function (d) {
  all = d.sources || []
  meta.textContent = '共 ' + all.length + ' 个收录'
  document.getElementById('updatedAt').textContent = '更新于 ' + new Date(d.updatedAt).toLocaleString('zh-CN')
  render()
}).catch(function (e) {
  list.innerHTML = '<div class="empty">数据加载失败（' + esc(e.message || e) + '）</div>'
  meta.textContent = ''
})

q.addEventListener('input', render)
