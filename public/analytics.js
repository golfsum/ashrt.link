const $ = (id) => document.getElementById(id)

const DEVICE_COLORS = { desktop: '#818CF8', mobile: '#34D399', tablet: '#FBBF24' }

let stats = null
let links = []
let campaigns = []
let rangeDays = 30

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
const num = (n) => Number(n || 0).toLocaleString()

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c])
}

const dayKey = (d) => d.toISOString().slice(0, 10)

/** A continuous series. `days: 0` means every day we have data for. */
function seriesForRange(series, days, offset = 0) {
  if (!days) {
    return Object.entries(series)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, value]) => ({
        label: new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        value,
      }))
  }
  const out = []
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i - offset)
    out.push({
      label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      value: series[dayKey(d)] || 0,
    })
  }
  return out
}

const sum = (points) => points.reduce((s, p) => s + p.value, 0)

function topEntries(obj, n) {
  return Object.entries(obj || {})
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, n)
}

/* -------------------------------- filtering ------------------------------- */

/**
 * Which links the report covers. Filtering happens client-side over the link
 * list we already hold, so changing scope is instant and costs no round-trip.
 */
function scopedLinks() {
  const slug = $('scope').value
  const campaign = $('campaign').value
  return links.filter((l) => (!slug || l.slug === slug) && (!campaign || l.campaign === campaign))
}

/**
 * Rebuild the aggregate for the current scope.
 *
 * When the scope is everything, the server summary is used as-is. Narrowing to
 * a link or a campaign re-aggregates from that link's own per-link stats, which
 * are fetched on demand.
 */
function aggregate(perLink) {
  const out = {
    clicks: 0,
    botClicks: 0,
    visitors: 0,
    series: {},
    devices: {},
    countries: {},
    referrers: {},
    browsers: {},
    os: {},
    hours: {},
    weekdays: {},
    channels: {},
    bots: {},
    destinations: {},
    topLinks: [],
  }

  for (const l of perLink) {
    out.clicks += l.clicks || 0
    out.botClicks += l.botClicks || 0
    out.visitors += l.visitors || 0
    for (const [k, n] of Object.entries(l.series || {})) out.series[k] = (out.series[k] || 0) + n
    for (const dim of ['devices', 'countries', 'referrers', 'browsers', 'os', 'hours', 'weekdays', 'channels', 'bots']) {
      for (const [k, n] of Object.entries(l[dim] || {})) out[dim][k] = (out[dim][k] || 0) + n
    }
    try {
      const host = new URL(l.url).hostname.replace(/^www\./, '')
      out.destinations[host] = (out.destinations[host] || 0) + (l.clicks || 0)
    } catch {
      /* skip an unparseable destination */
    }
  }

  out.topLinks = [...perLink].sort((a, b) => (b.clicks || 0) - (a.clicks || 0)).slice(0, 8)
  return out
}

/* -------------------------------- rendering ------------------------------- */

