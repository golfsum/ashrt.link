/**
 * The pricing page renders from the server's own entitlements.
 *
 * Every number here is the number the API enforces, read from /api/plans at
 * load. A hand-written pricing table drifts from the code within a month, and
 * then the page is quietly lying about what someone is buying.
 */

const $ = (id) => document.getElementById(id)

const num = (n) => Number(n).toLocaleString()

/** null means unlimited: the API sends null rather than Infinity, which JSON has no word for. */
const amount = (v, suffix = '') => (v === null ? 'Unlimited' : `${num(v)}${suffix}`)

const FEATURE_LABELS = {
  customAlias: 'Custom short codes',
  campaigns: 'Campaigns',
  utm: 'UTM builder',
  tags: 'Tags',
  brandedQr: 'QR design (colours, styles, logo)',
  customDomains: 'Your own domain',
  expiry: 'Link expiry',
}

/** The order they are worth reading in, not the order the object happens to use. */
const FEATURE_ORDER = [
  'customDomains',
  'brandedQr',
  'expiry',
  'customAlias',
  'campaigns',
  'utm',
  'tags',
]

const BLURBS = {
  free: 'Enough to run a real project on, not enough to see a screenshot.',
  pro: 'Your own domain, designed QR codes, and room to stop counting.',
  business: 'More domains, the largest allowance, and the highest API quota.',
}

function planCard(plan, { featured }) {
  const limits = plan.limits || {}
  const rows = [
    ['New links', amount(limits.linksPerMonth, ' / 30 days')],
    ['Links kept', amount(limits.links)],
    ['Campaigns', amount(limits.campaigns)],
    ['Custom domains', limits.domains ? num(limits.domains) : 'Not included'],
    ['API calls', amount(limits.apiPerDay, ' / day')],
  ]

  const features = FEATURE_ORDER.filter((k) => k in (plan.features || {})).map((key) => {
    const on = plan.features[key]
    return `<li class="${on ? 'on' : 'off'}"><span aria-hidden="true">${on ? '✓' : '·'}</span> ${FEATURE_LABELS[key] || key}</li>`
  })

  return `<article class="price-card${featured ? ' price-card-featured' : ''}">
      ${featured ? '<div class="price-tag">Most people start here</div>' : ''}
      <h2>${plan.label}</h2>
      <div class="price-amount">${plan.priceLabel}</div>
      <p class="price-blurb">${BLURBS[plan.id] || ''}</p>
      <a class="btn ${featured ? '' : 'btn-ghost'} price-cta" href="${plan.id === 'free' ? '/signup' : '/account'}">
        ${plan.id === 'free' ? 'Start free' : `Choose ${plan.label}`}
      </a>
      <dl class="price-limits">
        ${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}
      </dl>
      <ul class="price-features">${features.join('')}</ul>
    </article>`
}

async function load() {
  let plans = []
  try {
    const res = await fetch('/api/plans')
    plans = (await res.json()).plans || []
  } catch {
    $('plans').innerHTML =
      '<p class="chart-empty">Could not load the plans just now. Reload, or see them on the <a href="/account">account page</a>.</p>'
    return
  }

  $('plans').innerHTML = plans.map((p) => planCard(p, { featured: p.id === 'pro' })).join('')
}

/** The same nav the other public pages use. */
async function nav() {
  let user = null
  try {
    const res = await fetch('/auth/me')
    if (res.ok) user = (await res.json()).user
  } catch {
    /* anonymous is the normal case here */
  }
  $('nav').innerHTML = user
    ? '<a href="/dashboard">Dashboard</a><a href="/account">Account</a>'
    : '<a href="/login">Log in</a><a class="btn btn-sm" href="/signup">Get started</a>'
}

load()
nav()
