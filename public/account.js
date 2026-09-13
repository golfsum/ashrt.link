/**
 * Billing.
 *
 * Two questions this page has to answer honestly: what am I paying for, and
 * how much of it have I used. Both come from the server — the usage numbers are
 * read from the same counters that enforce the limits, so the bar on this page
 * and the refusal you get at the limit can never disagree.
 */

const $ = (id) => document.getElementById(id)

const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1)
const num = (n) => Number(n).toLocaleString()

/** "in 12 days", "tomorrow", "in 4 hours" — whichever is true. */
function until(ts) {
  if (!ts) return ''
  const ms = ts - Date.now()
  if (ms <= 0) return 'now'
  const days = Math.round(ms / 86400000)
  if (days >= 2) return `in ${days} days`
  const hours = Math.round(ms / 3600000)
  if (hours >= 2) return `in ${hours} hours`
  return 'within the hour'
}

/**
 * One meter.
 *
 * An unlimited allowance gets a number and no bar, because a bar with nothing
 * to fill is a decoration that implies a limit nobody has.
 */
function meter({ label, used, limit, resetAt, note }) {
  // Nothing to meter: this plan does not include the thing at all, and a
  // "0 / 0" bar reads like a bug rather than an answer.
  if (limit === 0) {
    return `<div class="usage-item">
      <div class="usage-top"><span class="usage-label">${label}</span><span class="usage-count">—</span></div>
      <div class="usage-note">Not included on this plan</div>
    </div>`
  }
  if (limit === null || limit === undefined) {
    return `<div class="usage-item">
      <div class="usage-top"><span class="usage-label">${label}</span><span class="usage-count">${num(used)}</span></div>
      <div class="usage-note">Unlimited on this plan</div>
    </div>`
  }
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 100
  const level = used >= limit ? 'full' : pct >= 80 ? 'near' : ''
  const left = Math.max(0, limit - used)
  const tail =
    note ||
    (used >= limit
      ? `None left${resetAt ? `, resets ${until(resetAt)}` : ''}`
      : resetAt
        ? `${num(left)} left, resets ${until(resetAt)}`
        : `${num(left)} left`)
  return `<div class="usage-item">
    <div class="usage-top">
      <span class="usage-label">${label}</span>
      <span class="usage-count">${num(used)} / ${num(limit)}</span>
    </div>
    <div class="usage-bar"><div class="usage-fill ${level}" style="width:${pct}%"></div></div>
    <div class="usage-note">${tail}</div>
  </div>`
}

const STATUS_NOTE = {
  past_due: 'Your last payment did not go through. Update your card to keep your plan.',
  canceled: 'Your subscription has ended. Everything you made is still here.',
  incomplete: 'Your subscription is not finished setting up yet.',
  unpaid: 'There is an unpaid invoice on this subscription.',
}

async function load() {
  const [acc, use] = await Promise.all([
    fetch('/api/account').then((r) => (r.ok ? r.json() : null)),
    fetch('/api/usage/summary').then((r) => (r.ok ? r.json() : null)),
  ])
  if (!acc) return (window.location.href = '/login')

  const u = acc.user
  $('email').textContent = u.email
  $('provider').textContent = u.provider === 'password' ? 'Email & password' : cap(u.provider)
  $('plan').textContent = cap(u.plan || 'free')
  if ((u.plan || 'free') !== 'free') $('plan').classList.add('pro')

  banner(u)
  if (use) renderUsage(use)
  await renderPlans(u)
}

/** What just happened, if the person has come back from Stripe. */
function banner(u) {
  const q = new URLSearchParams(location.search)
  const el = $('billing-banner')
  const upgraded = q.get('upgraded')
  const cancelled = q.get('checkout') === 'cancelled'
  const status = u.subscriptionStatus

  if (upgraded) {
    el.textContent = `You are on ${cap(upgraded)}. It may take a few seconds for everything to switch over — reload if something still looks like the old plan.`
  } else if (cancelled) {
    el.textContent = 'Checkout was cancelled, so nothing was charged. Your plan has not changed.'
  } else if (status && STATUS_NOTE[status]) {
    el.textContent = STATUS_NOTE[status]
  } else {
    return
  }
  el.hidden = false
}

function renderUsage(use) {
  const period = use.links.resetAt ? ` Allowance resets ${until(use.links.resetAt)}.` : ''
  $('billing-note').textContent =
    `${use.planLabel}${use.interval ? `, billed ${use.interval === 'annual' ? 'yearly' : 'monthly'}` : ''}` +
    `${use.price && use.price.monthly ? ` at ${use.price.label}` : ''}.` +
    period

  $('usage').innerHTML = [
    meter({ label: 'New links this period', used: use.links.used, limit: use.links.limit, resetAt: use.links.resetAt }),
    meter({ label: 'QR downloads', used: use.qrDownloads.used, limit: use.qrDownloads.limit, resetAt: use.qrDownloads.resetAt }),
    meter({ label: 'Campaigns', used: use.campaigns.used, limit: use.campaigns.limit }),
    meter({ label: 'Custom domains', used: use.domains.used, limit: use.domains.limit }),
    meter({ label: 'API requests today', used: use.api.used, limit: use.api.limit }),
    // Not a quota, and said so: this is the number the plan does not touch.
    meter({
      label: 'Links live',
      used: use.linksKept,
      limit: null,
      note: 'Links you have already made keep working on every plan',
    }),
  ].join('')

  const manage = $('manage')
  if (use.subscriptionStatus && use.plan !== 'free') {
    manage.hidden = false
    manage.onclick = openPortal
  }
}

async function renderPlans(u) {
  const wrap = $('plan-options')
  try {
    const data = await Plans.load()
    const me = { plan: u.plan || 'free' }
    wrap.innerHTML = `${Plans.toggleHtml(data)}<div class="price-grid">${data.plans
      .map((p) => Plans.card(p, { user: me, interval: Plans.interval, data, limit: 6, blurb: false }))
      .join('')}</div>`
    Plans.wire(document)

    // Arriving from "Choose Pro" on a public page: open that checkout rather
    // than making somebody find the same button a second time.
    const wanted = new URLSearchParams(location.search).get('upgrade')
    if (wanted && wanted !== me.plan) {
      wrap.querySelector(`[data-plan-action="checkout"][data-plan="${wanted}"]`)?.click()
    }
  } catch {
    wrap.innerHTML = '<p class="panel-sub">Could not load the plans just now. <a href="/pricing">See pricing</a>.</p>'
  }
}

document.addEventListener('plans:interval', async () => {
  const acc = await fetch('/api/account').then((r) => (r.ok ? r.json() : null))
  if (acc) renderPlans(acc.user)
})

async function openPortal() {
  const btn = $('manage')
  btn.disabled = true
  btn.textContent = 'Opening...'
  try {
    const res = await fetch('/api/billing/portal', { method: 'POST' })
    const data = await res.json()
    if (data.url) return (window.location.href = data.url)
    window.toast(data.error || 'Could not open the billing portal')
  } catch {
    window.toast('Could not open the billing portal')
  } finally {
    btn.disabled = false
    btn.textContent = 'Manage subscription'
  }
}

;(async () => {
  const user = await window.shellReady
  if (!user) return
  await load()
})()
