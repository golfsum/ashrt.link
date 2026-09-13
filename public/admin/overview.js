const { $, api, num, escapeHtml, timeAgo, statusPill } = window.Admin
let days = 30
let data = null

function seriesPoints(series) {
  return Object.entries(series)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({
      label: new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      value,
    }))
}

function kpi(label, value, sub) {
  return `<div class="card metric">
    <div class="label">${escapeHtml(label)}</div>
    <div class="value">${num(value)}</div>
    ${sub ? `<div class="metric-sub">${sub}</div>` : ''}
  </div>`
}

function bars(entries, total) {
  if (!entries.length) return '<div class="chart-empty">Nothing yet</div>'
  const max = Math.max(...entries.map((e) => e.value), 1)
  return entries
    .map(
      (e) => `<div class="bar-row">
        <div class="bar-top"><span class="bar-label">${e.label}</span>
          <span class="bar-val">${num(e.value)}</span>
          <span class="bar-pct">${total ? Math.round((e.value / total) * 100) : 0}%</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${(e.value / max) * 100}%"></div></div>
      </div>`,
    )
    .join('')
}

function render() {
  const u = data.users
  const l = data.links

  $('kpis').innerHTML = [
    kpi('Total users', u.total, `${num(u.today)} today · ${num(u.last7)} this week`),
    kpi('Total links', l.total, `${num(l.guest)} guest · ${num(l.owned)} in accounts`),
    kpi('Total clicks', data.clicks.total, `${num(data.clicks.today)} today`),
    kpi(`Clicks (${data.days}d)`, data.clicks.window, `${num(data.campaigns)} campaigns`),
    kpi('Paid accounts', data.billing.paid, data.billing.enabled ? 'Stripe connected' : 'Billing not configured'),
    kpi('Needs review', (l.flagged || 0) + (l.disabled || 0), `${num(l.flagged)} flagged · ${num(l.disabled)} disabled`),
  ].join('')

  Charts.line($('chart-clicks'), seriesPoints(data.series))

  // Plans partition the accounts, so they belong on one scale. Suspended and
  // admin cut across plans, so putting them in the same bar list would produce
  // percentages that do not add up to anything.
  $('accounts').innerHTML =
    bars(
      [
        { label: 'Free', value: u.free || 0 },
        { label: 'Pro', value: u.pro || 0 },
        { label: 'Business', value: u.business || 0 },
      ].filter((e) => e.value > 0),
      u.total,
    ) +
    `<div class="kv kv-inline">
      <div><span>Suspended</span><span>${num(u.suspended || 0)}</span></div>
      <div><span>Admins</span><span>${num(u.admin || 0)}</span></div>
      <div><span>New this month</span><span>${num(u.last30 || 0)}</span></div>
    </div>`

  $('linkstatus').innerHTML = bars(
    [
      { label: 'Active', value: l.active || 0 },
      { label: 'Flagged', value: l.flagged || 0 },
      { label: 'Disabled', value: l.disabled || 0 },
      { label: 'Expired', value: l.expired || 0 },
    ].filter((e) => e.value > 0),
    l.counted || l.total,
  )
}

async function renderAttention() {
  const abuse = await api('/api/admin/abuse?status=new')
  const items = []

  if (abuse.reports.length) {
    items.push(
      `<a class="attn-row" href="/admin/abuse">
        <span class="attn-count">${num(abuse.reports.length)}</span>
        <span>new abuse ${abuse.reports.length === 1 ? 'report' : 'reports'} waiting for review</span>
      </a>`,
    )
  }
  if (abuse.flagged.length) {
    items.push(
      `<a class="attn-row" href="/admin/links?status=flagged">
        <span class="attn-count">${num(abuse.flagged.length)}</span>
        <span>flagged ${abuse.flagged.length === 1 ? 'link' : 'links'} serving a warning page</span>
      </a>`,
    )
  }

  const broken = data?.brokenLinksTotal || 0
  if (broken) {
    items.push(
      `<a class="attn-row" href="/admin/links">
        <span class="attn-count">${num(broken)}</span>
        <span>link ${broken === 1 ? 'destination has' : 'destinations have'} stopped answering
          (${(data.brokenLinks || []).slice(0, 3).map((b) => escapeHtml(b.slug)).join(', ')}${broken > 3 ? ', …' : ''})</span>
      </a>`,
    )
  }

  // Domains where the customer has done everything and we have not.
  const waiting = data?.domainsWaiting || []
  if (waiting.length) {
    items.push(
      `<a class="attn-row" href="/admin/users">
        <span class="attn-count">${num(waiting.length)}</span>
        <span>custom ${waiting.length === 1 ? 'domain' : 'domains'} verified and waiting to be attached
          (${waiting.slice(0, 3).map((d) => escapeHtml(d.domain)).join(', ')}${waiting.length > 3 ? ', …' : ''})</span>
      </a>`,
    )
  }

  $('attention').innerHTML = items.length
    ? items.join('')
    : '<div class="chart-empty">Nothing needs attention. No open reports, no flagged links.</div>'
}

async function load() {
  data = await api(`/api/admin/overview?days=${days}`)
  render()
  await renderAttention()
}

$('range').addEventListener('click', (e) => {
  const btn = e.target.closest('button')
  if (!btn) return
  days = Number(btn.dataset.days)
  ;[...$('range').children].forEach((b) => b.classList.toggle('active', b === btn))
  load()
})

;(async () => {
  if (!(await window.adminReady)) return
  await load()
})()
