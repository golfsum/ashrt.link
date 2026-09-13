const { $, api, num, escapeHtml, statusPill, toast } = window.Admin

let data = null

function kpi(label, value, sub) {
  return `<div class="card metric">
    <div class="label">${escapeHtml(label)}</div>
    <div class="value">${value}</div>
    ${sub ? `<div class="metric-sub">${sub}</div>` : ''}
  </div>`
}

function bars(entries, total) {
  const rows = entries.filter((e) => e.value > 0)
  if (!rows.length) return '<div class="chart-empty">Nothing yet</div>'
  const max = Math.max(...rows.map((e) => e.value), 1)
  return rows
    .map(
      (e) => `<div class="bar-row">
        <div class="bar-top">
          <span class="bar-label">${escapeHtml(e.label)}</span>
          <span class="bar-val">${num(e.value)}</span>
          <span class="bar-pct">${total ? Math.round((e.value / total) * 100) : 0}%</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${(e.value / max) * 100}%"></div></div>
      </div>`,
    )
    .join('')
}

const STATUS_LABELS = {
  none: 'No subscription',
  active: 'Active',
  trialing: 'Trialing',
  past_due: 'Past due',
  unpaid: 'Unpaid',
  canceled: 'Canceled',
  incomplete: 'Incomplete',
  incomplete_expired: 'Incomplete, expired',
}

function render() {
  $('disabled').hidden = data.enabled
  $('note').textContent = data.note

  const total = data.paid + data.free
  $('kpis').innerHTML = [
    kpi('Estimated MRR', `$${num(data.estimatedMrr)}`, 'plan price x active subscribers'),
    kpi('Estimated ARR', `$${num(data.estimatedArr)}`, 'MRR x 12'),
    kpi('Paid accounts', num(data.paid), `${data.conversionRate}% of all accounts`),
    kpi('Free accounts', num(data.free), `${num(total)} total`),
    kpi('Stripe customers', num(data.withCustomer), 'accounts with a customer record'),
    kpi('Needs attention', num(data.problems.length), 'failing or mismatched'),
  ].join('')

  $('plans').innerHTML = bars(
    [
      { label: `Free ($${data.prices.free}/mo)`, value: data.byPlan.free },
      { label: `Pro ($${data.prices.pro}/mo)`, value: data.byPlan.pro },
      { label: `Business ($${data.prices.business}/mo)`, value: data.byPlan.business },
    ],
    total,
  )

  const statusEntries = Object.entries(data.byStatus).map(([k, v]) => ({
    label: STATUS_LABELS[k] || k,
    value: v,
  }))
  $('statuses').innerHTML = bars(statusEntries, total)

  $('problem-count').textContent = data.problems.length
    ? `${num(data.problems.length)} account${data.problems.length === 1 ? '' : 's'}`
    : ''

  $('problems').innerHTML = data.problems.length
    ? `<div class="atable-row atable-head"><span>Account</span><span>Plan</span><span>Status</span><span>Problem</span><span></span></div>` +
      data.problems
        .map(
          (p) => `<div class="atable-row row-risky">
            <span class="at-main">
              <a class="at-title" href="/admin/user?id=${encodeURIComponent(p.id)}">${escapeHtml(p.email)}</a>
              <span class="at-sub mono">${escapeHtml(p.stripeCustomerId || 'no Stripe customer')}</span>
            </span>
            <span class="pill pill-plan-${escapeHtml(p.plan)}">${escapeHtml(p.plan)}</span>
            ${statusPill(p.status)}
            <span class="at-sub">${escapeHtml(p.reason)}</span>
            <span class="at-actions">
              ${p.stripeCustomerId
                ? `<a class="btn btn-sm btn-ghost" target="_blank" rel="noreferrer" href="https://dashboard.stripe.com/customers/${encodeURIComponent(p.stripeCustomerId)}">Open in Stripe</a>`
                : ''}
            </span>
          </div>`,
        )
        .join('')
    : '<div class="chart-empty">No failing payments and no accounts out of step with Stripe.</div>'
}

;(async () => {
  if (!(await window.adminReady)) return
  try {
    data = await api('/api/admin/billing')
    render()
  } catch (e) {
    toast(e.message, 'error')
  }
})()
