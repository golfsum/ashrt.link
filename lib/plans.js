/**
 * The single source of truth for plans: names, prices, Stripe ids, limits and
 * feature entitlements.
 *
 * Everything that talks about a plan reads from this file — the API, the
 * dashboard, the pricing page, the homepage, billing, the admin reports and the
 * rate limiter. Nothing anywhere else may hardcode "$9", "250 links" or
 * `user.plan === 'business'`. If a number appears twice, one of them is wrong,
 * and the one that is wrong is always the copy.
 *
 * Two rules this file exists to keep:
 *
 *   1. Entitlements are enforced server-side. Hiding a button is a courtesy,
 *      never a control.
 *   2. We do not advertise what we do not enforce, and we do not enforce what
 *      we do not advertise. Anything named in UNRELEASED_FEATURES below is a
 *      flag the server honours but the marketing pages never mention, so the
 *      pricing table can never promise something that is not built yet.
 */

/** Plans that require an active Stripe subscription. */
export const PAID_PLANS = ['pro', 'business']

/** Every plan id, cheapest first. */
export const PLAN_IDS = ['free', 'pro', 'business']

/** Billing intervals we sell. */
export const INTERVALS = ['monthly', 'annual']

/**
 * Stripe ids, read at call time rather than at import.
 *
 * They live in the environment because they differ between the test and live
 * Stripe accounts, but the *mapping* from plan and interval to id lives here so
 * there is still one place to look. A plan whose id is unset is simply not
 * purchasable: the UI says so instead of sending anyone to a broken checkout.
 */
const STRIPE_ENV = {
  pro: {
    product: 'STRIPE_PRODUCT_PRO',
    monthly: ['STRIPE_PRICE_PRO', 'STRIPE_PRICE_ID'],
    annual: ['STRIPE_PRICE_PRO_ANNUAL'],
  },
  business: {
    product: 'STRIPE_PRODUCT_BUSINESS',
    monthly: ['STRIPE_PRICE_BUSINESS'],
    annual: ['STRIPE_PRICE_BUSINESS_ANNUAL'],
  },
}

const fromEnv = (names) => {
  for (const n of names || []) {
    const v = process.env[n]
    if (v) return v
  }
  return ''
}

/** The Stripe Price id for a plan and interval, or '' when it is not set up. */
export function stripePriceId(planId, interval = 'monthly') {
  const spec = STRIPE_ENV[planId]
  if (!spec) return ''
  return fromEnv(spec[interval === 'annual' ? 'annual' : 'monthly'])
}

/** The Stripe Product id for a plan, when one is configured. Informational. */
export const stripeProductId = (planId) => fromEnv([STRIPE_ENV[planId]?.product])

/**
 * The plans.
 *
 * `limits` are numbers (Infinity means unlimited). `features` are booleans.
 * Both are read through limitFor() / can() so a missing key is a loud zero
 * rather than a quiet undefined.
 */