function barList(el, entries, opts) {
  if (!entries.length) {
    el.innerHTML = '<div class="chart-empty">Nothing recorded yet</div>'
    return
  }
  Charts.barList(el, entries, opts)
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** A clock hour, written the way people say it. */
const hourLabel = (h) => {
  const n = Number(h)
  if (n === 0) return '12am'
  if (n === 12) return '12pm'
  return n < 12 ? `${n}am` : `${n - 12}pm`
}

/**
 * When the clicks happen.
 *
 * Every hour and every weekday is shown, including the empty ones: the gaps
 * are the finding. A list of only the busy hours hides the fact that nothing
 * happens before noon.
 */
function renderTiming() {
  const hours = Array.from({ length: 24 }, (_, h) => ({
    label: hourLabel(h),
    value: stats.hours?.[String(h)] || 0,
  }))
  const days = WEEKDAYS.map((label, i) => ({ label, value: stats.weekdays?.[String(i)] || 0 }))

  const anyTiming = hours.some((h) => h.value) || days.some((d) => d.value)
  if (!anyTiming) {
    const note =
      '<div class="chart-empty">Recorded from now on. Clicks from before this was added are not broken down by time.</div>'
    $('hours').innerHTML = note
    $('weekdays').innerHTML = note
    return
  }

  Charts.columns($('hours'), hours, { labelEvery: 3 })
  Charts.barList($('weekdays'), days)
}

function render() {
  const points = seriesForRange(stats.series, rangeDays)
  const clicks = rangeDays ? sum(points) : stats.clicks
  const days = rangeDays || Math.max(points.length, 1)

  const hasAnything = stats.clicks > 0 || stats.botClicks > 0
  $('view').hidden = !hasAnything
  $('empty').hidden = hasAnything
  if (!hasAnything) return

  $('m-clicks').textContent = num(clicks)
  $('m-visitors').textContent = num(stats.visitors)
  $('m-avg').textContent = num(Math.round(clicks / days))
  $('m-bots').textContent = num(stats.botClicks)

  // Scans are clicks that arrived from one of our QR codes, which carry a
  // marker. Codes printed before the marker existed count as ordinary clicks,
  // so this only ever understates, never inflates.
  const scans = stats.channels?.qr || 0
  $('m-scans').textContent = num(scans)
  $('d-scans').textContent = stats.clicks
    ? `${Math.round((scans / stats.clicks) * 100)}% of clicks`
    : 'of total clicks'
  $('d-avg').textContent = rangeDays ? `over ${rangeDays} days` : `over ${days} days with data`

  // Period over period, only where the baseline supports it.
  if (rangeDays) {
    const previous = sum(seriesForRange(stats.series, rangeDays, rangeDays))
    if (previous >= 10) {
      const pct = Math.round(((clicks - previous) / previous) * 100)
      $('d-clicks').textContent = `${pct >= 0 ? '+' : ''}${pct}% vs previous ${rangeDays} days`
      $('d-clicks').className =
        'metric-delta ' + (pct === 0 ? 'metric-delta-quiet' : pct > 0 ? 'metric-delta-up' : 'metric-delta-down')
    } else {
      $('d-clicks').textContent = `in the last ${rangeDays} days`
      $('d-clicks').className = 'metric-delta metric-delta-quiet'
    }
  } else {
    $('d-clicks').textContent = 'all time'
    $('d-clicks').className = 'metric-delta metric-delta-quiet'
  }

  Charts.line($('chart-clicks'), points)

  $('top-links').innerHTML = stats.topLinks.length
    ? `<div class="tl-row tl-head"><span>Link</span><span>Clicks</span><span>Visitors</span></div>` +
      stats.topLinks
        .map(
          (l) => `<div class="tl-row">
            <span class="tl-main">
              <a class="tl-slug" href="/link?slug=${encodeURIComponent(l.slug)}">/${escapeHtml(l.slug)}</a>
              <span class="tl-url">${escapeHtml(l.title || String(l.url).replace(/^https?:\/\//, ''))}</span>
            </span>
            <span class="tl-metric">${num(l.clicks)}</span>
            <span class="tl-metric">${num(l.visitors)}</span>
          </div>`,
        )
        .join('')
    : '<div class="chart-empty">No links in this scope</div>'

  renderTiming()
  barList($('destinations'), topEntries(stats.destinations, 8))
  barList($('referrers'), topEntries(stats.referrers, 8))
  barList($('countries'), topEntries(stats.countries, 8), { flag: true })
  barList($('browsers'), topEntries(stats.browsers, 5))
  barList($('os'), topEntries(stats.os, 5))
  barList($('bots'), topEntries(stats.bots, 8))

  const deviceEntries = ['desktop', 'mobile', 'tablet'].map((k) => ({
    label: cap(k),
    value: stats.devices[k] || 0,
    color: DEVICE_COLORS[k],
  }))
  if (deviceEntries.some((d) => d.value > 0)) Charts.donut($('devices'), deviceEntries)
  else $('devices').innerHTML = '<div class="chart-empty">Nothing recorded yet</div>'
}

/* --------------------------------- loading -------------------------------- */

/** Per-link stats, fetched once per link and then reused. */
const statCache = new Map()

async function statsFor(slug) {
  if (statCache.has(slug)) return statCache.get(slug)
  const res = await fetch(`/api/links/${encodeURIComponent(slug)}/stats`)
  if (!res.ok) return null
  const data = await res.json()
  statCache.set(slug, data)
  return data
}

async function load() {
  const scoped = scopedLinks()
  const narrowed = Boolean($('scope').value || $('campaign').value)

  if (!narrowed) {
    // Everything: the server already aggregated this in one call.
    const res = await fetch('/api/stats')
    if (res.status === 401) return (window.location.href = '/login')
    const s = await res.json()
    stats = {
      clicks: s.totalClicks,
      botClicks: s.totalBotClicks || 0,
      visitors: s.uniqueVisitors,
      series: s.series || {},
      devices: s.devices || {},
      countries: s.countries || {},
      referrers: s.referrers || {},
      browsers: s.browsers || {},
      os: s.os || {},
      hours: s.hours || {},
      weekdays: s.weekdays || {},
      channels: s.channels || {},
      bots: {},
      destinations: {},
      topLinks: s.topLinks || [],
    }
    for (const l of links) {
      try {
        const host = new URL(l.url).hostname.replace(/^www\./, '')
        stats.destinations[host] = (stats.destinations[host] || 0) + (l.clicks || 0)
      } catch {
        /* skip */
      }
    }
    // Bot breakdown is per-link only, so fetch it for the busiest few rather
    // than every link the account owns.
    const busiest = [...links].sort((a, b) => (b.botClicks || 0) - (a.botClicks || 0)).slice(0, 10)
    for (const l of busiest) {
      if (!l.botClicks) continue
      const d = await statsFor(l.slug)
      for (const [k, n] of Object.entries(d?.bots || {})) stats.bots[k] = (stats.bots[k] || 0) + n
    }
  } else {
    const detailed = []
    for (const l of scoped) {
      const d = await statsFor(l.slug)
      if (d) detailed.push({ ...d, url: l.url, title: l.title, slug: l.slug })
    }
    stats = aggregate(detailed)
  }

  render()
}

async function loadLists() {
  const [linkRes, campRes] = await Promise.all([fetch('/api/links?limit=500'), fetch('/api/campaigns')])
  if (linkRes.status === 401) return (window.location.href = '/login')
  links = (await linkRes.json()).links || []
  campaigns = (await campRes.json()).campaigns || []

  $('scope').innerHTML =
    '<option value="">All links</option>' +
    [...links]
      .sort((a, b) => (b.clicks || 0) - (a.clicks || 0))
      .map((l) => `<option value="${escapeHtml(l.slug)}">/${escapeHtml(l.slug)} — ${escapeHtml(l.title || String(l.url).replace(/^https?:\/\//, '').slice(0, 40))}</option>`)
      .join('')

  $('campaign').innerHTML =
    '<option value="">All campaigns</option>' +
    campaigns.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('')
}

/* --------------------------------- wire up -------------------------------- */

$('range').addEventListener('click', (e) => {
  const btn = e.target.closest('button')
  if (!btn) return
  rangeDays = Number(btn.dataset.days)
  ;[...$('range').children].forEach((b) => b.classList.toggle('active', b === btn))
  render()
})

$('scope').addEventListener('change', () => {
  if ($('scope').value) $('campaign').value = ''
  load()
})
$('campaign').addEventListener('change', () => {
  if ($('campaign').value) $('scope').value = ''
  load()
})

;(async () => {
  const user = await window.shellReady
  if (!user) return
  await loadLists()

  // Deep links from the dashboard and campaigns pages preselect a scope.
  const params = new URLSearchParams(location.search)
  if (params.get('slug')) $('scope').value = params.get('slug')
  if (params.get('campaign')) $('campaign').value = params.get('campaign')

  await load()
})()
