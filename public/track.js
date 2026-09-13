// Guest link dashboard. Everything here is addressed by the management token in
// the URL, never by the short code: the short code is meant to be shared, the
// token is what proves you made the link.

const $ = (id) => document.getElementById(id)
const DEVICE_COLORS = { desktop: '#818CF8', mobile: '#34D399', tablet: '#FBBF24' }
const token = new URLSearchParams(location.search).get('t')

let data = null
let rangeDays = 7

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

function seriesForRange(series, days) {
  const out = []
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    out.push({
      label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      value: series[d.toISOString().slice(0, 10)] || 0,
    })
  }
  return out
}

function topEntries(obj, n) {
  return Object.entries(obj || {})
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, n)
}

function daysUntil(ts) {
  const d = Math.ceil((ts - Date.now()) / 864e5)
  if (d <= 0) return 'today'
  if (d === 1) return 'tomorrow'
  return `in ${d} days`
}

function renderChart() {
  Charts.line($('chart-clicks'), seriesForRange(data.series, rangeDays))
}

function render() {
  const pretty = data.shortUrl.replace(/^https?:\/\//, '')
  $('short').textContent = pretty
  $('dest').textContent = data.url
  $('dest').href = data.url
  $('m-clicks').textContent = (data.clicks || 0).toLocaleString()
  $('m-visitors').textContent = (data.visitors || 0).toLocaleString()
  $('m-bots').textContent = (data.botClicks || 0).toLocaleString()

  const topCountry = topEntries(data.countries, 1)[0]?.label
  $('m-country').textContent = topCountry ? `${Charts.flag(topCountry)} ${Charts.countryName(topCountry)}` : '—'

  if (data.expiresAt) {
    $('expires').textContent = daysUntil(data.expiresAt)
    $('expiry-banner').hidden = false
  }

  renderChart()
  Charts.barList($('referrers'), topEntries(data.referrers, 6))
  Charts.donut(
    $('devices'),
    ['desktop', 'mobile', 'tablet'].map((k) => ({
      label: cap(k),
      value: data.devices[k] || 0,
      color: DEVICE_COLORS[k],
    })),
  )
  Charts.barList($('countries'), topEntries(data.countries, 6), { flag: true })

  // Carry the token to signup so the account claims this link on creation.
  for (const id of ['claim-cta', 'claim-cta-2']) {
    $(id).href = `/signup?claim=${encodeURIComponent(token)}`
  }
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
  setTimeout(() => ($('copy').textContent = 'Copy link'), 1200)
})

$('qr').addEventListener('click', () => {
  const d = encodeURIComponent(data.shortUrl)
  $('qr-preview').innerHTML = `<img src="/api/qr?data=${d}&format=svg" alt="QR code" />`
  $('qr-target').textContent = data.shortUrl
  $('qr-modal').classList.add('show')
})
$('qr-close').addEventListener('click', () => $('qr-modal').classList.remove('show'))
$('qr-modal').addEventListener('click', (e) => e.target === $('qr-modal') && $('qr-modal').classList.remove('show'))

;(async () => {
  if (!token) {
    $('loading').hidden = true
    $('missing').hidden = false
    return
  }
  try {
    const res = await fetch(`/api/guest/stats?t=${encodeURIComponent(token)}`)
    if (!res.ok) throw new Error('not found')
    data = await res.json()
    $('loading').hidden = true
    $('panel').hidden = false
    render()
  } catch {
    $('loading').hidden = true
    $('missing').hidden = false
  }
})()
