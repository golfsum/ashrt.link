/**
 * Single source of truth for plan entitlements.
 *
 * Every limit and feature gate in the app reads from here: the API, the
 * dashboard, the public tracker, and (later) the admin tools. Nothing should
 * hardcode "25 links" or `user.plan === 'business'` anywhere else.
 *
 * Rule: entitlements are enforced server-side. Hiding a button in the UI is a
 * courtesy, never a control.
 */

/** Plans that require an active Stripe subscription. */
export const PAID_PLANS = ['pro', 'business']

/** Every plan id, cheapest first. */
export const PLAN_IDS = ['free', 'pro', 'business']

export const PLANS = {
  free: {
    id: 'free',
    label: 'Free',
    priceLabel: '$0/mo',
    limits: {
      links: 25,
      apiPerDay: 100,
      createPerHour: 30,
      campaigns: 3,
      domains: 0,
    },
    features: {
      customAlias: true,
      campaigns: true,
      utm: true,
      tags: true,
      brandedQr: false,
      customDomains: false,
      expiry: false,
      linkPassword: false,
    },
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    priceLabel: '$9/mo',
    limits: {
      links: Infinity,
      apiPerDay: 1000,
      createPerHour: 300,
      campaigns: Infinity,
      domains: 0,
    },
    features: {
      customAlias: true,
      campaigns: true,
      utm: true,
      tags: true,
      brandedQr: true,
      customDomains: false,
      expiry: true,
      linkPassword: true,
    },
  },
  business: {
    id: 'business',
    label: 'Business',
    priceLabel: '$29/mo',
    limits: {
      links: Infinity,
      apiPerDay: 10000,
      createPerHour: 1000,
      campaigns: Infinity,
      domains: 5,
    },
    features: {
      customAlias: true,
      campaigns: true,
      utm: true,
      tags: true,
      brandedQr: true,
      customDomains: true,
      expiry: true,
      linkPassword: true,
    },
  },
}

/**
 * Entitlements for someone with no account. Deliberately narrow: a random slug,
 * a link that expires unless claimed, and tight creation limits. Guests get the
 * product's core value (a trackable link plus its stats) and nothing that costs
 * us namespace or storage permanently.
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
  },
  features: {
    customAlias: false,
    campaigns: false,
    utm: true,
    tags: false,
    brandedQr: false,
    customDomains: false,
    expiry: false,
    linkPassword: false,
  },
}

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

/**
 * Feature check that produces an HTTP-shaped refusal, so routes stay one-liners:
 *   const deny = requireFeature(req.user, 'customDomains')
 *   if (deny) return res.status(deny.status).json(deny.body)
 */
export function requireFeature(user, feature, label) {
  if (can(user, feature)) return null
  if (!user) {
    return {
      status: 401,
      body: { error: `Create a free account to use ${label || feature}.`, needsAccount: true },
    }
  }
  return {
    status: 402,
    body: { error: `${label || feature} is available on a paid plan.`, needsUpgrade: true },
  }
}

/** Public-safe description of the plans, for pricing UI and the API docs. */
export function publicPlans() {
  return PLAN_IDS.map((id) => {
    const p = PLANS[id]
    return {
      id: p.id,
      label: p.label,
      priceLabel: p.priceLabel,
      limits: Object.fromEntries(
        Object.entries(p.limits).map(([k, v]) => [k, v === Infinity ? null : v]),
      ),
      features: { ...p.features },
    }
  })
}

/** Kept for older imports; prefer limitFor(user, 'links'). */
export const FREE_LINK_LIMIT = PLANS.free.limits.links
