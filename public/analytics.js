const $ = (id) => document.getElementById(id)
const DEVICE_COLORS = { desktop: '#818CF8', mobile: '#34D399', tablet: '#FBBF24' }
let stats = null
let rangeDays = 7

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

function rangeSeries(series, days) {
  const out = []
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    out.push({ label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), value: series[key] || 0 })
  }
  return out
}
function topEntries(obj, n) {
  return Object.entries(obj || {}).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, n)
}

function renderRange() {
  const pts = rangeSeries(stats.series, rangeDays)
  const sum = pts.reduce((s, p) => s + p.value, 0)
  $('m-clicks').textContent = sum.toLocaleString()
  $('m-avg').textContent = Math.round(sum / rangeDays).toLocaleString()
  Charts.line($('chart-clicks'), pts)
}

function render() {
  $('m-total').textContent = stats.totalClicks.toLocaleString()
  $('m-visitors').textContent = stats.uniqueVisitors.toLocaleString()
  renderRange()
  Charts.barList($('referrers'), topEntries(stats.referrers, 6))
  Charts.donut(
    $('devices'),
    ['desktop', 'mobile', 'tablet'].map((k) => ({ label: cap(k), value: stats.devices[k] || 0, color: DEVICE_COLORS[k] })),
  )
  Charts.barList($('countries'), topEntries(stats.countries, 6), { flag: true })

  const tl = $('top-links')
  tl.innerHTML = stats.topLinks.length
    ? `<div class="tl-row tl-head"><span>Link</span><span>Clicks</span><span>Visitors</span></div>` +
      stats.topLinks
        .map(
          (l) => `<div class="tl-row">
            <span class="tl-main"><a class="tl-slug" href="/link?slug=${encodeURIComponent(l.slug)}">/${l.slug}</a>
              <span class="tl-url">${escapeHtml(l.url)}</span></span>
            <span class="tl-metric">${l.clicks.toLocaleString()}</span>
            <span class="tl-metric">${l.visitors.toLocaleString()}</span>
          </div>`,
        )
        .join('')
    : '<div class="chart-empty">No links yet.</div>'
}

$('range').addEventListener('click', (e) => {
  const btn = e.target.closest('button')
  if (!btn) return
  rangeDays = Number(btn.dataset.days)
  ;[...$('range').children].forEach((b) => b.classList.toggle('active', b === btn))
  renderRange()
})

;(async () => {
  const user = await window.shellReady
  if (!user) return
  const res = await fetch('/api/stats')
  if (res.status === 401) return (window.location.href = '/login')
  stats = await res.json()
  render()
})()