export const PLANS = {
  free: {
    id: 'free',
    label: 'Free',
    blurb: 'Enough to run a real project on, with the analytics that usually cost money.',
    price: { monthly: 0, annual: 0 },
    limits: {
      // No lifetime cap on any plan. A link you already published keeps
      // working forever; the allowance is on *making* new ones. Nobody has to
      // delete last quarter's links to make room for this week's, and nobody
      // loses a printed link by downgrading.
      links: Infinity,
      linksPerMonth: 10,
      createPerHour: 10,
      campaigns: 1,
      domains: 0,
      apiPerDay: 25,
      analyticsDays: 30,
      qrPerMonth: 10,
      // Just enough to undo a mistake: the destination you had before this one.
      destinationHistory: 1,
      bulkRows: 0,
      routingRules: 0,
    },
    features: {
      customAlias: true,
      campaigns: true,
      utm: true,
      tags: true,
      basicQr: true,
      brandedQr: false,
      customDomains: false,
      expiry: false,
      scheduling: false,
      smartRouting: false,
      bulkCreate: false,
      csvExport: false,
      healthMonitoring: false,
      webhooks: false,
      conversionTracking: false,
    },
  },

  pro: {
    id: 'pro',
    label: 'Pro',
    blurb: 'Your own domain on every link, and the tools for links that go out in public.',
    price: { monthly: 9, annual: 86 },
    limits: {
      links: Infinity,
      linksPerMonth: 250,
      createPerHour: 300,
      campaigns: 25,
      domains: 1,
      apiPerDay: 1000,
      analyticsDays: 400,
      qrPerMonth: 250,
      destinationHistory: 10,
      bulkRows: 250,
      routingRules: 5,
    },
    features: {
      customAlias: true,
      campaigns: true,
      utm: true,
      tags: true,
      basicQr: true,
      brandedQr: true,
      // A branded domain is the first thing someone paying for a link tool
      // wants. Putting it two tiers up is the complaint we are answering.
      customDomains: true,
      expiry: true,
      scheduling: true,
      smartRouting: true,
      bulkCreate: true,
      csvExport: true,
      healthMonitoring: true,
      webhooks: false,
      conversionTracking: false,
    },
  },

  business: {
    id: 'business',
    label: 'Business',
    blurb: 'Several domains, routing without a rule budget, and webhooks into your own systems.',
    price: { monthly: 29, annual: 278 },
    limits: {
      links: Infinity,
      linksPerMonth: 2500,
      createPerHour: 1200,
      campaigns: Infinity,
      domains: 5,
      apiPerDay: 10000,
      analyticsDays: 730,
      qrPerMonth: 2500,
      destinationHistory: 50,
      bulkRows: 1000,
      routingRules: 20,
    },
    features: {
      customAlias: true,
      campaigns: true,
      utm: true,
      tags: true,
      basicQr: true,
      brandedQr: true,
      customDomains: true,
      expiry: true,
      scheduling: true,
      smartRouting: true,
      bulkCreate: true,
      csvExport: true,
      healthMonitoring: true,
      webhooks: true,
      conversionTracking: true,
    },
  },
}

/**
 * Entitlements for somebody with no account. Deliberately narrow: a random
 * slug, a link that expires unless claimed, tight creation limits. Guests get
 * the product's core value (a trackable link plus its stats) and nothing that
 * costs us namespace or storage permanently.
 */
export const GUEST = {
  id: 'guest',
  label: 'Guest',
  limits: {
    // Per browser, via a signed guest cookie.
    createPerHour: 5,
    createPerDay: 15,
    // Per IP, as a ceiling. Deliberately much higher than the per-browser
    // limit: offices, schools and mobile carriers put many real people behind
    // one address, and locking them out of the first useful action is worse
    // than the abuse this stops. Clearing cookies gets you a fresh browser
    // budget but still runs into this.
    ipPerHour: 20,
    ipPerDay: 60,
    // Every creation attempt, valid or not, so probing is not free.
    attemptsPerHour: 60,
    linkTtlDays: 30,
    analyticsDays: 30,
    destinationHistory: 0,
    qrPerMonth: Infinity,
    routingRules: 0,
    bulkRows: 0,
  },
  features: {
    customAlias: false,
    campaigns: false,
    utm: true,
    tags: false,
    basicQr: true,
    brandedQr: false,
    customDomains: false,
    expiry: false,
    scheduling: false,
    smartRouting: false,
    bulkCreate: false,
    csvExport: false,
    healthMonitoring: false,
    webhooks: false,
    conversionTracking: false,
  },
}

/**
 * Features the server already gates but that nothing has been built for yet.
 *
 * The entitlement is real — a Business account passes the check — but the
 * pricing page, homepage and plan API leave it out entirely, because a feature
 * table is a promise and this one is not ready to be made. Delete the entry
 * here on the day the feature ships; nothing else needs to change.
 */
export const UNRELEASED_FEATURES = new Set(['conversionTracking'])

/* ------------------------------- presentation ----------------------------- */

