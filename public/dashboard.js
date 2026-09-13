const $ = (id) => document.getElementById(id)

const DEVICE_COLORS = { desktop: '#818CF8', mobile: '#34D399', tablet: '#FBBF24', other: '#6B7280' }

let stats = null
let campaigns = []
let rangeDays = 7

/* -------------------------------- helpers -------------------------------- */

function greet(name) {
  const h = new Date().getHours()
  const part = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'
  return `Good ${part}${name ? ', ' + name : ''}`
}

const dayKey = (d) => d.toISOString().slice(0, 10)

/** Continuous daily series for the last `days`, gaps filled with zero. */
function seriesForRange(series, days, offset = 0) {
  const out = []
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i - offset)
    out.push({
      label: days <= 1 ? 'Today' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      value: series[dayKey(d)] || 0,
    })
  }
  return out
}

const sum = (points) => points.reduce((s, p) => s + p.value, 0)

/**
 * Period-over-period change, but only when it means something.
 *
 * A jump from 1 click to 3 is "+200%", which is noise dressed as a signal. We
 * need a real baseline before showing a percentage, and metrics with no history
 * at all (unique visitors, campaigns) never get one.
 */
const MIN_BASELINE = 10

function delta(series, days) {
  const current = sum(seriesForRange(series, days))
  const previous = sum(seriesForRange(series, days, days))
  if (previous < MIN_BASELINE) return { enough: false, current, previous }
  const pct = Math.round(((current - previous) / previous) * 100)
  return { enough: true, pct, current, previous }
}

