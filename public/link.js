const $ = (id) => document.getElementById(id)
const DEVICE_COLORS = { desktop: '#818CF8', mobile: '#34D399', tablet: '#FBBF24' }
const slug = new URLSearchParams(location.search).get('slug')
let data = null
let rangeDays = 7

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

function seriesForRange(series, days) {
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
const topKey = (obj) => topEntries(obj, 1)[0]?.label

function renderChart() {
  Charts.line($('chart-clicks'), seriesForRange(data.series, rangeDays))
}

function render() {
  $('title').textContent = '/' + data.slug
  $('dest').textContent = data.url
  $('dest').href = data.url
  $('m-clicks').textContent = data.clicks.toLocaleString()
  $('m-visitors').textContent = data.visitors.toLocaleString()
  const tc = topKey(data.countries)
  $('m-country').textContent = tc ? `${Charts.flag(tc)} ${tc}` : '—'
  $('m-device').textContent = cap(topKey(data.devices)) || '—'
  renderChart()
  Charts.barList($('referrers'), topEntries(data.referrers, 6))
  Charts.donut(
    $('devices'),
    ['desktop', 'mobile', 'tablet'].map((k) => ({ label: cap(k), value: data.devices[k] || 0, color: DEVICE_COLORS[k] })),
  )
  Charts.barList($('countries'), topEntries(data.countries, 6), { flag: true })
}

function openQr() {
  const d = encodeURIComponent(data.shortUrl)
  $('qr-preview').innerHTML = `<img src="/api/qr?data=${d}&format=svg" alt="QR" />`
  $('qr-target').textContent = data.shortUrl
  $('qr-png').href = `/api/qr?data=${d}&format=png&download=1&name=${encodeURIComponent(data.slug)}`
  $('qr-svg').href = `/api/qr?data=${d}&format=svg&download=1&name=${encodeURIComponent(data.slug)}`
  $('qr-modal').classList.add('show')
}

$('range').addEventListener('click', (e) => {
  const btn = e.target.closest('button')
  if (!btn) return
  rangeDays = Number(btn.dataset.days)
  ;[...$('range').children].forEach((b) => b.classList.toggle('active', b === btn))
  renderChart()
})
$('copy').addEventListener('click', () => {
  navigator.clipboard?.writeText(data.shortUrl).catch(() => {})
  $('copy').textContent = 'Copied'
  setTimeout(() => ($('copy').textContent = 'Copy'), 1000)
})
$('qr').addEventListener('click', openQr)
$('qr-close').addEventListener('click', () => $('qr-modal').classList.remove('show'))
$('qr-modal').addEventListener('click', (e) => e.target === $('qr-modal') && $('qr-modal').classList.remove('show'))

;(async () => {
  const user = await window.shellReady
  if (!user) return
  if (!slug) return (window.location.href = '/links')
  const res = await fetch(`/api/links/${encodeURIComponent(slug)}/stats`)
  if (res.status === 401) return (window.location.href = '/login')
  if (!res.ok) return (window.location.href = '/links')
  data = await res.json()
  render()
})()