const money = (n) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`)

/** What a plan costs, in every form the UI needs to print it. */
export function priceOf(planId) {
  const p = PLANS[planId]
  if (!p) return null
  const { monthly, annual } = p.price
  const perMonthOnAnnual = annual ? Math.round((annual / 12) * 100) / 100 : 0
  const saving = monthly ? Math.round((1 - annual / (monthly * 12)) * 100) : 0
  return {
    monthly,
    annual,
    perMonthOnAnnual,
    savingPercent: saving,
    monthlyLabel: money(monthly),
    annualLabel: money(annual),
    perMonthOnAnnualLabel: money(perMonthOnAnnual),
    // Kept because a lot of copy wants the one-line form.
    label: monthly ? `${money(monthly)}/mo` : '$0/mo',
  }
}

/** The button, so no page invents its own wording. */
export const CTA_LABEL = { free: 'Start free', pro: 'Choose Pro', business: 'Choose Business' }

/** The one plan we mark as the common choice. */
export const FEATURED_PLAN = 'pro'

/**
 * The comparison table, defined once.
 *
 * Rows are rendered by the pricing page, summarised by the homepage and used by
 * the audit script, so a feature can never appear in one place and not another.
 * `kind` says where the value comes from: a number from `limits`, a boolean
 * from `features`, or a fixed value that is true of every plan.
 */
export const MATRIX = [
  {
    group: 'Links',
    rows: [
      { key: 'linksPerMonth', kind: 'limit', label: 'New links per 30 days', short: '{v} new links a month' },
      { key: 'links', kind: 'limit', label: 'Links kept and redirecting', unlimited: 'Unlimited, forever', short: 'Every link you make keeps working' },
      { key: 'customAlias', kind: 'feature', label: 'Custom short codes' },
      { key: 'editableDestination', kind: 'always', label: 'Change a destination after sharing' },
      { key: 'destinationHistory', kind: 'limit', label: 'Destinations you can roll back to', zero: 'None', short: 'Roll back the last {v} destinations', shortOne: 'Undo the last destination change' },
      { key: 'noInterstitial', kind: 'always', label: 'Direct redirect, no ads or interstitial' },
      { key: 'expiry', kind: 'feature', label: 'Link expiry' },
      { key: 'scheduling', kind: 'feature', label: 'Scheduled go-live' },
      { key: 'bulkRows', kind: 'limit', label: 'Rows per bulk import', zero: 'Not included', short: 'Bulk import, {v} rows at a time' },
      { key: 'routingRules', kind: 'limit', label: 'Smart routing rules per link', zero: 'Not included', short: 'Smart routing by country and device, {v} rules per link' },
    ],
  },
  {
    group: 'Branding',
    rows: [
      { key: 'domains', kind: 'limit', label: 'Custom branded domains', zero: 'Not included', short: '{v} custom branded domains' },
      { key: 'basicQr', kind: 'feature', label: 'QR code for every link' },
      { key: 'brandedQr', kind: 'feature', label: 'Branded QR: colours, logo, shapes' },
      { key: 'qrPerMonth', kind: 'limit', label: 'QR downloads per month', short: '{v} QR downloads a month' },
    ],
  },
  {
    group: 'Analytics',
    rows: [
      { key: 'clickAnalytics', kind: 'always', label: 'Clicks, unique visitors, referrers' },
      { key: 'geoDevice', kind: 'always', label: 'Country, device, browser and OS' },
      { key: 'botFiltering', kind: 'always', label: 'Bot and link-preview filtering' },
      { key: 'analyticsDays', kind: 'limit', label: 'Analytics history', unit: 'days', short: '{v} days of analytics history' },
      { key: 'campaigns', kind: 'limit', label: 'Campaigns', short: '{v} campaigns' },
      { key: 'utm', kind: 'feature', label: 'UTM builder' },
      { key: 'tags', kind: 'feature', label: 'Tags' },
      { key: 'csvExport', kind: 'feature', label: 'CSV export' },
    ],
  },
  {
    group: 'Automation',
    rows: [
      { key: 'apiPerDay', kind: 'limit', label: 'API requests per day', short: '{v} API requests a day' },
      { key: 'healthMonitoring', kind: 'feature', label: 'Destination health monitoring' },
      { key: 'webhooks', kind: 'feature', label: 'Webhooks' },
      { key: 'conversionTracking', kind: 'feature', label: 'Conversion tracking' },
    ],
  },
]

/** Rows the marketing pages may show: everything except unreleased features. */
export const visibleMatrix = () =>
  MATRIX.map((g) => ({
    group: g.group,
    rows: g.rows.filter((r) => !(r.kind === 'feature' && UNRELEASED_FEATURES.has(r.key))),
  })).filter((g) => g.rows.length)

/**
 * The order the card bullets are worth reading in.
 *
 * The comparison table is ordered by subject; a card is ordered by what makes
 * somebody choose that plan. Keys missing from this list fall to the end in
 * table order, so adding a row to MATRIX can never make a card go blank.
 */
export const HIGHLIGHT_ORDER = [
  'linksPerMonth',
  'domains',
  'brandedQr',
  'routingRules',
  'analyticsDays',
  'csvExport',
  'webhooks',
  'conversionTracking',
  'healthMonitoring',
  'campaigns',
  'basicQr',
  'qrPerMonth',
  'bulkRows',
  'expiry',
  'scheduling',
  'destinationHistory',
  'apiPerDay',
  'links',
  'customAlias',
  'utm',
  'tags',
]

/**
 * The short list under each plan card: what this tier adds over the one below.
 * Derived, not written out, so it cannot drift from the entitlements above.
 */
export function upgradeHighlights(planId) {
  const idx = PLAN_IDS.indexOf(planId)
  const plan = PLANS[planId]
  if (!plan) return []
  const below = idx > 0 ? PLANS[PLAN_IDS[idx - 1]] : null
  const out = []

  const rank = (row) => {
    const i = HIGHLIGHT_ORDER.indexOf(row.key)
    return i === -1 ? HIGHLIGHT_ORDER.length : i
  }
  const rows = visibleMatrix()
    .flatMap((g) => g.rows)
    .sort((a, b) => rank(a) - rank(b))

  {
    for (const row of rows) {
      if (row.kind === 'always') continue

      if (row.kind === 'feature') {
        if (!plan.features[row.key]) continue
        // Only what this tier *adds*: a card that repeats the tier below is
        // a wall of ticks nobody reads.
        if (below && below.features[row.key]) continue
        out.push(row.label)
        continue
      }

      const mine = plan.limits[row.key]
      // A limit of zero is the absence of a feature, not a selling point.
      if (!mine) continue
      if (below && mine <= below.limits[row.key]) continue
      if (!row.short) continue
      if (mine === 1 && row.shortOne) { out.push(row.shortOne); continue }
      const shown = mine === Infinity ? 'Unlimited' : mine.toLocaleString('en-US')
      let line = row.short.replace('{v}', shown)
      // "1 custom branded domains" is the kind of thing people notice.
      if (mine === 1) line = line.replace(/\b(domain|link|campaign|rule|row|destination)s\b/g, '$1')
      out.push(line)
    }
  }
  return out
}

/** One cell of the comparison table, already formatted for display. */
export function valueFor(planId, row) {
  const plan = PLANS[planId]
  if (!plan) return '—'
  if (row.kind === 'always') return 'Included'
  if (row.kind === 'feature') return plan.features[row.key] ? 'Included' : 'Not included'
  const v = plan.limits[row.key]
  if (v === Infinity) return row.unlimited || 'Unlimited'
  if (!v) return row.zero || '0'
  const n = v.toLocaleString('en-US')
  return row.unit ? `${n} ${row.unit}` : n
}

/* -------------------------------- lookups --------------------------------- */

/** Normalize whatever is on the user record into a known plan id. */
export function planIdOf(user) {
  const id = user?.plan
  return PLAN_IDS.includes(id) ? id : 'free'
}

/** The plan object for a user (or GUEST when there is no user). */
export function planFor(user) {
  if (!user) return GUEST
  return PLANS[planIdOf(user)]
}

export function isPaid(user) {
  return PAID_PLANS.includes(planIdOf(user))
}

/**
 * Numeric limit for a user (or guest). Returns Infinity for unlimited so
 * callers can compare with `>=` without special-casing.
 */
export function limitFor(user, key) {
  const plan = planFor(user)
  const v = plan.limits?.[key]
  return v === undefined ? 0 : v
}

/** Whether a user (or guest) is entitled to a named feature. */
export function can(user, feature) {
  return Boolean(planFor(user).features?.[feature])
}

/** The cheapest plan that includes a feature, for "upgrade to X" messages. */
export function cheapestPlanWith(feature) {
  return PLAN_IDS.find((id) => PLANS[id].features?.[feature]) || null
}

/** The cheapest plan whose numeric limit reaches `want`. */
export function cheapestPlanFor(key, want) {
  return PLAN_IDS.find((id) => PLANS[id].limits?.[key] >= want) || null
}

/**
 * Feature check that produces an HTTP-shaped refusal, so routes stay one-liners:
 *   const deny = requireFeature(req.user, 'customDomains')
 *   if (deny) return res.status(deny.status).json(deny.body)
 *
 * The message names the plan that actually includes it and what it costs, so
 * the client never has to guess which upgrade to offer.
 */
export function requireFeature(user, feature, label) {
  if (can(user, feature)) return null
  const name = label || feature
  if (!user) {
    return {
      status: 401,
      body: { error: `Create a free account to use ${name}.`, needsAccount: true, feature },
    }
  }
  const need = cheapestPlanWith(feature)
  const plan = need ? PLANS[need] : null
  return {
    status: 402,
    body: {
      error: plan
        ? `${name} is part of ${plan.label}, ${priceOf(need).label}.`
        : `${name} is not available on your plan.`,
      needsUpgrade: true,
      feature,
      upgradeTo: need,
    },
  }
}

/**
 * Numeric-limit refusal, in the same shape, so "you have used all of them"
 * always reads the same way and always names the next tier up.
 */
export function requireHeadroom(user, key, used, { noun = 'items' } = {}) {
  const cap = limitFor(user, key)
  if (!Number.isFinite(cap) || used < cap) return null
  const need = cheapestPlanFor(key, cap + 1)
  const plan = need && need !== planIdOf(user) ? PLANS[need] : null
  return {
    status: 402,
    body: {
      error: plan
        ? `You have used all ${cap.toLocaleString('en-US')} ${noun} on your plan. ${plan.label} (${priceOf(need).label}) includes ${plan.limits[key] === Infinity ? 'unlimited' : plan.limits[key].toLocaleString('en-US')}.`
        : `You have used all ${cap.toLocaleString('en-US')} ${noun} on your plan.`,
      needsUpgrade: true,
      limit: cap,
      upgradeTo: need,
    },
  }
}

/* ------------------------------ public shape ------------------------------ */

const jsonLimits = (limits) =>
  Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, v === Infinity ? null : v]))

/**
 * Everything a page needs to render a plan, so no page keeps its own table.
 *
 * `available` reports whether that plan can actually be bought right now, which
 * depends on Stripe ids being configured. A plan that cannot be bought is shown
 * as such rather than linking to a checkout that will fail.
 */
export function publicPlans() {
  return PLAN_IDS.map((id) => {
    const p = PLANS[id]
    const price = priceOf(id)
    const features = { ...p.features }
    for (const f of UNRELEASED_FEATURES) delete features[f]
    return {
      id: p.id,
      label: p.label,
      blurb: p.blurb,
      paid: PAID_PLANS.includes(id),
      featured: id === FEATURED_PLAN,
      price,
      // Kept for older callers that print a single string.
      priceLabel: price.label,
      ctaLabel: CTA_LABEL[id],
      highlights: upgradeHighlights(id),
      limits: jsonLimits(p.limits),
      features,
      available: {
        monthly: id === 'free' || Boolean(stripePriceId(id, 'monthly')),
        annual: id === 'free' ? false : Boolean(stripePriceId(id, 'annual')),
      },
    }
  })
}

/** The comparison table with every cell already formatted, for the UI. */
export function publicMatrix() {
  return visibleMatrix().map((g) => ({
    group: g.group,
    rows: g.rows.map((r) => ({
      key: r.key,
      label: r.label,
      values: Object.fromEntries(PLAN_IDS.map((id) => [id, valueFor(id, r)])),
    })),
  }))
}

/** True of every plan, so the "in every plan" list is derived, not written. */
export const universalFeatures = () =>
  visibleMatrix()
    .flatMap((g) => g.rows)
    .filter((r) => PLAN_IDS.every((id) => valueFor(id, r) === 'Included'))
    .map((r) => r.label)

/** Kept for older imports; prefer limitFor(user, 'links'). */
export const FREE_LINK_LIMIT = PLANS.free.limits.links