function renderDelta(el, series, days, noun) {
  const d = delta(series, days)
  if (!d.enough) {
    // Say what the number covers instead of inventing a comparison.
    el.textContent = d.current ? `${d.current.toLocaleString()} in the last ${days} days` : ''
    el.className = 'metric-delta metric-delta-quiet'
    return
  }
  const up = d.pct >= 0
  el.textContent = `${up ? '+' : ''}${d.pct}% vs previous ${days} days`
  el.className = 'metric-delta ' + (d.pct === 0 ? 'metric-delta-quiet' : up ? 'metric-delta-up' : 'metric-delta-down')
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
  const slug = `<b>/${escapeHtml(a.slug)}</b>`
  if (a.type === 'created') return `Created ${slug}`
  if (a.type === 'edited') return `Edited ${slug}`
  if (a.type === 'deleted') return `Deleted ${slug}`
  if (a.type === 'claimed') return `Saved ${slug} to your account`
  if (a.type === 'milestone') return `${slug} reached ${a.value.toLocaleString()} clicks`
  return escapeHtml(a.type)
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
const num = (n) => Number(n || 0).toLocaleString()
const shortDest = (url) => String(url).replace(/^https?:\/\//, '').slice(0, 60)

/* -------------------------------- rendering ------------------------------- */

function renderChart() {
  Charts.line($('chart-clicks'), seriesForRange(stats.series, rangeDays))

  const bots = stats.totalBotClicks || 0
  $('bot-note').textContent = bots
    ? `${bots.toLocaleString()} bot and link-preview ${bots === 1 ? 'hit' : 'hits'} excluded from these numbers.`
    : ''
}

function render() {
  const hasData = stats.totalLinks > 0
  $('onboarding').hidden = hasData
  $('stats-view').hidden = !hasData
  $('subtitle').textContent = hasData
    ? 'Track every click and understand where your traffic comes from.'
    : 'Create your first tracking link to see who clicks it.'
  if (!hasData) return

  $('m-links').textContent = stats.totalLinks.toLocaleString()
  $('m-clicks').textContent = stats.totalClicks.toLocaleString()
  $('m-visitors').textContent = stats.uniqueVisitors.toLocaleString()
  $('m-campaigns').textContent = (stats.totalCampaigns || 0).toLocaleString()

  renderDelta($('d-clicks'), stats.series, rangeDays)
  renderDelta($('d-links'), stats.linksSeries || {}, rangeDays)
  // Unique visitors and campaigns have no per-day history to compare against,
  // so they get a plain description rather than a made-up percentage.
  $('d-visitors').textContent = 'all time'
  $('d-visitors').className = 'metric-delta metric-delta-quiet'
  $('d-campaigns').textContent = campaigns.length ? `${campaigns.length} active` : 'none yet'
  $('d-campaigns').className = 'metric-delta metric-delta-quiet'

  renderChart()

  const tl = $('top-links')
  tl.innerHTML = stats.topLinks.length
    ? `<div class="tl-row tl-head"><span>Link</span><span>Clicks</span><span>Visitors</span></div>` +
      stats.topLinks
        .map(
          (l) => `<div class="tl-row">
            <span class="tl-main">
              <a class="tl-slug" href="/link?slug=${encodeURIComponent(l.slug)}">/${escapeHtml(l.slug)}</a>
              <span class="tl-url">${escapeHtml(l.title || shortDest(l.url))}</span>
            </span>
            <span class="tl-metric">${l.clicks.toLocaleString()}</span>
            <span class="tl-metric">${l.visitors.toLocaleString()}</span>
          </div>`,
        )
        .join('')
    : '<div class="chart-empty">No clicks yet. Share a link and they will show up here.</div>'

  $('activity').innerHTML = stats.activity.length
    ? stats.activity
        .slice(0, 8)
        .map(
          (a) => `<div class="activity-row"><span class="activity-dot"></span>
            <span>${activityText(a)}</span><span class="activity-time">${timeAgo(a.at)}</span></div>`,
        )
        .join('')
    : '<div class="chart-empty">Nothing yet</div>'

  Charts.barList($('referrers'), topEntries(stats.referrers, 4))
  Charts.donut(
    $('devices'),
    ['desktop', 'mobile', 'tablet'].map((k) => ({ label: cap(k), value: stats.devices[k] || 0, color: DEVICE_COLORS[k] })),
  )
  Charts.barList($('countries'), topEntries(stats.countries, 4), { flag: true })
}

/* --------------------------------- loading -------------------------------- */

/**
 * How much of this period's allowance is left, said before it runs out.
 *
 * Finding out you are at the limit at the moment you needed one more link is
 * the avoidable version of this. The numbers come from /api/usage/summary,
 * which reads the same counters the server enforces with.
 */
async function loadAllowance() {
  const el = $('quick-limit')
  let use
  try {
    use = await (await fetch('/api/usage/summary')).json()
  } catch {
    return null
  }
  if (!el) return use
  const { used, limit, resetAt } = use.links || {}

  const left = Math.max(0, limit - used)
  const days = resetAt ? Math.max(0, Math.round((resetAt - Date.now()) / 86400000)) : null
  const when = days === null ? '' : days <= 1 ? ', resets within a day' : `, resets in ${days} days`

  if (!Number.isFinite(limit)) return use

  if (left === 0) {
    el.innerHTML = `You have created ${used} of ${limit} links this period${when}. Links you have already made keep working. <a href="/account">See plans</a>`
    el.classList.add('over')
  } else if (left <= Math.max(2, Math.round(limit * 0.1))) {
    el.innerHTML = `${left} link${left === 1 ? '' : 's'} left this period${when}. <a href="/account">See plans</a>`
    el.classList.add('over')
  } else {
    el.textContent = `${used} of ${limit} links used this period${when}.`
    el.classList.remove('over')
  }
  return use
}

async function loadStats() {
  const res = await fetch('/api/stats')
  if (res.status === 401) return (window.location.href = '/login')
  stats = await res.json()
  render()
}

/**
 * Links whose destination stopped answering.
 *
 * Checked on a schedule, never on the redirect path, so this only ever reads
 * what the last check found. Shown at the top because a broken destination is
 * costing clicks right now, and nothing else on this page tells you.
 */
async function loadHealth(features) {
  // Monitoring is a paid feature. A plan without it has no panel here, and we
  // do not ask the server a question we already know the answer to.
  if (features && !features.healthMonitoring) return
  let data
  try {
    const res = await fetch('/api/links/health')
    if (!res.ok) return
    data = await res.json()
  } catch {
    return
  }
  const broken = data.broken || []
  $('health-alert').hidden = broken.length === 0
  if (!broken.length) return

  const since = (ts) => {
    const hours = Math.floor((Date.now() - ts) / 3600e3)
    if (hours < 1) return 'just now'
    if (hours < 24) return `${hours}h`
    return `${Math.floor(hours / 24)}d`
  }

  $('health-alert').innerHTML =
    `<div class="health-head">${broken.length === 1 ? '1 link may be broken' : `${broken.length} links may be broken`}</div>` +
    broken
      .slice(0, 5)
      .map(
        (b) => `<div class="health-row">
          <a class="mono" href="/links?q=${encodeURIComponent(b.slug)}">/${escapeHtml(b.slug)}</a>
          <span class="health-why">${escapeHtml(b.label)}${b.code ? ` (${b.code})` : ''}</span>
          <span class="health-meta">failing ${since(b.failingSince)} · ${num(b.recentClicks)} clicks in 30 days</span>
        </div>`,
      )
      .join('') +
    (broken.length > 5 ? `<div class="health-meta">and ${broken.length - 5} more</div>` : '')
}

async function loadCampaigns() {
  try {
    campaigns = (await (await fetch('/api/campaigns')).json()).campaigns || []
  } catch {
    campaigns = []
  }
  $('quick-campaign').innerHTML =
    '<option value="">No campaign</option>' +
    campaigns.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('')
}

/* ------------------------------ quick create ------------------------------ */

function utmValues() {
  const utm = {}
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign']) {
    const v = $(key).value.trim()
    if (v) utm[key] = v
  }
  return Object.keys(utm).length ? utm : undefined
}

async function createLink(e) {
  e?.preventDefault()
  const url = $('quick-url').value.trim()
  if (!url) return

  $('quick-err').textContent = ''
  $('quick-go').disabled = true
  $('quick-go').textContent = 'Creating...'

  try {
    const res = await fetch('/api/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        alias: $('quick-alias').value.trim() || undefined,
        title: $('quick-title').value.trim() || undefined,
        campaign: $('quick-campaign').value || undefined,
        utm: utmValues(),
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      $('quick-err').textContent = data.error || 'Could not create that link'
      if (data.needsUpgrade) $('quick-err').innerHTML += ' <a href="/account">See plans</a>'
      return
    }

    $('quick-link').textContent = data.shortUrl.replace(/^https?:\/\//, '')
    $('quick-link').href = data.shortUrl
    $('quick-stats').href = `/link?slug=${encodeURIComponent(data.slug)}`
    $('quick-result').hidden = false
    $('quick-result').dataset.short = data.shortUrl
    $('quick-result').dataset.slug = data.slug

    // Clear only what should not carry over: the destination and its alias.
    // Campaign and UTM values usually apply to the next few links too.
    $('quick-url').value = ''
    $('quick-alias').value = ''
    $('quick-title').value = ''
    $('quick-url').focus()

    await Promise.all([loadStats(), loadAllowance()])
  } catch {
    $('quick-err').textContent = 'Network error. Try again.'
  } finally {
    $('quick-go').disabled = false
    $('quick-go').textContent = 'Create link'
  }
}

function openQr() {
  const short = $('quick-result').dataset.short
  const slug = $('quick-result').dataset.slug
  const d = encodeURIComponent(short)
  $('qr-preview').innerHTML = `<img src="/api/qr?data=${d}&format=svg" alt="QR code for ${escapeHtml(slug)}" />`
  $('qr-target').textContent = short
  $('qr-png').href = `/api/qr?data=${d}&format=png&download=1&name=${encodeURIComponent(slug)}`
  $('qr-svg').href = `/api/qr?data=${d}&format=svg&download=1&name=${encodeURIComponent(slug)}`
  $('qr-modal').classList.add('show')
}

/* --------------------------------- wire up -------------------------------- */

$('quick-form').addEventListener('submit', createLink)

$('quick-more').addEventListener('click', () => {
  const adv = $('quick-advanced')
  adv.hidden = !adv.hidden
  $('quick-more').textContent = adv.hidden ? 'More options' : 'Fewer options'
  if (!adv.hidden) $('quick-alias').focus()
})

$('quick-copy').addEventListener('click', () => {
  navigator.clipboard?.writeText($('quick-result').dataset.short).catch(() => {})
  $('quick-copy').textContent = 'Copied'
  setTimeout(() => ($('quick-copy').textContent = 'Copy'), 1200)
})

$('quick-qr').addEventListener('click', openQr)
$('qr-close').addEventListener('click', () => $('qr-modal').classList.remove('show'))
$('qr-modal').addEventListener('click', (e) => e.target === $('qr-modal') && $('qr-modal').classList.remove('show'))

$('range').addEventListener('click', (e) => {
  const btn = e.target.closest('button')
  if (!btn) return
  rangeDays = Number(btn.dataset.days)
  ;[...$('range').children].forEach((b) => b.classList.toggle('active', b === btn))
  renderChart()
  renderDelta($('d-clicks'), stats.series, rangeDays)
  renderDelta($('d-links'), stats.linksSeries || {}, rangeDays)
})

;(async () => {
  const user = await window.shellReady
  if (!user) return
  $('greeting').textContent = greet((user.name || user.email || '').split('@')[0])
  const [, , use] = await Promise.all([loadCampaigns(), loadStats(), loadAllowance()])
  await loadHealth(use?.features)
})()
