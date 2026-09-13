const { $, api, num, escapeHtml, toast } = window.Admin

let days = 30
let data = null

const SOURCE_LABELS = {
  google: 'Google',
  bing: 'Bing',
  duckduckgo: 'DuckDuckGo',
  'search-other': 'Other search',
  social: 'Social',
  email: 'Email',
  referral: 'Referral',
  direct: 'Direct / none',
  internal: 'Internal',
}

const SEARCH_SOURCES = new Set(['google', 'bing', 'duckduckgo', 'search-other'])

function sourceRows(map, total) {
  const rows = Object.entries(map || {})
    .map(([k, v]) => ({ label: SOURCE_LABELS[k] || k, key: k, value: v }))
    .sort((a, b) => b.value - a.value)
  if (!rows.length) return '<div class="chart-empty">Nothing recorded yet</div>'
  const max = Math.max(...rows.map((r) => r.value), 1)
  return rows
    .map(
      (r) => `<div class="bar-row">
        <div class="bar-top">
          <span class="bar-label">${escapeHtml(r.label)}</span>
          <span class="bar-val">${num(r.value)}</span>
          <span class="bar-pct">${total ? Math.round((r.value / total) * 100) : 0}%</span>
        </div>
        <div class="bar-track"><div class="bar-fill ${SEARCH_SOURCES.has(r.key) ? 'bar-fill-search' : ''}" style="width:${(r.value / max) * 100}%"></div></div>
      </div>`,
    )
    .join('')
}

function renderFunnel() {
  const stages = data.funnel
  const top = stages[0].count || 1

  $('funnel').innerHTML = stages
    .map((s, i) => {
      const width = Math.max((s.count / top) * 100, s.count ? 2 : 0)
      let rate = ''
      if (i > 0) {
        rate = s.enoughData
          ? `<span class="funnel-rate">${s.rate}% of those who ${s.of.toLowerCase()}</span>`
          : `<span class="funnel-rate funnel-rate-quiet">not enough data above to give a rate</span>`
      }
      return `<div class="funnel-stage">
        <div class="funnel-head">
          <span class="funnel-label">${escapeHtml(s.label)}</span>
          <span class="funnel-count">${num(s.count)}</span>
        </div>
        <div class="funnel-bar"><div class="funnel-fill" style="width:${width}%"></div></div>
        ${rate}
      </div>`
    })
    .join('')
}

function renderSources() {
  const arrivals = data.acquisition.arrivals
  const signups = data.acquisition.signups
  const subs = data.acquisition.subscriptions

  const arrivalTotal = Object.values(arrivals).reduce((s, n) => s + n, 0)
  const signupTotal = Object.values(signups).reduce((s, n) => s + n, 0)
  const subTotal = Object.values(subs).reduce((s, n) => s + n, 0)

  $('arrivals').innerHTML = sourceRows(arrivals, arrivalTotal)
  $('signup-sources').innerHTML = sourceRows(signups, signupTotal)
  $('sub-sources').innerHTML = subTotal
    ? sourceRows(subs, subTotal)
    : '<div class="chart-empty">No subscriptions recorded in this window.</div>'

  // The single number the repositioning was for.
  const searchArrivals = Object.entries(arrivals)
    .filter(([k]) => SEARCH_SOURCES.has(k))
    .reduce((s, [, n]) => s + n, 0)
  const searchSignups = Object.entries(signups)
    .filter(([k]) => SEARCH_SOURCES.has(k))
    .reduce((s, [, n]) => s + n, 0)

  $('search-verdict').innerHTML =
    searchArrivals >= 20
      ? `<div class="verdict">
           <div class="verdict-num">${(Math.round((searchSignups / searchArrivals) * 1000) / 10).toFixed(1)}%</div>
           <div class="verdict-text">
             of search visitors created an account
             (<b>${num(searchSignups)}</b> from <b>${num(searchArrivals)}</b> arrivals in ${data.days} days)
           </div>
         </div>`
      : `<div class="verdict verdict-quiet">
           <div class="verdict-text">
             <b>${num(searchArrivals)}</b> search ${searchArrivals === 1 ? 'arrival' : 'arrivals'} in ${data.days} days.
             Too few to put a conversion rate on yet; this fills in as the pages get indexed.
           </div>
         </div>`
}

function renderEvents() {
  const rows = Object.entries(data.totals).sort((a, b) => b[1] - a[1])
  $('events').innerHTML = rows.length
    ? `<div class="atable-row atable-head"><span>Event</span><span>Count</span></div>` +
      rows
        .map(
          ([name, count]) => `<div class="atable-row">
            <span class="at-main"><span class="at-title mono">${escapeHtml(name)}</span></span>
            <span class="num">${num(count)}</span>
          </div>`,
        )
        .join('')
    : '<div class="chart-empty">No events recorded yet. They start accumulating once this is deployed.</div>'
}

function renderChart() {
  const points = data.dayKeys.map((d) => ({
    label: new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    value: (data.series[d]?.page_view_home || 0) + (data.series[d]?.page_view_landing || 0),
  }))
  Charts.line($('chart-visitors'), points)

  const signupPoints = data.dayKeys.map((d) => ({
    label: new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    value: data.series[d]?.signup_completed || 0,
  }))
  Charts.line($('chart-signups'), signupPoints)
}

async function load() {
  data = await api(`/api/admin/funnel?days=${days}`)
  renderFunnel()
  renderSources()
  renderEvents()
  renderChart()
}

$('range').addEventListener('click', (e) => {
  const btn = e.target.closest('button')
  if (!btn) return
  days = Number(btn.dataset.days)
  ;[...$('range').children].forEach((b) => b.classList.toggle('active', b === btn))
  load().catch((err) => toast(err.message))
})

;(async () => {
  if (!(await window.adminReady)) return
  await load()
})()
