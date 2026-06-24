const $ = (id) => document.getElementById(id)

const DEVICE_COLORS = { desktop: '#818CF8', mobile: '#34D399', tablet: '#FBBF24', other: '#6B7280' }
let stats = null
let rangeDays = 7

function greet(name) {
  const h = new Date().getHours()
  const part = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'
  return `Good ${part}${name ? ', ' + name : ''}`
}

async function requireSession() {
  try {
    const res = await fetch('/auth/me')
    if (!res.ok) return (window.location.href = '/login'), null
    return (await res.json()).user
  } catch {
    return (window.location.href = '/login'), null
  }
}

// Build a continuous daily series for the last `days`, filling gaps with 0.
function seriesForRange(series, days) {
  const out = []
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    out.push({ label: days <= 1 ? 'Today' : label, value: series[key] || 0 })
  }
  return out
}

function topEntries(obj, n) {
  return Object.entries(obj || {})
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, n)
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function activityText(a) {
  if (a.type === 'created') return `Created <b>/${a.slug}</b>`
  if (a.type === 'deleted') return `Deleted <b>/${a.slug}</b>`
  if (a.type === 'milestone') return `<b>/${a.slug}</b> reached ${a.value.toLocaleString()} clicks`
  return a.type
}

function renderChart() {
  Charts.line($('chart-clicks'), seriesForRange(stats.series, rangeDays))
}

function render() {
  $('m-links').textContent = stats.totalLinks.toLocaleString()
  $('m-clicks').textContent = stats.totalClicks.toLocaleString()
  $('m-visitors').textContent = stats.uniqueVisitors.toLocaleString()
  $('m-campaigns').textContent = '0'

  renderChart()

  // Top links
  const tl = $('top-links')
  if (!stats.topLinks.length) {
    tl.innerHTML = '<div class="chart-empty">No links yet. Create your first one.</div>'
  } else {
    tl.innerHTML =
      `<div class="tl-row tl-head"><span>Link</span><span>Clicks</span><span>Visitors</span></div>` +
      stats.topLinks
        .map(
          (l) => `<div class="tl-row">
            <span class="tl-main"><a class="tl-slug" href="/${l.slug}" target="_blank" rel="noreferrer">/${l.slug}</a>
              <span class="tl-url">${escapeHtml(l.url)}</span></span>
            <span class="tl-metric">${l.clicks.toLocaleString()}</span>
            <span class="tl-metric">${l.visitors.toLocaleString()}</span>
          </div>`,
        )
        .join('')
  }

  // Activity
  const act = $('activity')
  act.innerHTML = stats.activity.length
    ? stats.activity
        .map(
          (a) => `<div class="activity-row"><span class="activity-dot"></span>
            <span>${activityText(a)}</span><span class="activity-time">${timeAgo(a.at)}</span></div>`,
        )
        .join('')
    : '<div class="chart-empty">No activity yet</div>'

  // Referrers, devices, countries
  Charts.barList($('referrers'), topEntries(stats.referrers, 6))
  Charts.donut(
    $('devices'),
    ['desktop', 'mobile', 'tablet'].map((k) => ({ label: cap(k), value: stats.devices[k] || 0, color: DEVICE_COLORS[k] })),
  )
  Charts.barList($('countries'), topEntries(stats.countries, 6), { flag: true })
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

async function loadStats() {
  const res = await fetch('/api/stats')
  if (res.status === 401) return (window.location.href = '/login')
  stats = await res.json()
  render()
}

/* ------------------------------ create modal ------------------------------ */

function openModal() {
  $('m-err').textContent = ''
  $('m-url').value = ''
  $('m-alias').value = ''
  $('modal').classList.add('show')
  $('m-url').focus()
}
function closeModal() {
  $('modal').classList.remove('show')
}
async function createLink() {
  const url = $('m-url').value.trim()
  if (!url) return
  $('m-create').disabled = true
  $('m-create').textContent = 'Creating...'
  try {
    const res = await fetch('/api/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, alias: $('m-alias').value.trim() || undefined }),
    })
    const data = await res.json()
    if (!res.ok) {
      $('m-err').textContent = data.error || 'Could not create that link'
      return
    }
    closeModal()
    await loadStats()
  } catch {
    $('m-err').textContent = 'Network error. Try again.'
  } finally {
    $('m-create').disabled = false
    $('m-create').textContent = 'Create'
  }
}

function toast(msg) {
  const t = document.createElement('div')
  t.className = 'toast'
  t.textContent = msg
  document.body.appendChild(t)
  setTimeout(() => t.classList.add('show'), 10)
  setTimeout(() => {
    t.classList.remove('show')
    setTimeout(() => t.remove(), 300)
  }, 1800)
}

/* --------------------------------- wire up -------------------------------- */

$('range').addEventListener('click', (e) => {
  const btn = e.target.closest('button')
  if (!btn) return
  rangeDays = Number(btn.dataset.days)
  ;[...$('range').children].forEach((b) => b.classList.toggle('active', b === btn))
  renderChart()
})

$('create-link').addEventListener('click', openModal)
$('create-qr').addEventListener('click', () => toast('QR codes are coming soon'))
$('m-cancel').addEventListener('click', closeModal)
$('m-create').addEventListener('click', createLink)
$('m-url').addEventListener('keydown', (e) => e.key === 'Enter' && createLink())
$('m-alias').addEventListener('keydown', (e) => e.key === 'Enter' && createLink())
$('modal').addEventListener('click', (e) => e.target === $('modal') && closeModal())

document.querySelectorAll('[data-soon]').forEach((a) =>
  a.addEventListener('click', (e) => {
    e.preventDefault()
    toast('That section is coming soon')
  }),
)

$('logout').addEventListener('click', async (e) => {
  e.preventDefault()
  await fetch('/auth/logout', { method: 'POST' })
  window.location.href = '/'
})

;(async () => {
  const user = await requireSession()
  if (!user) return
  const name = (user.name || user.email || '').split('@')[0]
  $('greeting').textContent = greet(name)
  $('su-name').textContent = user.email
  $('su-plan').textContent = user.plan === 'pro' ? 'Pro' : 'Free'
  if (user.plan === 'pro') $('su-plan').classList.add('pro')
  await loadStats()
})()
