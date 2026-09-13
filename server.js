import express from 'express'
import cors from 'cors'
import crypto from 'node:crypto'
import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import dotenv from 'dotenv'
import QRCode from 'qrcode'

import { store, users, campaigns, apiUsage, hashApiKey, hashGuestToken, effectiveStatus } from './store.js'
import {
  newUserId,
  newApiKey,
  newGuestToken,
  hashPassword,
  verifyPassword,
  setSession,
  clearSession,
  attachUser,
  requireUser,
  requireAdmin,
  isAdmin,
  guestId,
  syncAdminRole,
  oauthEnabled,
  oauthConfigured,
  setOAuthState,
  checkOAuthState,
  authUrl,
  fetchProfile,
} from './auth.js'
import { billingEnabled, planAvailable, createCheckoutUrl, createPortalUrl, parseWebhook } from './billing.js'
import { PAID_PLANS, limitFor, can, requireFeature, isPaid, publicPlans, planIdOf } from './lib/plans.js'
import { validateUrl, checkStored, applyUtm, registrableDomain } from './lib/urls.js'
import { hit, limit, clientId, clientIp, hashClient } from './lib/ratelimit.js'
import { classifyRequest } from './lib/bots.js'
import { checkIntegrity, applyFixes } from './lib/integrity.js'
import { sanitizeRules, resolveDestination, ruleLabel, RULE_TYPES, MAX_RULES } from './lib/routing.js'
import { dueLinks, checkUrl, applyResult, isBroken, HEALTH_STATES } from './lib/health.js'
import {
  SCOPES,
  ALL_SCOPES,
  DEFAULT_SCOPES,
  MAX_KEYS,
  newApiKey as mintApiKey,
  keyPrefix,
  sanitizeScopes,
  keysOf,
  publicKey,
  matchKey,
  keyAllows,
} from './lib/apikeys.js'
import {
  renderSvg as renderQrSvg,
  MODULE_STYLES as QR_MODULE_STYLES,
  EYE_STYLES as QR_EYE_STYLES,
  EC_LEVELS as QR_EC_LEVELS,
} from './lib/qr.js'
import {
  DOMAIN_RE,
  DOMAIN_STATES,
  diagnose as diagnoseDomain,
  dnsInstructions,
  verificationToken as domainVerificationToken,
  detachDomain,
  attachDomain,
  platformEnabled as domainPlatformEnabled,
} from './lib/domains.js'
import {
  trackAsync,
  sourceOf,
  CLIENT_EVENTS,
  eventSeries,
  acquisition,
  buildFunnel,
} from './lib/events.js'
import {
  blockedDomains,
  blockedEntries,
  blockDomain,
  unblockDomain,
  suspicionScore,
  AUTO_FLAG_SCORE,
  createReport,
  shouldAutoFlag,
  reportsForLink,
  listReports,
  updateReport,
  auditLog,
  REPORT_REASONS,
  audit,
} from './lib/abuse.js'

dotenv.config()

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(__dirname, 'public')
const PORT = Number(process.env.PORT) || 4000
/**
 * The domain short links are minted with.
 *
 * Order matters. A production deployment that forgot to set BASE_URL used to
 * fall through to VERCEL_URL and hand people links on a random
 * `ashrt-link-<hash>.vercel.app` host: they work, but they are not the brand and
 * they change on every deploy, so links already shared would break. The
 * canonical domain is the default in production, and VERCEL_URL is kept only
 * for preview deployments, where a per-deploy host is what you actually want.
 */
const CANONICAL_URL = 'https://www.ashrt.link'
const BASE_URL = (
  process.env.BASE_URL ||
  (process.env.VERCEL_ENV === 'production'
    ? CANONICAL_URL
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : `http://localhost:${PORT}`)
).replace(/\/$/, '')

/**
 * What example links in the marketing copy should read as. Never localhost:
 * an example is a promise about what you get, and "localhost:4000/abc123"
 * reads as a bug on a live site.
 */
const DISPLAY_BASE = (process.env.BASE_URL || CANONICAL_URL)
  .replace(/^https?:\/\//, '')
  .replace(/\/$/, '')

const SELF_HOST = (() => {
  try {
    return new URL(BASE_URL).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
})()

const isProd = Boolean(process.env.VERCEL)
const app = express()
app.set('trust proxy', true)

/* ---------------------------- custom-domain host -------------------------- */


/** Is this host one of ours, rather than a customer's branded domain? */
function hostMatchesSelf(host) {
  const h = String(host || '').toLowerCase().split(':')[0].replace(/^www\./, '')
  if (!h) return true
  if (h === SELF_HOST) return true
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h.endsWith('.vercel.app')) return true
  return false
}

/**
 * Branded host -> owning account. Cached in-process: this is consulted on every
 * request arriving on a custom domain, and the answer changes only when someone
 * verifies or removes a domain.
 */
const domainCache = new Map()
const DOMAIN_CACHE_MS = 60_000

export function clearDomainCache(domain) {
  if (domain) domainCache.delete(String(domain).toLowerCase())
  else domainCache.clear()
}

async function ownerForHost(host) {
  const h = String(host || '').toLowerCase().split(':')[0]
  if (!h || hostMatchesSelf(h)) return null

  const hit = domainCache.get(h)
  if (hit && Date.now() - hit.at < DOMAIN_CACHE_MS) return hit.owner

  let owner = null
  try {
    const u = await users.getByDomain(h)
    // Only a domain the account actually proved it controls serves links.
    //
    // "verified" is the status older records carry; it is still honoured so
    // that a domain set up before the diagnostics existed does not stop
    // working on deploy. A live domain resolves to its owner and its own
    // settings, which is what the branded-host routing below needs.
    const entry = (u?.domains || []).find(
      (d) => d.domain === h && (LIVE_DOMAIN_STATES.has(d.status) || d.status === 'verified'),
    )
    if (u && entry && u.status !== 'suspended') owner = { user: u, entry }
  } catch {
    owner = null
  }
  domainCache.set(h, { at: Date.now(), owner })
  return owner
}

/* ============================== Stripe webhook ============================= */
// Needs the raw body for signature verification, so it is registered before the
// JSON parser and before every other middleware.

app.post('/api/billing/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  let event
  try {
    event = parseWebhook(req.body, req.get('stripe-signature'))
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`)
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object
      const user = await users.getById(s.client_reference_id)
      if (user) {
        user.plan = s.metadata?.plan || 'pro'
        user.stripeCustomerId = s.customer || user.stripeCustomerId
        user.subscriptionId = s.subscription || user.subscriptionId
        user.subscriptionStatus = 'active'
        await users.update(user)
        // Attributed to where the account originally came from, which is what
        // makes the whole funnel add up to revenue rather than stopping at
        // signup. The webhook is the only trustworthy signal money moved.
        trackAsync('subscription_started', { source: user.signupSource || null })
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object
      const user = await users.getByStripe(sub.customer)
      if (user) {
        user.plan = 'free'
        user.subscriptionStatus = 'canceled'
        await users.update(user)
      }
    } else if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object
      const user = await users.getByStripe(sub.customer)
      if (user) {
        const active = ['active', 'trialing'].includes(sub.status)
        user.plan = active ? sub.metadata?.plan || user.plan || 'pro' : 'free'
        user.subscriptionStatus = sub.status
        await users.update(user)
      }
    } else if (event.type === 'invoice.payment_failed') {
      const inv = event.data.object
      const user = await users.getByStripe(inv.customer)
      if (user) {
        user.subscriptionStatus = 'past_due'
        await users.update(user)
      }
    }
  } catch (err) {
    console.error('[webhook]', err.message)
  }
  res.json({ received: true })
})

/* ============================ baseline middleware ========================= */

/**
 * Request bodies stay small, with one exception.
 *
 * 64kb is plenty for every endpoint here and keeps a large-body denial of
 * service cheap to refuse. The QR style route carries a base64 logo, so it gets
 * its own, larger, parser rather than raising the limit for everything.
 */
const jsonBody = express.json({ limit: '64kb' })
const jsonBodyWithImage = express.json({ limit: '128kb' })
app.use((req, res, next) =>
  (req.path === '/api/qr/style' ? jsonBodyWithImage : jsonBody)(req, res, next),
)

// Cross-origin API access is for API-key callers, never for cookie sessions:
// no credentials, so a browser on another origin cannot ride a login cookie.
app.use(
  cors({
    origin: '*',
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key'],
  }),
)

/**
 * Private surfaces that must never be indexed: the dashboard, the admin tools,
 * and guest tracking pages, whose URL carries a management token. robots.txt
 * asks; this header is what actually keeps them out of a search index.
 */
const NOINDEX_PREFIXES = [
  '/dashboard', '/links', '/link', '/analytics', '/campaigns', '/qr',
  '/settings', '/account', '/developers', '/admin', '/track',
  '/api', '/auth', '/login', '/signup',
]

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.set('X-Frame-Options', 'DENY')
  if (isProd) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) res.set('Cache-Control', 'no-store')
  if (NOINDEX_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + '/') || req.path.startsWith(p + '.'))) {
    res.set('X-Robots-Tag', 'noindex, nofollow')
    // A tracking token in the query string must not leak to the destination.
    if (req.path.startsWith('/track')) res.set('Referrer-Policy', 'no-referrer')
  }
  next()
})

/**
 * CSRF defence for cookie-authenticated writes. A same-site fetch either sends
 * no Origin or sends ours; a cross-site page cannot forge one. API-key callers
 * are unaffected, since they carry no ambient credential to abuse.
 */
app.use((req, res, next) => {
  const writing = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
  if (!writing || req.get('x-api-key')) return next()
  const origin = req.get('origin')
  if (!origin) return next()
  let host
  try {
    host = new URL(origin).host
  } catch {
    return res.status(403).json({ error: 'Bad origin' })
  }
  const allowed = new Set([req.get('host'), new URL(BASE_URL).host].filter(Boolean))
  if (allowed.has(host)) return next()
  return res.status(403).json({ error: 'Cross-site requests are not allowed' })
})

app.use(attachUser(users))

// An x-api-key that did not resolve fails loudly. Otherwise a revoked or
// mistyped key would quietly degrade to anonymous guest access and the caller
// would never learn their integration had stopped working.
app.use((req, res, next) => {
  if (!req.badApiKey) return next()
  return res.status(401).json({ error: 'That API key is not valid. Check it in your account settings.' })
})

// Count and cap programmatic requests.
app.use(async (req, res, next) => {
  if (!req.user || req.authMethod !== 'apikey' || !req.path.startsWith('/api/')) return next()
  apiUsage.record(req.user.id).catch(() => {})
  const result = await hit('api:day', req.user.id, { user: req.user }).catch(() => null)

  // Tell the caller where they stand on every response, not only when they run
  // out. A client that can see its remaining quota can slow down; one that only
  // finds out at 429 cannot.
  if (result && Number.isFinite(result.limit)) {
    res.set('X-RateLimit-Limit', String(result.limit))
    res.set('X-RateLimit-Remaining', String(result.remaining))
    res.set('X-RateLimit-Reset', String(Math.floor(result.resetAt / 1000)))
  }

  if (result && !result.allowed) {
    res.set('Retry-After', String(result.retryAfter))
    return res.status(429).json({
      error: `Daily API limit reached (${result.limit} requests). It resets at midnight UTC.`,
      retryAfter: result.retryAfter,
      needsUpgrade: planIdOf(req.user) !== 'business',
    })
  }
  next()
})

/* ================================ helpers ================================= */

/**
 * Names that cannot be used as a custom alias. Derived from what is actually in
 * public/ plus the route prefixes, rather than a hand-kept list that silently
 * rots every time a page is added.
 */
const ROUTE_NAMES = [
  'api', 'auth', 'admin', 'login', 'signup', 'logout', 'dashboard', 'account',
  'health', 'privacy', 'terms', 'links', 'link', 'analytics', 'qr', 'campaigns',
  'billing', 'settings', 'developers', 'report', 'track', 'claim', 'pricing',
  'about', 'contact', 'blog', 'docs', 'help', 'support', 'status', 'app', 'www',
  'robots.txt', 'sitemap.xml', 'favicon.ico', 'favicon.svg',
]

function buildReserved() {
  const names = new Set(ROUTE_NAMES)
  try {
    for (const file of readdirSync(PUBLIC_DIR)) {
      names.add(file.toLowerCase())
      names.add(file.replace(/\.(html|js|css|svg|xml|txt|json)$/i, '').toLowerCase())
    }
  } catch {
    /* public/ missing in some test contexts */
  }
  return names
}
const RESERVED = buildReserved()

/**
 * The URL a short code is presented as.
 *
 * An account with a verified custom domain gets its links on that domain. The
 * canonical host keeps working for every link regardless, so switching a domain
 * on or off never breaks links already shared.
 */
function shortUrlFor(slug, user) {
  const live = (user?.domains || []).filter(
    (d) => LIVE_DOMAIN_STATES.has(d.status) || d.status === 'verified',
  )
  // The account's chosen default wins; otherwise the first one that works.
  const brand = live.find((d) => d.isDefault) || live[0]
  if (CUSTOM_DOMAINS_LIVE && brand) return `https://${brand.domain}/${slug}`
  return `${BASE_URL}/${slug}`
}

const shortUrl = (slug) => `${BASE_URL}/${slug}`
const withUrl = (l) => ({ ...l, shortUrl: shortUrl(l.slug) })
const randomSlug = () => crypto.randomBytes(6).toString('base64url').slice(0, 7)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** How many of the recorded days to count as "recent" for a change warning. */
const RECENT_DAYS = 30

/** Clicks in the last 30 days, from the per-day map already on the record. */
function recentClicks(link) {
  const days = link.daily || {}
  const cutoff = new Date(Date.now() - RECENT_DAYS * 864e5).toISOString().slice(0, 10)
  let total = 0
  for (const [day, n] of Object.entries(days)) if (day >= cutoff) total += Number(n) || 0
  return total
}

/**
 * Remember where a link used to point.
 *
 * A short link is often printed, scheduled or handed to someone else, so a
 * changed destination is a change to something already out in the world. Ten
 * entries is enough to answer "what did this used to be" and to undo a mistake,
 * without letting one record grow unbounded.
 */
const HISTORY_LIMIT = 10
function recordDestinationChange(link, nextUrl, by) {
  if (!link.url || link.url === nextUrl) return
  link.history = [{ url: link.url, changedAt: Date.now(), by: by || null }, ...(link.history || [])].slice(
    0,
    HISTORY_LIMIT,
  )
}

/** Public-safe view of a link: never leaks the guest token hash or internals. */
function publicLink(l, { admin = false, user = null } = {}) {
  const out = {
    slug: l.slug,
    shortUrl: shortUrlFor(l.slug, user),
    url: l.url,
    title: l.title || null,
    status: effectiveStatus(l),
    campaign: l.campaign || null,
    tags: l.tags || [],
    clicks: l.clicks || 0,
    botClicks: l.botClicks || 0,
    createdAt: l.createdAt,
    expiresAt: l.expiresAt || null,
    lastClickAt: l.lastClickAt || null,
    guest: Boolean(l.guest),
  }
  // The owner (and an admin) can see where this link used to point, and how
  // much traffic it has been getting, so changing it is an informed decision.
  if (admin || (user && l.owner === user.id)) {
    out.history = (l.history || []).slice(0, HISTORY_LIMIT)
    out.recentClicks = recentClicks(l)
    out.recentDays = RECENT_DAYS
    // Scans of this link's QR code, which are clicks that arrived with our
    // marker. Counted, not estimated.
    out.scans = (l.channels || {}).qr || 0
    out.rules = l.rules || []
    // Only ever what the last scheduled check recorded. A click never waits for
    // somebody else's server.
    out.health = l.health
      ? { ...l.health, label: HEALTH_STATES[l.health.status] || l.health.status }
      : null
    // Clicks each rule has served, so a rule can be judged on its own traffic.
    out.routed = l.routed || {}
  }
  if (admin) {
    out.owner = l.owner
    out.flagScore = l.flagScore || 0
    out.flagSignals = l.flagSignals || []
    out.disabledReason = l.disabledReason || null
    out.domain = (() => {
      try {
        return registrableDomain(new URL(l.url).hostname)
      } catch {
        return null
      }
    })()
  }
  return out
}

function safeUser(u, { key = false } = {}) {
  if (!u) return null
  const out = {
    id: u.id,
    email: u.email,
    name: u.name,
    provider: u.provider || 'password',
    plan: planIdOf(u),
    // Must be isAdmin(), not a bare check of the stored field. The bootstrap
    // allowlist also grants the role, so reading the record alone reports
    // "user" for an account the server is already treating as an admin, and
    // the admin pages then bounce someone the server had just let in.
    role: isAdmin(u) ? 'admin' : 'user',
    status: u.status || 'active',
    createdAt: u.createdAt,
  }
  // The plaintext key is deliberately not here. Keys are hashed at rest and
  // shown once at creation; the one exception is an account that predates that,
  // which has its own endpoint below and says plainly that it is the last time.
  if (key) out.hasLegacyKey = Boolean(u.apiKey)
  return out
}

/** Everything a link creation request needs, validated in one place. */
async function buildLinkPayload(req, { user }) {
  const blocked = await blockedDomains()
  const checked = validateUrl(req.body?.url, { blocked, selfHost: SELF_HOST })
  if (!checked.ok) return { error: { status: 400, body: { error: checked.error, reason: checked.reason } } }

  let url = checked.url
  const utm = req.body?.utm
  if (utm && typeof utm === 'object') {
    if (!can(user, 'utm')) return { error: { status: 402, body: { error: 'UTM tagging needs an account', needsAccount: true } } }
    url = applyUtm(url, utm)
  }

  const { score, signals } = suspicionScore(url, checked.host)
  return { url, host: checked.host, score, signals }
}

const htmlPage = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${title}</title><link rel="stylesheet" href="/styles.css"></head>
<body class="msg-page"><div class="msg-card">${body}</div></body></html>`

/* ================================== auth ================================== */

app.get('/auth/config', (_req, res) => res.json({ providers: oauthEnabled() }))

app.get('/auth/me', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' })
  // Adding ADMIN_EMAILS for an account that already exists should not require
  // signing out and back in to take effect, especially since the login page
  // bounces anyone who is already signed in. Persist the role the first time
  // we see it here, so the record converges and the env var can be removed.
  await syncAdminRole(req.user, users).catch(() => {})
  res.json({ user: safeUser(req.user) })
})

app.post('/auth/logout', (_req, res) => {
  clearSession(res)
  res.json({ ok: true })
})

app.post('/auth/register', limit('auth:register'), async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  const name = String(req.body?.name || '').trim().slice(0, 80) || email.split('@')[0]
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email' })
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' })
  if (password.length > 200) return res.status(400).json({ error: 'That password is too long' })
  if (await users.getByEmail(email)) return res.status(409).json({ error: 'An account with that email already exists' })

  const apiKey = newApiKey()
  const user = {
    id: newUserId(),
    email,
    name,
    provider: 'password',
    passwordHash: await hashPassword(password),
    apiKey,
    apiKeyHash: hashApiKey(apiKey),
    role: 'user',
    status: 'active',
    plan: 'free',
    oauth: [],
    createdAt: Date.now(),
    signupIpHash: hashClient(clientIp(req)),
  }
  // Where this account came from, recorded once at signup. This is the whole
  // point of the instrumentation: it is what says whether search traffic
  // converts. Stored as a coarse bucket, not a referrer history.
  const source = sourceOf(req.get('referer'), { landing: SELF_HOST })
  user.signupSource = source

  await users.create(user)
  await syncAdminRole(user, users)
  setSession(res, user.id)

  const claimed = await claimGuestLinks(req.body?.claimTokens, user)
  trackAsync('signup_completed', { source })
  if (claimed) trackAsync('guest_link_claimed', { count: claimed })

  res.json({ user: safeUser(user), claimed })
})

app.post('/auth/login', limit('auth:login'), async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  const user = await users.getByEmail(email)
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Wrong email or password' })
  }
  if (user.status === 'suspended') {
    return res.status(403).json({ error: 'This account has been suspended. Contact support.' })
  }
  await syncAdminRole(user, users)
  setSession(res, user.id)
  const claimed = await claimGuestLinks(req.body?.claimTokens, user)

  trackAsync('login_completed')
  if (claimed) trackAsync('guest_link_claimed', { count: claimed })
  // A sign-in on a later day than the account was created is the simplest
  // honest definition of a returning user we can get from counters alone.
  if (user.createdAt && Date.now() - user.createdAt > 864e5) trackAsync('returning_user')

  res.json({ user: safeUser(user), claimed })
})

/* ------------------------------ OAuth (social) ---------------------------- */

app.get('/auth/:provider', (req, res, next) => {
  const provider = req.params.provider
  if (provider !== 'google' && provider !== 'github') return next()
  if (!oauthConfigured(provider)) return res.status(404).send(`${provider} sign-in is not configured`)
  const state = setOAuthState(res)
  res.redirect(authUrl(provider, `${BASE_URL}/auth/${provider}/callback`, state))
})

app.get('/auth/:provider/callback', async (req, res) => {
  const provider = req.params.provider
  if ((provider !== 'google' && provider !== 'github') || !oauthConfigured(provider)) {
    return res.redirect('/login?error=oauth')
  }
  try {
    if (!checkOAuthState(req, req.query.state)) return res.redirect('/login?error=state')
    const profile = await fetchProfile(provider, req.query.code, `${BASE_URL}/auth/${provider}/callback`)
    if (!profile.email) return res.redirect('/login?error=email')

    const tag = `${provider}:${profile.sub}`
    let user = await users.getByOAuth(provider, profile.sub)
    if (!user) {
      const existing = await users.getByEmail(profile.email)
      if (existing) {
        existing.oauth = Array.from(new Set([...(existing.oauth || []), tag]))
        await users.update(existing)
        user = existing
      } else {
        const apiKey = newApiKey()
        user = {
          id: newUserId(),
          email: profile.email.toLowerCase(),
          name: profile.name || profile.email,
          provider,
          apiKey,
          apiKeyHash: hashApiKey(apiKey),
          role: 'user',
          status: 'active',
          plan: 'free',
          oauth: [tag],
          createdAt: Date.now(),
          signupIpHash: hashClient(clientIp(req)),
        }
        await users.create(user)
      }
    }
    if (user.status === 'suspended') return res.redirect('/login?error=suspended')
    await syncAdminRole(user, users)
    setSession(res, user.id)
    res.redirect('/dashboard')
  } catch (err) {
    console.error('[oauth]', err.message)
    res.redirect('/login?error=oauth')
  }
})

/* ================================ account ================================= */

app.get('/api/account', requireUser, (req, res) => {
  res.json({ user: safeUser(req.user, { key: true }) })
})

/**
 * Gate a route on what the presenting key is allowed to do.
 *
 * Only API keys are scoped. A signed-in person in their own dashboard has full
 * access to their own account by definition, and adding scopes to a session
 * would be theatre.
 *
 * Applied to the route, not checked inside the handler, so a new route cannot
 * quietly inherit full access by forgetting a line.
 */
function requireScope(scope) {
  return (req, res, next) => {
    if (req.authMethod !== 'apikey') return next()
    if (keyAllows(req.apiKey, scope)) return next()
    res.status(403).json({
      error: `This key does not have the "${scope}" scope.`,
      scope,
      needsScope: scope,
    })
  }
}

/**
 * Record that a key was used, at most once an hour.
 *
 * Useful enough to answer "is this key still in use before I revoke it", not
 * useful enough to write the account record on every API call.
 */
const LAST_USED_RESOLUTION = 3600 * 1000
function touchKey(req) {
  const key = req.apiKey
  if (!key || key.legacy) return
  if (key.lastUsedAt && Date.now() - key.lastUsedAt < LAST_USED_RESOLUTION) return
  key.lastUsedAt = Date.now()
  users.update(req.user).catch(() => {})
}

app.use('/api', (req, res, next) => {
  if (req.authMethod === 'apikey') touchKey(req)
  next()
})

/* -------------------------------- API keys -------------------------------- */

/**
 * Keys an account holds. Metadata only: a key is shown once, at creation, and
 * is not recoverable afterwards by anyone, including us.
 */
app.get('/api/keys', requireUser, (req, res) => {
  res.json({
    keys: keysOf(req.user).map(publicKey),
    scopes: SCOPES,
    max: MAX_KEYS,
  })
})

/**
 * Mint a key.
 *
 * Several keys rather than one rotated in place, because one key ends up in
 * three places and rotating it then breaks two of them. Scopes because a script
 * that reads statistics has no business being able to delete every link.
 */
/**
 * The original key, for an account that predates hashed storage.
 *
 * Those accounts still hold their key in the clear, which is exactly what the
 * new model exists to stop. Rather than deleting it and breaking whatever is
 * using it, it can be read here once more, with the warning that replacing it
 * is the point. Creating a named key or revoking this one removes it for good.
 */
app.get('/api/keys/legacy', requireUser, (req, res) => {
  if (!req.user.apiKey) return res.status(404).json({ error: 'No key of that kind on this account.' })
  res.json({
    key: req.user.apiKey,
    note: 'This key predates hashed storage, which is why it can still be shown. Replace it with a named key and it will not be displayed again.',
  })
})

app.post('/api/keys', requireUser, async (req, res) => {
  const existing = keysOf(req.user)
  if (existing.length >= MAX_KEYS) {
    return res.status(400).json({ error: `An account can hold ${MAX_KEYS} keys. Revoke one first.` })
  }

  const key = mintApiKey()
  const record = {
    id: crypto.randomBytes(6).toString('base64url'),
    name: String(req.body?.name || '').trim().slice(0, 60) || 'Untitled key',
    hash: hashApiKey(key),
    prefix: keyPrefix(key),
    scopes: sanitizeScopes(req.body?.scopes),
    createdAt: Date.now(),
    lastUsedAt: null,
  }

  req.user.apiKeys = [...(req.user.apiKeys || []), record]
  await users.update(req.user)
  trackAsync('api_key_created')

  // The only time the plaintext exists outside the caller's hands.
  res.json({ key, created: publicKey(record) })
})

app.patch('/api/keys/:id', requireUser, async (req, res) => {
  const key = (req.user.apiKeys || []).find((k) => k.id === req.params.id)
  if (!key) return res.status(404).json({ error: 'No such key' })

  if (req.body?.name !== undefined) key.name = String(req.body.name).trim().slice(0, 60) || key.name
  if (req.body?.scopes !== undefined) key.scopes = sanitizeScopes(req.body.scopes)
  await users.update(req.user)
  res.json({ key: publicKey(key) })
})

/**
 * Revoke a key.
 *
 * The index entry goes with it. A revoked key that is still indexed still
 * authenticates, which is the whole failure this endpoint exists to prevent.
 */
app.delete('/api/keys/:id', requireUser, async (req, res) => {
  const all = keysOf(req.user)
  const key = all.find((k) => k.id === req.params.id)
  if (!key) return res.json({ ok: true })

  if (key.legacy) {
    // The account's original single key. Removing it means clearing the fields
    // it lives in rather than removing a list entry.
    req.user.apiKey = null
    req.user.apiKeyHash = null
  } else {
    req.user.apiKeys = (req.user.apiKeys || []).filter((k) => k.id !== key.id)
  }

  await users.update(req.user, { removedKeyHashes: [key.hash] })
  await audit({
    actor: req.user,
    action: 'user.revoke-key',
    targetType: 'user',
    targetId: req.user.id,
    meta: { keyName: key.name },
  })
  res.json({ ok: true })
})

/**
 * Replace the account's original key.
 *
 * Kept because callers exist, and given a meaning that fits the new model: it
 * retires the single key an older account carries and issues a named one in its
 * place. Keys added since are left alone — rotating one credential should not
 * take out the others.
 */
app.post('/api/account/rotate-key', requireUser, async (req, res) => {
  const legacy = keysOf(req.user).find((k) => k.legacy)
  const key = mintApiKey()
  const record = {
    id: crypto.randomBytes(6).toString('base64url'),
    name: 'Rotated key',
    hash: hashApiKey(key),
    prefix: keyPrefix(key),
    scopes: [...DEFAULT_SCOPES],
    createdAt: Date.now(),
    lastUsedAt: null,
  }

  req.user.apiKey = null
  req.user.apiKeyHash = null
  req.user.apiKeys = [...(req.user.apiKeys || []), record]
  await users.update(req.user, { removedKeyHashes: legacy ? [legacy.hash] : [] })
  trackAsync('api_key_created')

  res.json({ apiKey: key, created: publicKey(record) })
})

app.patch('/api/account', requireUser, async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80)
  if (name) {
    req.user.name = name
    await users.update(req.user)
  }
  res.json({ user: safeUser(req.user) })
})

/* ----------------------------- custom domains ----------------------------- */


/**
 * Custom domains.
 *
 * Three questions have to be answered before a branded host can serve
 * anything, and they are answered in this order:
 *
 *   1. Does the account control the domain? A TXT record proves it. Without
 *      this, anyone could claim links.someoneelse.com and catch their traffic.
 *   2. Does the domain point here? A CNAME, or an A record for an apex domain.
 *   3. Is there a certificate? The platform issues it, not us.
 *
 * lib/domains.js does the checking and reports which of the three is missing,
 * because "pending" on its own turns a five-minute DNS task into a support
 * ticket.
 *
 * The feature is on by default now that it reports its own state honestly.
 * CUSTOM_DOMAINS=0 forces it off.
 */
const CUSTOM_DOMAINS_LIVE = process.env.CUSTOM_DOMAINS !== '0'

/** Statuses that mean the host should be serving this account's links. */
const LIVE_DOMAIN_STATES = new Set(['active', 'pending_ssl'])

/**
 * A redirect target an account can set for its own domain.
 *
 * Runs through the same validation as any destination. A branded host is still
 * our infrastructure, so its root and fallback redirects cannot be used to
 * reach anything a short link could not.
 */
async function validateDomainTarget(value) {
  const raw = String(value || '').trim()
  if (!raw) return { ok: true, url: null }
  const checked = validateUrl(raw, { blocked: await blockedDomains() })
  if (!checked.ok) return { ok: false, error: checked.error }
  return { ok: true, url: checked.url }
}

/** Everything the settings page needs to show one domain. */
const domainView = (user, d) => ({
  domain: d.domain,
  status: d.status || 'pending_dns',
  statusLabel: DOMAIN_STATES[d.status] || DOMAIN_STATES.pending_dns,
  live: LIVE_DOMAIN_STATES.has(d.status),
  addedAt: d.addedAt || null,
  verifiedAt: d.verifiedAt || null,
  lastCheckedAt: d.lastCheckedAt || null,
  message: d.message || null,
  checks: d.checks || [],
  isDefault: Boolean(d.isDefault),
  rootRedirect: d.rootRedirect || null,
  notFoundRedirect: d.notFoundRedirect || null,
  records: dnsInstructions(d.domain, domainVerificationToken(user.id, d.domain)),
})

app.get('/api/domains', requireUser, (req, res) => {
  res.json({
    domains: (req.user.domains || []).map((d) => domainView(req.user, d)),
    available: CUSTOM_DOMAINS_LIVE,
    entitled: can(req.user, 'customDomains'),
    limit: limitFor(req.user, 'domains'),
    autoAttach: domainPlatformEnabled(),
  })
})

app.post('/api/domains', requireUser, async (req, res) => {
  if (!CUSTOM_DOMAINS_LIVE) {
    return res.status(503).json({ error: 'Custom domains are switched off on this deployment.', unavailable: true })
  }
  const deny = requireFeature(req.user, 'customDomains', 'Custom domains')
  if (deny) return res.status(deny.status).json(deny.body)

  const domain = String(req.body?.domain || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
  if (!DOMAIN_RE.test(domain)) return res.status(400).json({ error: 'Enter a valid domain like links.yourbrand.com' })
  if (hostMatchesSelf(domain)) return res.status(400).json({ error: 'That is already our domain' })

  req.user.domains = req.user.domains || []
  if (req.user.domains.length >= limitFor(req.user, 'domains')) {
    return res.status(402).json({ error: 'Domain limit reached for your plan', needsUpgrade: true })
  }
  if (req.user.domains.some((d) => d.domain === domain)) return res.status(409).json({ error: 'Domain already added' })

  // One account per domain, first to verify. Adding it here only reserves it;
  // it serves nothing until ownership and routing both check out.
  const existing = await users.getByDomain(domain)
  if (existing && existing.id !== req.user.id) {
    return res.status(409).json({ error: 'That domain is already verified on another account' })
  }

  const entry = {
    domain,
    status: 'pending_dns',
    addedAt: Date.now(),
    isDefault: !req.user.domains.length,
  }
  req.user.domains.push(entry)
  await users.update(req.user)

  await audit({
    actor: req.user,
    action: 'domain.added',
    targetType: 'domain',
    targetId: domain,
    meta: { owner: req.user.id },
  })
  res.json({ domain: domainView(req.user, entry) })
})

/**
 * Check a domain and say exactly what is still missing.
 *
 * Everything is measured, never taken from the client: DNS is read from DNS,
 * and certificate state from the platform. A domain starts serving as soon as
 * ownership and routing are both good; if the certificate is still being
 * issued, it goes live the moment that lands rather than needing another click.
 */
app.post('/api/domains/:domain/verify', requireUser, async (req, res) => {
  if (!CUSTOM_DOMAINS_LIVE) return res.status(503).json({ error: 'Custom domains are switched off', unavailable: true })

  const domain = String(req.params.domain || '').toLowerCase()
  const entry = (req.user.domains || []).find((d) => d.domain === domain)
  if (!entry) return res.status(404).json({ error: 'Not found' })

  const result = await diagnoseDomain({ domain, userId: req.user.id })

  if (LIVE_DOMAIN_STATES.has(result.state)) {
    const claim = await users.claimDomain(domain, req.user.id)
    if (!claim.ok) return res.status(409).json({ error: 'That domain is already verified on another account' })
    if (!entry.verifiedAt) {
      entry.verifiedAt = Date.now()
      await audit({ actor: req.user, action: 'domain.verified', targetType: 'domain', targetId: domain })
    }
  } else if (entry.verifiedAt) {
    // It used to work and no longer does. Stop serving it rather than leaving a
    // host pointed at us that its owner may have moved on from.
    await users.releaseDomain(domain)
    entry.verifiedAt = null
  }

  entry.status = result.state
  entry.message = result.message
  entry.checks = result.checks
  entry.lastCheckedAt = Date.now()
  await users.update(req.user)
  clearDomainCache(domain)

  res.json({ domain: domainView(req.user, entry), ...result })
})

/**
 * Per-domain settings: which domain new links use, where the bare host goes,
 * and where an unknown short code goes.
 *
 * The last two exist because a branded host with no configuration shows our
 * 404 on somebody else's domain, which is a worse experience than sending the
 * visitor to the site the domain belongs to.
 */
app.patch('/api/domains/:domain', requireUser, async (req, res) => {
  const domain = String(req.params.domain || '').toLowerCase()
  const list = req.user.domains || []
  const entry = list.find((d) => d.domain === domain)
  if (!entry) return res.status(404).json({ error: 'Not found' })

  if (req.body?.isDefault === true) {
    for (const d of list) d.isDefault = d.domain === domain
  }

  for (const field of ['rootRedirect', 'notFoundRedirect']) {
    if (!(field in (req.body || {}))) continue
    const checked = await validateDomainTarget(req.body[field])
    if (!checked.ok) return res.status(400).json({ error: checked.error })
    entry[field] = checked.url
  }

  await users.update(req.user)
  clearDomainCache(domain)
  res.json({ domain: domainView(req.user, entry) })
})

app.delete('/api/domains/:domain', requireUser, async (req, res) => {
  const domain = String(req.params.domain || '').toLowerCase()
  const owned = (req.user.domains || []).some((d) => d.domain === domain)
  const wasDefault = (req.user.domains || []).find((d) => d.domain === domain)?.isDefault
  req.user.domains = (req.user.domains || []).filter((d) => d.domain !== domain)
  // Removing the default should not leave an account with none.
  if (wasDefault && req.user.domains.length) req.user.domains[0].isDefault = true
  await users.update(req.user)
  if (owned) {
    await users.releaseDomain(domain)
    clearDomainCache(domain)
    // Detaching is best-effort: the domain is already not serving this account.
    detachDomain(domain).catch(() => {})
    await audit({ actor: req.user, action: 'domain.removed', targetType: 'domain', targetId: domain })
  }
  res.json({ ok: true })
})

/* ================================ billing ================================= */

app.get('/api/billing/status', (req, res) => {
  res.json({
    enabled: billingEnabled(),
    plan: planIdOf(req.user),
    subscriptionStatus: req.user?.subscriptionStatus || null,
    plans: publicPlans(),
    freeLimit: limitFor({ plan: 'free' }, 'links'),
    available: { pro: planAvailable('pro'), business: planAvailable('business') },
  })
})

app.post('/api/billing/checkout', requireUser, async (req, res) => {
  const plan = PAID_PLANS.includes(req.body?.plan) ? req.body.plan : 'pro'
  if (!planAvailable(plan)) return res.status(503).json({ error: `The ${plan} plan isn't set up yet` })
  if (planIdOf(req.user) === plan) return res.status(400).json({ error: `You're already on ${plan}` })
  try {
    const url = await createCheckoutUrl(req.user, BASE_URL, plan)
    trackAsync('checkout_started')
    res.json({ url })
  } catch (err) {
    console.error('[checkout]', err.message)
    res.status(500).json({ error: 'Could not start checkout' })
  }
})

app.post('/api/billing/portal', requireUser, async (req, res) => {
  if (!billingEnabled() || !req.user.stripeCustomerId) {
    return res.status(400).json({ error: 'No subscription to manage' })
  }
  try {
    res.json({ url: await createPortalUrl(req.user.stripeCustomerId, BASE_URL) })
  } catch (err) {
    console.error('[portal]', err.message)
    res.status(500).json({ error: 'Could not open billing portal' })
  }
})

/* ================================ campaigns =============================== */

app.get('/api/campaigns', requireUser, async (req, res) => {
  const list = await campaigns.byOwner(req.user.id)
  const links = await store.byOwner(req.user.id)
  const uniques = await store.uniquesForLinks(links.map((l) => l.slug))
  const out = list.map((c) => {
    const linksIn = links.filter((l) => l.campaign === c.id)
    return {
      ...c,
      links: linksIn.length,
      clicks: linksIn.reduce((s, l) => s + (l.clicks || 0), 0),
      visitors: linksIn.reduce((s, l) => s + (uniques[l.slug] || 0), 0),
    }
  })
  res.json({ campaigns: out })
})

app.post('/api/campaigns', requireUser, async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 120)
  if (!name) return res.status(400).json({ error: 'Name your campaign' })
  const existing = await campaigns.byOwner(req.user.id)
  if (existing.length >= limitFor(req.user, 'campaigns')) {
    return res.status(402).json({ error: 'Campaign limit reached for your plan', needsUpgrade: true })
  }
  const camp = {
    id: 'c_' + crypto.randomBytes(6).toString('base64url'),
    owner: req.user.id,
    name,
    archived: false,
    createdAt: Date.now(),
  }
  await campaigns.create(camp)
  trackAsync('campaign_created')
  res.json(camp)
})

app.patch('/api/campaigns/:id', requireUser, async (req, res) => {
  const camp = await campaigns.get(req.params.id)
  if (!camp || camp.owner !== req.user.id) return res.status(404).json({ error: 'Not found' })
  if (req.body?.name !== undefined) camp.name = String(req.body.name).trim().slice(0, 120) || camp.name
  if (req.body?.archived !== undefined) camp.archived = Boolean(req.body.archived)
  await campaigns.update(camp)
  res.json(camp)
})

app.delete('/api/campaigns/:id', requireUser, async (req, res) => {
  const camp = await campaigns.get(req.params.id)
  if (!camp || camp.owner !== req.user.id) return res.status(404).json({ error: 'Not found' })
  await campaigns.remove(req.params.id)
  res.json({ ok: true })
})

/* ------------------------------- API usage -------------------------------- */

app.get('/api/usage', requireUser, async (req, res) => {
  const byDay = await apiUsage.byDay(req.user.id)
  const day = new Date().toISOString().slice(0, 10)
  const month = day.slice(0, 7)
  const monthTotal = Object.entries(byDay).reduce((s, [d, n]) => (d.startsWith(month) ? s + n : s), 0)
  const dailyLimit = limitFor(req.user, 'apiPerDay')
  res.json({
    byDay,
    today: byDay[day] || 0,
    month: monthTotal,
    plan: planIdOf(req.user),
    dailyLimit: Number.isFinite(dailyLimit) ? dailyLimit : null,
  })
})

/* ================================== links ================================= */

app.get('/api/health', async (_req, res) =>
  res.json({ ok: true, store: store.driver, providers: oauthEnabled() }),
)

app.get('/api/plans', (_req, res) => res.json({ plans: publicPlans() }))

/** Public config the marketing pages need, so nothing is hardcoded in HTML. */
app.get('/api/config', (_req, res) =>
  res.json({
    displayBase: DISPLAY_BASE,
    guestTtlDays: limitFor(null, 'linkTtlDays'),
    freeLinkLimit: limitFor({ plan: 'free' }, 'links'),
  }),
)

/**
 * Create a link. Open to guests on purpose: the product's first useful action
 * should not sit behind a signup. What guests do not get is an unlimited,
 * permanent, aliasable link, and every creation passes the same validation.
 */
app.post('/api/links', requireScope('links:write'), async (req, res) => {
  const user = req.user || null
  const guest = user ? null : guestId(req, res)

  const tooMany = (message, r) => {
    res.set('Retry-After', String(r.retryAfter))
    return res.status(429).json({ error: message, retryAfter: r.retryAfter, needsAccount: !user })
  }

  // Attempts are counted first, so probing the validator is not free. This is
  // separate from the creation budget below, which only successful links spend.
  if (!user) {
    const attempt = await hit('create:attempt', clientId(req))
    if (!attempt.allowed) return tooMany('Too many attempts. Try again shortly.', attempt)
  }

  // Validate before spending quota: a mistyped URL should not cost a guest one
  // of their five links.
  const built = await buildLinkPayload(req, { user })
  if (built.error) return res.status(built.error.status).json(built.error.body)

  const wantsAlias = Boolean(String(req.body?.alias || '').trim())
  if (wantsAlias && !can(user, 'customAlias')) {
    return res.status(401).json({ error: 'Sign up for a free account to use custom aliases', needsAccount: true })
  }

  // A stored-link cap, for any plan that still sets one. No plan does today:
  // the allowance is on creation, so published links keep working instead of
  // having to be deleted to make room.
  if (user) {
    const cap = limitFor(user, 'links')
    if (Number.isFinite(cap) && (await store.countByOwner(user.id)) >= cap) {
      return res.status(402).json({
        error: `This plan keeps ${cap} links. Upgrade for more.`,
        needsUpgrade: true,
      })
    }
  }

  // The request is good and will produce a link, so now spend the budget.
  const budget = user
    ? [['create:user:month', user.id], ['create:user:hour', user.id]]
    : [
        ['create:guest:hour', guest],
        ['create:guest:day', guest],
        ['create:ip:hour', clientId(req)],
        ['create:ip:day', clientId(req)],
      ]
  for (const [name, id] of budget) {
    const r = await hit(name, id, { user })
    if (r.allowed) continue

    // Running out of plan allowance is a different thing from going too fast,
    // and telling someone to "try again shortly" when they need a bigger plan
    // wastes their afternoon.
    if (name === 'create:user:month') {
      return res.status(402).json({
        error: `You have created ${r.limit} links in the last 30 days, which is this plan's allowance. Upgrade to keep going.`,
        needsUpgrade: true,
        limit: r.limit,
        resetAt: r.resetAt,
      })
    }
    return tooMany(
      user
        ? 'You are creating links very quickly. Try again shortly.'
        : 'Guest link limit reached. Create a free account to keep going, it takes a moment.',
      r,
    )
  }

  let slug = String(req.body?.alias || '').trim()
  if (slug) {
    if (!/^[a-zA-Z0-9_-]{2,32}$/.test(slug)) {
      return res.status(400).json({ error: 'Aliases use letters, numbers, dashes (2 to 32 chars)' })
    }
    if (RESERVED.has(slug.toLowerCase()) || (await store.exists(slug))) {
      return res.status(409).json({ error: 'That alias is taken' })
    }
  } else {
    let attempts = 0
    do {
      slug = randomSlug()
      if (++attempts > 10) return res.status(500).json({ error: 'Could not allocate a short code' })
    } while (RESERVED.has(slug.toLowerCase()) || (await store.exists(slug)))
  }

  const flagged = built.score >= AUTO_FLAG_SCORE
  const guestToken = user ? null : newGuestToken()
  const guestTtlDays = limitFor(null, 'linkTtlDays')

  const record = {
    slug,
    url: built.url,
    owner: user ? user.id : null,
    guest: !user,
    guestTokenHash: guestToken ? hashGuestToken(guestToken) : null,
    expiresAt: user ? null : Date.now() + guestTtlDays * 864e5,
    title: String(req.body?.title || '').trim().slice(0, 200) || null,
    campaign: (user && req.body?.campaign) || null,
    tags: user && Array.isArray(req.body?.tags) ? req.body.tags.slice(0, 10).map((t) => String(t).slice(0, 40)) : [],
    status: flagged ? 'flagged' : 'active',
    flagScore: built.score,
    flagSignals: built.signals,
    creatorIpHash: hashClient(clientIp(req)),
    source: req.body?.source || (user ? (req.authMethod === 'apikey' ? 'api' : 'dashboard') : 'guest'),
  }

  const link = await store.add(record)
  if (user) await store.logActivity(user.id, { type: 'created', slug, at: Date.now() })

  trackAsync(
    user ? (req.authMethod === 'apikey' ? 'api_link_created' : 'user_link_created') : 'guest_link_created',
    { source: user ? null : sourceOf(req.get('referer'), { landing: SELF_HOST }) },
  )

  if (flagged) {
    await audit({
      actor: null,
      action: 'link.auto_flagged',
      targetType: 'link',
      targetId: slug,
      meta: { score: built.score, signals: built.signals, host: built.host },
    })
  }

  const out = publicLink(link, { user })
  if (guestToken) {
    out.manageToken = guestToken
    out.manageUrl = `${BASE_URL}/track?t=${guestToken}`
    out.expiresInDays = guestTtlDays
  }
  res.json(out)
})

/**
 * Create many links at once.
 *
 * Two things make this different from a loop over the single-link endpoint.
 *
 * First, it checks the whole batch before it writes anything, and reports what
 * is wrong per row. Importing 200 links and being told only that row 87 failed,
 * after 86 of them already exist, is how people end up with half-imported
 * campaigns they then have to clean up by hand.
 *
 * Second, it stops cleanly at the plan allowance rather than partway through a
 * row: everything past the limit comes back marked, so it can be re-run after
 * an upgrade without creating anything twice.
 */
const MAX_BULK_ROWS = 250

app.post('/api/links/bulk', requireUser, requireScope('links:write'), async (req, res) => {
  const deny = requireFeature(req.user, 'bulkCreate', 'Bulk creation')
  if (deny) return res.status(deny.status).json(deny.body)

  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null
  if (!rows) return res.status(400).json({ error: 'Send a list of rows.' })
  if (!rows.length) return res.status(400).json({ error: 'There is nothing in that file.' })
  if (rows.length > MAX_BULK_ROWS) {
    return res.status(400).json({ error: `That is ${rows.length} rows. Import at most ${MAX_BULK_ROWS} at a time.` })
  }

  const dryRun = Boolean(req.body?.dryRun)
  const blocked = await blockedDomains()
  const results = []
  const seenAlias = new Set()
  const seenUrl = new Set()

  // Pass one: judge every row without writing anything.
  for (const [i, raw] of rows.entries()) {
    const row = { line: i + 1, url: String(raw?.url || '').trim() }
    const fail = (status, message) => results.push({ ...row, ok: false, status, error: message })

    if (!row.url) {
      fail('empty', 'No URL on this row')
      continue
    }

    const checked = validateUrl(row.url, { blocked, selfHost: SELF_HOST })
    if (!checked.ok) {
      fail('invalid', checked.error)
      continue
    }

    let url = checked.url
    if (raw?.utm && typeof raw.utm === 'object') url = applyUtm(url, raw.utm)

    // A file that lists the same destination twice is usually a mistake, but it
    // is a legitimate one (two campaigns, one page), so it is a warning rather
    // than a refusal.
    const duplicate = seenUrl.has(url)
    seenUrl.add(url)

    const alias = String(raw?.alias || '').trim()
    if (alias) {
      if (!/^[a-zA-Z0-9_-]{2,32}$/.test(alias)) {
        fail('bad_alias', 'Aliases use letters, numbers and dashes, 2 to 32 characters')
        continue
      }
      if (seenAlias.has(alias.toLowerCase())) {
        fail('alias_repeated', 'That short code appears twice in this file')
        continue
      }
      if (RESERVED.has(alias.toLowerCase()) || (await store.exists(alias))) {
        fail('alias_taken', 'That short code is already in use')
        continue
      }
      seenAlias.add(alias.toLowerCase())
    }

    results.push({
      ...row,
      ok: true,
      status: duplicate ? 'duplicate' : 'ready',
      url,
      alias: alias || null,
      title: String(raw?.title || '').trim().slice(0, 200) || null,
      campaign: raw?.campaign || null,
      tags: Array.isArray(raw?.tags) ? raw.tags.slice(0, 10).map((t) => String(t).slice(0, 40)) : [],
      score: suspicionScore(url, checked.host).score,
      signals: suspicionScore(url, checked.host).signals,
    })
  }

  const ready = results.filter((r) => r.ok)
  if (dryRun) {
    return res.json({
      dryRun: true,
      total: results.length,
      ready: ready.length,
      rejected: results.length - ready.length,
      rows: results.map(({ score, signals, ...rest }) => rest),
    })
  }

  // Pass two: write, spending the plan allowance one link at a time so the
  // batch stops exactly at the limit.
  for (const row of ready) {
    const budget = await hit('create:user:month', req.user.id, { user: req.user })
    if (!budget.allowed) {
      row.ok = false
      row.status = 'over_quota'
      row.error = 'This would go past your plan allowance for the last 30 days'
      continue
    }

    let slug = row.alias
    if (!slug) {
      let attempts = 0
      do {
        slug = randomSlug()
        if (++attempts > 10) {
          row.ok = false
          row.status = 'failed'
          row.error = 'Could not allocate a short code'
          break
        }
      } while (RESERVED.has(slug.toLowerCase()) || (await store.exists(slug)))
    }
    if (!row.ok) continue

    const flagged = row.score >= AUTO_FLAG_SCORE
    const link = await store.add({
      slug,
      url: row.url,
      owner: req.user.id,
      guest: false,
      title: row.title,
      campaign: row.campaign,
      tags: row.tags,
      status: flagged ? 'flagged' : 'active',
      flagScore: row.score,
      flagSignals: row.signals,
      creatorIpHash: hashClient(clientIp(req)),
      source: 'bulk',
    })

    row.status = flagged ? 'flagged' : 'created'
    row.slug = slug
    row.shortUrl = shortUrlFor(slug, req.user)
    if (flagged) {
      await audit({
        actor: null,
        action: 'link.auto_flagged',
        targetType: 'link',
        targetId: slug,
        meta: { score: row.score, signals: row.signals, source: 'bulk' },
      })
    }
    void link
  }

  const created = results.filter((r) => r.ok && r.slug)
  if (created.length) {
    await store.logActivity(req.user.id, {
      type: 'created',
      slug: created[0].slug,
      count: created.length,
      at: Date.now(),
    })
    trackAsync('bulk_links_created')
  }

  res.json({
    total: results.length,
    created: created.length,
    rejected: results.length - created.length,
    rows: results.map(({ score, signals, ...rest }) => rest),
  })
})

app.get('/api/links', requireUser, requireScope('links:read'), async (req, res) => {
  const all = await store.byOwner(req.user.id)
  const q = String(req.query.q || '').trim().toLowerCase()
  const status = String(req.query.status || '').trim()
  const campaign = String(req.query.campaign || '').trim()
  const tag = String(req.query.tag || '').trim()

  let list = all
  if (q) list = list.filter((l) => l.slug.toLowerCase().includes(q) || (l.url || '').toLowerCase().includes(q) || (l.title || '').toLowerCase().includes(q))
  if (status) list = list.filter((l) => effectiveStatus(l) === status)
  if (campaign) list = list.filter((l) => l.campaign === campaign)
  if (tag) list = list.filter((l) => (l.tags || []).includes(tag))

  const sort = String(req.query.sort || 'recent')
  if (sort === 'clicks') list.sort((a, b) => (b.clicks || 0) - (a.clicks || 0))
  else list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))

  const limitN = Math.min(Number(req.query.limit) || 100, 500)
  const cursor = Math.max(Number(req.query.cursor) || 0, 0)
  const page = list.slice(cursor, cursor + limitN)

  const uniques = await store.uniquesForLinks(page.map((l) => l.slug))
  const enriched = page.map((l) => ({ ...publicLink(l, { user: req.user }), visitors: uniques[l.slug] || 0 }))

  res.json({
    totalLinks: all.length,
    totalClicks: all.reduce((s, l) => s + (l.clicks || 0), 0),
    total: list.length,
    nextCursor: cursor + limitN < list.length ? cursor + limitN : null,
    links: enriched,
  })
})

app.patch('/api/links/:slug', requireUser, requireScope('links:write'), async (req, res) => {
  const link = await store.get(req.params.slug)
  if (!link) return res.status(404).json({ error: 'Link not found' })
  if (link.owner !== req.user.id) return res.status(403).json({ error: 'Not your link' })

  if (req.body?.url !== undefined) {
    const built = await buildLinkPayload(req, { user: req.user })
    if (built.error) return res.status(built.error.status).json(built.error.body)
    if (built.url !== link.url) recordDestinationChange(link, built.url, req.user.email)
    link.url = built.url
    link.flagScore = built.score
    link.flagSignals = built.signals
  }
  if (req.body?.campaign !== undefined) link.campaign = req.body.campaign || null
  if (req.body?.title !== undefined) link.title = String(req.body.title).trim().slice(0, 200) || null
  if (req.body?.tags !== undefined && Array.isArray(req.body.tags)) {
    link.tags = req.body.tags.slice(0, 10).map((t) => String(t).slice(0, 40))
  }
  if (req.body?.rules !== undefined) {
    const deny = requireFeature(req.user, 'smartRouting', 'Smart routing')
    if (deny) return res.status(deny.status).json(deny.body)

    const { rules, errors } = sanitizeRules(req.body.rules)
    if (errors.length) return res.status(400).json({ error: errors[0], errors })

    // Every rule destination goes through the same validation as the link's
    // own, against the live blocklist. Without this the rule editor would be an
    // open redirect with a form in front of it.
    const blocked = await blockedDomains()
    const checked = []
    for (const [i, rule] of rules.entries()) {
      const result = validateUrl(rule.url, { blocked })
      if (!result.ok) return res.status(400).json({ error: `Rule ${i + 1}: ${result.error}` })
      checked.push({ ...rule, url: result.url })
    }
    link.rules = checked
  }

  if (req.body?.expiresAt !== undefined) {
    const deny = requireFeature(req.user, 'expiry', 'Link expiry')
    if (deny) return res.status(deny.status).json(deny.body)
    link.expiresAt = req.body.expiresAt ? Number(req.body.expiresAt) : null
  }
  // A user may re-enable their own link, but never clear an admin flag.
  if (req.body?.status !== undefined && ['active', 'disabled'].includes(req.body.status)) {
    if (link.status !== 'flagged' && !link.disabledBy) link.status = req.body.status
  }

  await store.add(link)
  await store.logActivity(req.user.id, { type: 'edited', slug: link.slug, at: Date.now() })
  res.json(publicLink(link, { user: req.user }))
})

/**
 * Put a link back to a destination it used to have.
 *
 * The old URL is validated again rather than trusted: a domain that was fine
 * six weeks ago may be on the blocklist now, and "it was allowed before" is not
 * a reason to serve it today. Reverting is itself a change, so it is recorded
 * in the history like any other.
 */
app.post('/api/links/:slug/revert', requireUser, requireScope('links:write'), async (req, res) => {
  const link = await store.get(req.params.slug)
  if (!link) return res.status(404).json({ error: 'Link not found' })
  if (link.owner !== req.user.id) return res.status(403).json({ error: 'Not your link' })

  const at = Number(req.body?.changedAt)
  const entry = (link.history || []).find((h) => h.changedAt === at)
  if (!entry) return res.status(404).json({ error: 'That version is no longer in the history' })

  const checked = validateUrl(entry.url, { blocked: await blockedDomains() })
  if (!checked.ok) {
    return res.status(400).json({ error: `That destination can no longer be used: ${checked.error}` })
  }

  recordDestinationChange(link, checked.url, req.user.email)
  link.url = checked.url
  await store.add(link)
  await store.logActivity(req.user.id, { type: 'edited', slug: link.slug, at: Date.now() })
  res.json(publicLink(link, { user: req.user }))
})

app.get('/api/links/:slug/stats', requireUser, requireScope('analytics:read'), async (req, res) => {
  const link = await store.get(req.params.slug)
  if (!link) return res.status(404).json({ error: 'Link not found' })
  if (link.owner !== req.user.id) return res.status(403).json({ error: 'Not your link' })
  const summary = await store.linkSummary(req.params.slug)
  res.json({ ...summary, shortUrl: shortUrlFor(req.params.slug, req.user) })
})

app.delete('/api/links/:slug', requireUser, requireScope('links:write'), async (req, res) => {
  const link = await store.get(req.params.slug)
  if (!link) return res.json({ ok: true })
  if (link.owner !== req.user.id) return res.status(403).json({ error: 'Not your link' })
  await store.remove(req.params.slug)
  await store.logActivity(req.user.id, { type: 'deleted', slug: req.params.slug, at: Date.now() })
  res.json({ ok: true })
})

app.get('/api/stats', requireUser, requireScope('analytics:read'), async (req, res) => {
  const summary = await store.summary(req.user.id)
  const camps = await campaigns.byOwner(req.user.id)
  res.json({ ...summary, totalCampaigns: camps.length })
})

/* --------------------------------- export --------------------------------- */

/**
 * CSV, because a spreadsheet is where this data usually ends up.
 *
 * Three shapes rather than one flat dump: the link list, clicks per link per
 * day, and campaign totals. There is no per-click export because there are no
 * per-click rows: clicks are aggregated as they arrive, which is what keeps
 * this cheap to run and keeps us from holding a log of who went where.
 */
const CSV_TYPES = ['links', 'daily', 'campaigns']

/** One CSV field, quoted when it has to be. */
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  // A leading =, +, - or @ is executed as a formula by spreadsheet software,
  // so a destination like "=cmd|..." is neutralised rather than passed along.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

const csvRows = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'

app.get('/api/export', requireUser, requireScope('analytics:read'), limit('export:hour', (req) => req.user?.id || clientId(req)), async (req, res) => {
  const type = CSV_TYPES.includes(String(req.query.type)) ? String(req.query.type) : 'links'
  const links = await store.byOwner(req.user.id)
  const stamp = new Date().toISOString().slice(0, 10)

  let rows
  if (type === 'links') {
    const uniques = await store.uniquesForLinks(links.map((l) => l.slug))
    rows = [
      ['short_code', 'short_url', 'destination', 'name', 'campaign', 'tags', 'status',
       'clicks', 'unique_visitors', 'bot_clicks', 'created_at', 'last_click_at'],
      ...links.map((l) => [
        l.slug,
        shortUrlFor(l.slug, req.user),
        l.url,
        l.title || '',
        l.campaign || '',
        (l.tags || []).join(' '),
        effectiveStatus(l),
        l.clicks || 0,
        uniques[l.slug] || 0,
        l.botClicks || 0,
        l.createdAt ? new Date(l.createdAt).toISOString() : '',
        l.lastClickAt ? new Date(l.lastClickAt).toISOString() : '',
      ]),
    ]
  } else if (type === 'daily') {
    rows = [['date', 'short_code', 'destination', 'clicks', 'bot_clicks']]
    for (const l of links) {
      const days = new Set([...Object.keys(l.daily || {}), ...Object.keys(l.botDaily || {})])
      for (const day of [...days].sort()) {
        rows.push([day, l.slug, l.url, (l.daily || {})[day] || 0, (l.botDaily || {})[day] || 0])
      }
    }
  } else {
    const camps = await campaigns.byOwner(req.user.id)
    const uniques = await store.uniquesForLinks(links.map((l) => l.slug))
    rows = [['campaign', 'links', 'clicks', 'unique_visitors', 'bot_clicks', 'created_at']]
    for (const c of camps) {
      const mine = links.filter((l) => l.campaign === c.id)
      rows.push([
        c.name,
        mine.length,
        mine.reduce((s, l) => s + (l.clicks || 0), 0),
        mine.reduce((s, l) => s + (uniques[l.slug] || 0), 0),
        mine.reduce((s, l) => s + (l.botClicks || 0), 0),
        c.createdAt ? new Date(c.createdAt).toISOString() : '',
      ])
    }
    const loose = links.filter((l) => !l.campaign)
    if (loose.length) {
      rows.push([
        'No campaign',
        loose.length,
        loose.reduce((s, l) => s + (l.clicks || 0), 0),
        loose.reduce((s, l) => s + (uniques[l.slug] || 0), 0),
        loose.reduce((s, l) => s + (l.botClicks || 0), 0),
        '',
      ])
    }
  }

  res
    .type('text/csv; charset=utf-8')
    .set('Content-Disposition', `attachment; filename="ashrt-${type}-${stamp}.csv"`)
    .set('Cache-Control', 'no-store')
    .send(csvRows(rows))
})

/* ---------------------------- destination health -------------------------- */

/**
 * Check a slice of destinations.
 *
 * Called by the scheduler, never by a browser, and never from the redirect
 * path. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; without a
 * secret configured the endpoint refuses everyone, because an open endpoint
 * that makes outbound requests on demand is a free proxy for whoever finds it.
 */
app.get('/api/cron/health-check', async (req, res) => {
  const secret = process.env.CRON_SECRET
  if (!secret) return res.status(503).json({ error: 'Checks are not configured on this deployment.' })

  const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '')
  // Timing-safe, because this is a bearer token and the comparison is remote.
  const ok =
    provided.length === secret.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret))
  if (!ok) return res.status(404).type('html').send(notFoundPage())

  const limitN = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100)
  const all = await store.all()
  const due = dueLinks(all, { limit: limitN })
  if (!due.length) return res.json({ checked: 0, broken: 0, note: 'Nothing due.' })

  const blocked = await blockedDomains()
  const summary = { checked: 0, ok: 0, broken: 0, recovered: 0, byStatus: {} }

  // A few at a time: enough to get through the queue, not enough to look like
  // an attack to anybody receiving them.
  const BATCH = 6
  for (let i = 0; i < due.length; i += BATCH) {
    const slice = due.slice(i, i + BATCH)
    const results = await Promise.all(
      slice.map(async (link) => ({ link, result: await checkUrl(link.url, { blocked }) })),
    )

    for (const { link, result } of results) {
      const before = link.health?.alerting || false
      const fresh = await store.get(link.slug)
      // The link may have been edited or deleted while the batch was running;
      // writing a check for a destination that is no longer there would be
      // worse than skipping it.
      if (!fresh || fresh.url !== link.url) continue

      fresh.health = applyResult(fresh, result)
      await store.add(fresh)

      summary.checked++
      summary.byStatus[result.status] = (summary.byStatus[result.status] || 0) + 1
      if (result.status === 'ok') {
        summary.ok++
        if (before) summary.recovered++
      } else if (fresh.health.alerting) {
        summary.broken++
      }
    }
  }

  res.json(summary)
})

/**
 * The links this account should look at.
 *
 * Reported separately from the link list so the dashboard can ask for just this
 * without paging through everything.
 */
app.get('/api/links/health', requireUser, requireScope('analytics:read'), async (req, res) => {
  const links = await store.byOwner(req.user.id)
  const broken = links.filter(isBroken)
  const checked = links.filter((l) => l.health?.checkedAt)

  res.json({
    // Checks run on a schedule, so "none broken" and "nothing checked yet" are
    // different answers and are reported as such.
    checking: checked.length > 0,
    lastCheckedAt: checked.reduce((max, l) => Math.max(max, l.health.checkedAt), 0) || null,
    broken: broken.map((l) => ({
      slug: l.slug,
      url: l.url,
      title: l.title,
      status: l.health.status,
      label: HEALTH_STATES[l.health.status] || l.health.status,
      code: l.health.code,
      detail: l.health.detail,
      failingSince: l.health.failingSince,
      lastOkAt: l.health.lastOkAt,
      clicks: l.clicks || 0,
      recentClicks: recentClicks(l),
    })),
  })
})

/* ------------------------------- QR codes --------------------------------- */

/**
 * QR codes.
 *
 * Every code encodes the short link, never the destination, which is what makes
 * it editable after it is printed. Codes we generate for our own links carry an
 * `s=qr` marker so a scan can be told apart from a click; the marker is read at
 * the redirect and never forwarded on.
 *
 * Signed-in users can encode anything; guests can encode only one of our own
 * short URLs, so the endpoint stays useful on the guest tracking page without
 * becoming a free general-purpose QR API for anyone to point a script at.
 */

/** Defaults for an account that has not chosen anything. */
const QR_DEFAULTS = {
  dark: '#0A0A0A',
  light: '#FFFFFF',
  style: 'square',
  eyeStyle: 'square',
  ecLevel: 'M',
  caption: '',
  frame: false,
  logo: null,
}

/**
 * The style this account's codes use.
 *
 * Styling is a paid feature, so a free account always renders the plain code
 * rather than a half-styled one: server-side, not by hiding the controls.
 */
function qrStyleFor(user) {
  if (!can(user, 'brandedQr')) return { ...QR_DEFAULTS }
  return { ...QR_DEFAULTS, ...(user?.qr || {}) }
}

/** Is this one of our own short URLs? */
function ownShortUrl(text, user) {
  const hosts = [BASE_URL, ...(user?.domains || []).map((d) => `https://${d.domain}`)]
  for (const base of hosts) {
    if (!text.startsWith(base + '/')) continue
    const rest = text.slice(base.length + 1)
    if (/^[a-zA-Z0-9_-]{1,32}$/.test(rest)) return rest
  }
  return null
}

app.get('/api/qr', requireScope('qr:read'), limit('redirect:minute'), async (req, res) => {
  let data = String(req.query.data || '').slice(0, 2048)

  // Addressing a link by its short code is the normal case, and it means the
  // caller never has to know how the short URL is built.
  if (!data && req.query.slug) {
    const slug = String(req.query.slug).slice(0, 32)
    const link = await store.get(slug)
    if (!link) return res.status(404).send('no such link')
    if (link.owner && link.owner !== req.user?.id) return res.status(404).send('no such link')
    data = shortUrlFor(slug, req.user)
  }
  if (!data) return res.status(400).send('missing data')

  const ours = ownShortUrl(data, req.user)
  if (!req.user && !ours) return res.status(401).send('sign in to generate QR codes')

  // Mark our own codes so a scan can be counted as a scan. Anything the caller
  // already put on the URL is left alone.
  if (ours && !data.includes('?')) data += '?s=qr'

  const style = qrStyleFor(req.user)

  // Per-request overrides, so the editor can preview a style before it is
  // saved. Entitlement is still what decides: an account without it gets the
  // plain code whatever it puts in the query string. The logo is not overridable
  // here because it lives on the account, not in a URL.
  if (can(req.user, 'brandedQr')) {
    const hex = (v) => (/^#?[0-9a-fA-F]{6}$/.test(String(v || '')) ? '#' + String(v).replace('#', '') : null)
    const q = req.query
    if (hex(q.color)) style.dark = hex(q.color)
    if (hex(q.bg)) style.light = hex(q.bg)
    if (q.bg === 'transparent') style.light = 'transparent'
    if (QR_MODULE_STYLES.includes(q.style)) style.style = q.style
    if (QR_EYE_STYLES.includes(q.eyes)) style.eyeStyle = q.eyes
    if (QR_EC_LEVELS.includes(q.ec)) style.ecLevel = q.ec
    if (q.caption !== undefined) style.caption = String(q.caption).replace(/[<>]/g, '').slice(0, 40)
    if (q.frame !== undefined) style.frame = q.frame === '1' || q.frame === 'true'
  }

  const name = String(req.query.name || 'qr').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || 'qr'
  const size = Math.min(Math.max(Number(req.query.size) || 512, 96), 2048)

  try {
    // PNG stays for API callers and anything that cannot render SVG. It is the
    // plain code: styling, logos and captions are drawn in SVG, which the
    // browser turns into a PNG at whatever resolution the person asks for.
    if (req.query.format === 'png') {
      const buf = await QRCode.toBuffer(data, {
        margin: 1,
        color: { dark: style.dark, light: style.light === 'transparent' ? '#FFFFFF' : style.light },
        type: 'png',
        width: size,
      })
      if (req.query.download) res.set('Content-Disposition', `attachment; filename="${name}.png"`)
      return res.type('image/png').send(buf)
    }

    const svg = renderQrSvg(data, { ...style, size })
    if (req.query.download) res.set('Content-Disposition', `attachment; filename="${name}.svg"`)
    res.type('image/svg+xml').send(svg)
  } catch {
    res.status(500).send('qr error')
  }
})

/**
 * The account's saved QR style.
 *
 * One style per account rather than one per code: people want their codes to
 * look like each other, and it keeps a logo out of every link record.
 */
app.get('/api/qr/style', requireUser, (req, res) => {
  res.json({
    style: qrStyleFor(req.user),
    entitled: can(req.user, 'brandedQr'),
    options: { modules: QR_MODULE_STYLES, eyes: QR_EYE_STYLES, ecLevels: QR_EC_LEVELS },
    maxLogoBytes: MAX_QR_LOGO_BYTES,
  })
})

/** A logo has to be small: it is stored on the account and sent with every code. */
const MAX_QR_LOGO_BYTES = 48 * 1024

app.patch('/api/qr/style', requireUser, async (req, res) => {
  const deny = requireFeature(req.user, 'brandedQr', 'QR customisation')
  if (deny) return res.status(deny.status).json(deny.body)

  const body = req.body || {}
  const next = { ...qrStyleFor(req.user) }

  const hex = (v) => (/^#?[0-9a-fA-F]{6}$/.test(String(v || '')) ? '#' + String(v).replace('#', '') : null)
  if (body.dark !== undefined) next.dark = hex(body.dark) || QR_DEFAULTS.dark
  if (body.light !== undefined) {
    next.light = body.light === 'transparent' ? 'transparent' : hex(body.light) || QR_DEFAULTS.light
  }
  if (body.style !== undefined) next.style = QR_MODULE_STYLES.includes(body.style) ? body.style : 'square'
  if (body.eyeStyle !== undefined) next.eyeStyle = QR_EYE_STYLES.includes(body.eyeStyle) ? body.eyeStyle : 'square'
  if (body.ecLevel !== undefined) next.ecLevel = QR_EC_LEVELS.includes(body.ecLevel) ? body.ecLevel : 'M'
  if (body.caption !== undefined) next.caption = String(body.caption).replace(/[<>]/g, '').trim().slice(0, 40)
  if (body.frame !== undefined) next.frame = Boolean(body.frame)

  if (body.logo !== undefined) {
    if (!body.logo) {
      next.logo = null
    } else {
      const logo = String(body.logo)
      // Only a real image data URI, and only a small one. An SVG logo can carry
      // script, so it is not accepted: it would be served back inside our own
      // SVG and rendered on our own origin.
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logo)) {
        return res.status(400).json({ error: 'Upload a PNG, JPEG or WebP image.' })
      }
      if (logo.length > MAX_QR_LOGO_BYTES) {
        return res.status(413).json({ error: `That image is too large. Keep it under ${Math.round(MAX_QR_LOGO_BYTES / 1024)}KB.` })
      }
      next.logo = logo
    }
  }

  req.user.qr = next
  await users.update(req.user)
  res.json({ style: next })
})

/* ============================== guest links =============================== */

/**
 * Guest analytics, addressed by an unguessable management token. Knowing the
 * short code is deliberately not enough: the public URL is meant to be shared,
 * the token is not.
 */
app.get('/api/guest/stats', limit('guestlookup:hour'), async (req, res) => {
  const token = String(req.query.t || '')
  if (!token) return res.status(400).json({ error: 'Missing token' })
  const link = await store.byGuestToken(token)
  if (!link) return res.status(404).json({ error: 'That tracking link was not found or has expired' })
  const summary = await store.linkSummary(link.slug)
  trackAsync('guest_link_viewed_stats')
  res.json({
    ...summary,
    shortUrl: shortUrl(link.slug),
    expiresAt: link.expiresAt,
    claimable: Boolean(link.guest),
  })
})

/** Attach guest links to an account after signup or login. */
async function claimGuestLinks(tokens, user) {
  if (!Array.isArray(tokens) || !tokens.length || !user) return 0
  let claimed = 0
  for (const token of tokens.slice(0, 20)) {
    try {
      const link = await store.byGuestToken(String(token))
      if (!link || !link.guest) continue
      await store.claim(link.slug, user.id)
      await store.logActivity(user.id, { type: 'claimed', slug: link.slug, at: Date.now() })
      claimed++
    } catch {
      /* one bad token must not fail the signup */
    }
  }
  return claimed
}

app.post('/api/guest/claim', requireUser, async (req, res) => {
  const tokens = Array.isArray(req.body?.tokens) ? req.body.tokens : [req.body?.token].filter(Boolean)
  const claimed = await claimGuestLinks(tokens, req.user)
  res.json({ claimed })
})

/* ============================== abuse reports ============================= */

app.get('/api/report/reasons', (_req, res) => res.json({ reasons: REPORT_REASONS }))

app.post('/api/report', limit('report:hour'), async (req, res) => {
  const raw = String(req.body?.link || '').trim()
  if (!raw) return res.status(400).json({ error: 'Which link are you reporting?' })

  // Accept a full short URL or just the code.
  let slug = raw
  try {
    if (/^https?:\/\//i.test(raw)) slug = new URL(raw).pathname.replace(/^\//, '')
  } catch {
    /* treat it as a bare slug */
  }
  slug = slug.split('?')[0].split('#')[0].trim()
  if (!/^[a-zA-Z0-9_-]{2,32}$/.test(slug)) return res.status(400).json({ error: 'That does not look like an ashrt.link URL' })

  const link = await store.get(slug)
  if (!link) return res.status(404).json({ error: 'We have no record of that link' })

  const report = await createReport({
    slug,
    url: link.url,
    owner: link.owner,
    reason: String(req.body?.reason || 'other'),
    detail: String(req.body?.detail || ''),
    reporterHash: clientId(req),
  })

  // Enough distinct complaints raises a flag for a human. Reports never disable
  // a link on their own: that would be a takedown button for anyone.
  if (link.status === 'active' && (await shouldAutoFlag(slug))) {
    link.status = 'flagged'
    link.flagReason = 'reports'
    await store.add(link)
    await audit({
      actor: null,
      action: 'link.auto_flagged',
      targetType: 'link',
      targetId: slug,
      meta: { reason: 'report-threshold' },
    })
  }

  res.json({ ok: true, id: report.id })
})

/* ================================= admin ================================== */

/**
 * Everything below requires a signed-in account whose record carries the admin
 * role. The check is server-side and runs on every request; nothing here is
 * gated by hiding a button, and the client is never told the admin API exists
 * (requireAdmin answers 404, not 403).
 */
app.use('/api/admin', requireUser, requireAdmin)

/** Admin-only view of an account. Never includes secrets. */
function adminUser(u, extra = {}) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    plan: planIdOf(u),
    // Same reasoning as safeUser: an account the bootstrap allowlist grants
    // admin to should show as an admin in the user list, not as a normal user.
    role: isAdmin(u) ? 'admin' : 'user',
    status: u.status || 'active',
    provider: u.provider || 'password',
    createdAt: u.createdAt,
    // Metadata about the API key, never the key itself or its hash.
    hasApiKey: Boolean(u.apiKey || u.apiKeyHash),
    apiKeyCreatedAt: u.apiKeyCreatedAt || u.createdAt || null,
    apiDisabled: Boolean(u.apiDisabled),
    stripeCustomerId: u.stripeCustomerId || null,
    subscriptionStatus: u.subscriptionStatus || null,
    suspendedAt: u.suspendedAt || null,
    suspendedReason: u.suspendedReason || null,
    notes: u.notes || [],
    flags: u.flags || [],
    ...extra,
  }
}

/** Notes are shown back in the admin UI, so strip anything tag-shaped. */
const cleanNote = (text) =>
  String(text || '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 2000)

app.get('/api/admin/overview', async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365)
  const dayMs = 864e5
  const now = Date.now()

  const [userCount, linkCount, campaignCount, clicksByDay, newToday, new7, new30, plans, statuses] =
    await Promise.all([
      users.count(),
      store.totalLinks(),
      campaigns.count(),
      store.clicksByDay(),
      users.countSince(new Date().setUTCHours(0, 0, 0, 0)),
      users.countSince(now - 7 * dayMs),
      users.countSince(now - 30 * dayMs),
      users.planDistribution(),
      store.statusCounts(),
    ])

  const day = new Date().toISOString().slice(0, 10)
  const totalClicks = Object.values(clicksByDay).reduce((s, n) => s + n, 0)

  // Domains a customer has finished their half of. Without this, someone can
  // publish their DNS correctly and then wait indefinitely on a step only we
  // can take, with nothing anywhere saying so.
  // Links whose destination has failed twice in a row. Service-wide, because an
  // outage on one popular destination usually shows up as many links at once.
  const brokenLinks = []
  for (const l of await store.all()) {
    if (isBroken(l)) brokenLinks.push({ slug: l.slug, url: l.url, status: l.health.status, clicks: l.clicks || 0 })
  }
  brokenLinks.sort((a, b) => b.clicks - a.clicks)

  const waitingDomains = []
  for (const u of await users.all()) {
    for (const d of u.domains || []) {
      if (d.status === 'pending_platform' || d.status === 'error') {
        waitingDomains.push({ domain: d.domain, email: u.email, userId: u.id, status: d.status })
      }
    }
  }

  // Clicks over the requested window, gaps filled so the chart is continuous.
  const series = {}
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(now - i * dayMs).toISOString().slice(0, 10)
    series[key] = clicksByDay[key] || 0
  }
  const windowClicks = Object.values(series).reduce((s, n) => s + n, 0)

  res.json({
    users: { total: userCount, today: newToday, last7: new7, last30: new30, ...plans },
    links: {
      total: linkCount,
      active: statuses.active || 0,
      flagged: statuses.flagged || 0,
      disabled: statuses.disabled || 0,
      expired: statuses.expired || 0,
      guest: statuses.guest || 0,
      owned: statuses.owned || 0,
      counted: statuses.scanned,
    },
    campaigns: campaignCount,
    domainsWaiting: waitingDomains.slice(0, 25),
    brokenLinks: brokenLinks.slice(0, 25),
    brokenLinksTotal: brokenLinks.length,
    clicks: { total: totalClicks, today: clicksByDay[day] || 0, window: windowClicks },
    series,
    days,
    billing: {
      enabled: billingEnabled(),
      paid: (plans.pro || 0) + (plans.business || 0),
      free: plans.free || 0,
    },
  })
})

/* ------------------------------ admin: users ------------------------------ */

app.get('/api/admin/users', async (req, res) => {
  const q = String(req.query.q || '').trim()
  const filter = String(req.query.filter || '')
  const cursor = Math.max(Number(req.query.cursor) || 0, 0)
  const limitN = Math.min(Number(req.query.limit) || 50, 200)

  let rows
  let total
  let nextCursor = null
  if (q) {
    rows = await users.search(q, { limit: limitN })
    total = rows.length
  } else {
    const page = await users.page({ cursor, limit: limitN })
    rows = page.users
    total = page.total
    nextCursor = page.nextCursor
  }

  if (filter === 'paid') rows = rows.filter((u) => PAID_PLANS.includes(planIdOf(u)))
  else if (filter === 'free') rows = rows.filter((u) => planIdOf(u) === 'free')
  else if (filter === 'suspended') rows = rows.filter((u) => u.status === 'suspended')
  else if (filter === 'admin') rows = rows.filter((u) => u.role === 'admin')

  // Per-user totals in two round-trips rather than two per user.
  const ids = rows.map((u) => u.id)
  const [counts, clicks] = await Promise.all([store.countsByOwners(ids), store.clicksByOwner()])

  res.json({
    users: rows.map((u) => adminUser(u, { links: counts[u.id] || 0, clicks: clicks[u.id] || 0 })),
    total,
    nextCursor,
  })
})

app.get('/api/admin/users/:id', async (req, res) => {
  const user = await users.getById(req.params.id)
  if (!user) return res.status(404).json({ error: 'Not found' })

  const links = await store.byOwner(user.id)
  const camps = await campaigns.byOwner(user.id)
  const usage = await apiUsage.byDay(user.id)
  const month = new Date().toISOString().slice(0, 7)

  res.json({
    user: adminUser(user, {
      links: links.length,
      clicks: links.reduce((s, l) => s + (l.clicks || 0), 0),
      botClicks: links.reduce((s, l) => s + (l.botClicks || 0), 0),
      campaigns: camps.length,
      apiCallsThisMonth: Object.entries(usage).reduce((s, [d, n]) => (d.startsWith(month) ? s + n : s), 0),
      flaggedLinks: links.filter((l) => effectiveStatus(l) === 'flagged').length,
      disabledLinks: links.filter((l) => effectiveStatus(l) === 'disabled').length,
    }),
    links: links.slice(0, 100).map((l) => publicLink(l, { admin: true })),
    campaigns: camps,
    apiUsage: usage,
  })
})

/**
 * Account actions.
 *
 * Suspension is the default lever, not deletion: it is reversible, it takes
 * effect on the next request (attachUser refuses a suspended account), and it
 * leaves the evidence in place. There is no hard-delete action here on purpose.
 */
app.patch('/api/admin/users/:id', async (req, res) => {
  const user = await users.getById(req.params.id)
  if (!user) return res.status(404).json({ error: 'Not found' })

  const action = String(req.body?.action || '')
  const reason = cleanNote(req.body?.reason)

  // An admin must not be able to lock themselves out or strip their own role.
  if (user.id === req.user.id && ['suspend', 'demote'].includes(action)) {
    return res.status(400).json({ error: 'You cannot do that to your own account' })
  }

  switch (action) {
    case 'suspend':
      user.status = 'suspended'
      user.suspendedAt = Date.now()
      user.suspendedBy = req.user.id
      user.suspendedReason = reason
      break
    case 'restore':
      user.status = 'active'
      user.suspendedAt = null
      user.suspendedBy = null
      user.suspendedReason = null
      break
    case 'disable-api':
      user.apiDisabled = true
      break
    case 'enable-api':
      user.apiDisabled = false
      break
    case 'revoke-key': {
      // Every key on the account, not one of them. This action exists for a
      // compromised account, and leaving the other keys working would defeat
      // it. The owner mints a new one themselves; we cannot hand them a key,
      // because keys are shown once and we do not keep the plaintext.
      const removedKeyHashes = keysOf(user).map((k) => k.hash)
      user.apiKey = null
      user.apiKeyHash = null
      user.apiKeys = []
      await users.update(user, { removedKeyHashes })
      await audit({
        actor: req.user,
        action: 'user.revoke-key',
        targetType: 'user',
        targetId: user.id,
        meta: { reason, revoked: removedKeyHashes.length },
      })
      return res.json({ user: adminUser(user), revoked: removedKeyHashes.length })
    }
    case 'note':
      if (!reason) return res.status(400).json({ error: 'Write something in the note' })
      user.notes = [
        ...(user.notes || []),
        { at: Date.now(), by: req.user.id, byEmail: req.user.email, text: reason },
      ].slice(-100)
      break
    case 'flag':
      user.flags = Array.from(new Set([...(user.flags || []), reason || 'review']))
      break
    case 'unflag':
      user.flags = (user.flags || []).filter((f) => f !== reason)
      break
    case 'promote':
      user.role = 'admin'
      break
    case 'demote':
      user.role = 'user'
      break
    default:
      return res.status(400).json({ error: 'Unknown action' })
  }

  await users.update(user)
  await audit({ actor: req.user, action: `user.${action}`, targetType: 'user', targetId: user.id, meta: { reason } })
  res.json({ user: adminUser(user) })
})

/* ------------------------------ admin: links ------------------------------ */

app.get('/api/admin/links', async (req, res) => {
  const cursor = Math.max(Number(req.query.cursor) || 0, 0)
  const limitN = Math.min(Number(req.query.limit) || 50, 200)
  const q = String(req.query.q || '').trim()
  const status = String(req.query.status || '').trim()
  const owner = String(req.query.owner || '').trim()
  const guestParam = req.query.guest
  const guest = guestParam === undefined || guestParam === '' ? null : guestParam === 'true'

  const filtering = Boolean(q || status || owner || guest !== null)
  const result = filtering
    ? await store.searchPage({ q, status, owner, guest, cursor, limit: limitN })
    : await store.page({ cursor, limit: limitN })

  const links = result.links.map((l) => publicLink(l, { admin: true }))

  // Attach the owning account's email so support does not have to cross-
  // reference ids by hand.
  const ownerIds = [...new Set(links.map((l) => l.owner).filter(Boolean))]
  const owners = {}
  for (const id of ownerIds) {
    const u = await users.getById(id)
    if (u) owners[id] = { id: u.id, email: u.email, status: u.status || 'active', plan: planIdOf(u) }
  }

  res.json({
    links,
    owners,
    total: result.total,
    nextCursor: result.nextCursor,
    truncated: Boolean(result.truncated),
    scanned: result.scanned,
  })
})

app.get('/api/admin/links/:slug', async (req, res) => {
  const link = await store.get(req.params.slug)
  if (!link) return res.status(404).json({ error: 'Not found' })
  const summary = await store.linkSummary(req.params.slug)
  const owner = link.owner ? await users.getById(link.owner) : null
  res.json({
    link: publicLink(link, { admin: true }),
    stats: summary,
    owner: owner ? { id: owner.id, email: owner.email, plan: planIdOf(owner), status: owner.status || 'active' } : null,
    reports: await reportsForLink(req.params.slug),
    notes: link.adminNotes || [],
  })
})

app.patch('/api/admin/links/:slug', async (req, res) => {
  const link = await store.get(req.params.slug)
  if (!link) return res.status(404).json({ error: 'Not found' })
  const action = String(req.body?.action || '')
  const reason = cleanNote(req.body?.reason)

  switch (action) {
    case 'disable':
      link.status = 'disabled'
      link.disabledAt = Date.now()
      link.disabledBy = req.user.id
      link.disabledReason = reason
      break
    case 'enable':
      link.status = 'active'
      link.disabledAt = null
      link.disabledBy = null
      link.disabledReason = null
      break
    case 'flag':
      link.status = 'flagged'
      link.flagReason = reason
      break
    case 'unflag':
      link.status = 'active'
      link.flagReason = null
      break
    case 'note':
      if (!reason) return res.status(400).json({ error: 'Write something in the note' })
      link.adminNotes = [
        ...(link.adminNotes || []),
        { at: Date.now(), by: req.user.id, byEmail: req.user.email, text: reason },
      ].slice(-100)
      break
    default:
      return res.status(400).json({ error: 'Unknown action' })
  }

  await store.add(link)
  await audit({ actor: req.user, action: `link.${action}`, targetType: 'link', targetId: link.slug, meta: { reason } })
  res.json(publicLink(link, { admin: true }))
})

/**
 * Deleting a link is permanent and takes its click history with it, so it is
 * deliberately awkward: the caller has to name the slug again in the body. Use
 * disable for anything reversible.
 */
app.delete('/api/admin/links/:slug', async (req, res) => {
  const link = await store.get(req.params.slug)
  if (!link) return res.json({ ok: true })
  if (req.body?.confirm !== req.params.slug) {
    return res.status(400).json({
      error: 'Confirm the deletion by sending the slug back. Prefer disabling: it is reversible.',
    })
  }
  await store.remove(req.params.slug)
  await audit({
    actor: req.user,
    action: 'link.delete',
    targetType: 'link',
    targetId: req.params.slug,
    meta: { url: link.url, owner: link.owner, clicks: link.clicks || 0 },
  })
  res.json({ ok: true })
})

app.get('/api/admin/links/:slug/reports', async (req, res) => {
  res.json({ reports: await reportsForLink(req.params.slug) })
})

/* ------------------------------ admin: abuse ------------------------------ */

app.get('/api/admin/abuse', async (req, res) => {
  const status = String(req.query.status || '').trim() || null
  const cursor = Math.max(Number(req.query.cursor) || 0, 0)
  const [reportPage, blocked, flagged] = await Promise.all([
    listReports({ status, cursor, limit: 100 }),
    blockedEntries(),
    store.searchPage({ status: 'flagged', limit: 100 }),
  ])
  res.json({
    reports: reportPage.reports,
    totalReports: reportPage.total,
    nextCursor: reportPage.nextCursor,
    blocked,
    flagged: flagged.links.map((l) => publicLink(l, { admin: true })),
    reasons: REPORT_REASONS,
  })
})

app.patch('/api/admin/abuse/reports/:id', async (req, res) => {
  const updated = await updateReport(
    req.params.id,
    { status: req.body?.status, note: cleanNote(req.body?.note) || undefined },
    { actor: req.user },
  )
  if (!updated) return res.status(404).json({ error: 'Not found' })
  res.json({ report: updated })
})

app.get('/api/admin/blocked', async (_req, res) => {
  res.json({ blocked: await blockedEntries() })
})

app.post('/api/admin/blocked', async (req, res) => {
  const result = await blockDomain(req.body?.domain, { reason: cleanNote(req.body?.reason), actor: req.user })
  if (!result.ok) return res.status(400).json({ error: result.error })
  res.json({ blocked: await blockedEntries(), domain: result.domain })
})

app.delete('/api/admin/blocked/:domain', async (req, res) => {
  await unblockDomain(req.params.domain, { actor: req.user })
  res.json({ blocked: await blockedEntries() })
})

/* ----------------------------- admin: funnel ------------------------------ */

/**
 * Whether search traffic becomes users. The reason the instrumentation exists.
 */
app.get('/api/admin/funnel', async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365)
  const [{ series, totals, days: dayKeys }, signupSources, subSources] = await Promise.all([
    eventSeries(days),
    acquisition(days, 'signup_completed'),
    acquisition(days, 'subscription_started'),
  ])

  // Where the people who arrived came from, so a weak signup rate can be told
  // apart from weak traffic.
  const visitorSources = await acquisition(days, 'page_view_home')
  const landingSources = await acquisition(days, 'page_view_landing')
  const arrivals = {}
  for (const [k, v] of Object.entries(visitorSources)) arrivals[k] = (arrivals[k] || 0) + v
  for (const [k, v] of Object.entries(landingSources)) arrivals[k] = (arrivals[k] || 0) + v

  res.json({
    days,
    dayKeys,
    funnel: buildFunnel(totals),
    totals,
    series,
    acquisition: { arrivals, signups: signupSources, subscriptions: subSources },
  })
})

/* ----------------------------- admin: billing ----------------------------- */

/**
 * Revenue reporting.
 *
 * Stripe is the source of truth for payment state and this does not try to be a
 * second ledger. It reports what our own records say about plans and
 * subscription status, which is what support work actually needs: who is on
 * what, whose payment is failing, and roughly what is recurring.
 *
 * MRR here is plan price times subscriber count. It is an estimate and is
 * labelled as one: it does not know about discounts, proration, coupons,
 * annual billing or tax. For the real number, read Stripe.
 */
const PLAN_PRICES = { free: 0, pro: 9, business: 29 }

app.get('/api/admin/billing', async (_req, res) => {
  const all = await users.all()

  const byPlan = { free: 0, pro: 0, business: 0 }
  const byStatus = {}
  const problems = []
  let withCustomer = 0
  let estimatedMrr = 0

  for (const u of all) {
    const plan = planIdOf(u)
    byPlan[plan] = (byPlan[plan] || 0) + 1
    if (u.stripeCustomerId) withCustomer++

    const status = u.subscriptionStatus || (PAID_PLANS.includes(plan) ? 'active' : 'none')
    byStatus[status] = (byStatus[status] || 0) + 1

    if (PAID_PLANS.includes(plan) && ['active', 'trialing'].includes(status)) {
      estimatedMrr += PLAN_PRICES[plan] || 0
    }

    // Accounts needing a human: payment failing, or a paid plan with no Stripe
    // customer behind it, which means the two sides have drifted apart.
    const failing = ['past_due', 'unpaid', 'incomplete', 'incomplete_expired'].includes(status)
    const orphaned = PAID_PLANS.includes(plan) && !u.stripeCustomerId
    if (failing || orphaned) {
      problems.push({
        id: u.id,
        email: u.email,
        plan,
        status,
        reason: failing ? 'payment failing' : 'paid plan with no Stripe customer',
        stripeCustomerId: u.stripeCustomerId || null,
      })
    }
  }

  const paid = byPlan.pro + byPlan.business
  res.json({
    enabled: billingEnabled(),
    available: { pro: planAvailable('pro'), business: planAvailable('business') },
    byPlan,
    byStatus,
    paid,
    free: byPlan.free,
    withCustomer,
    estimatedMrr,
    estimatedArr: estimatedMrr * 12,
    conversionRate: all.length ? Math.round((paid / all.length) * 1000) / 10 : 0,
    prices: PLAN_PRICES,
    problems: problems.slice(0, 100),
    // Said plainly in the payload so the UI cannot present it as authoritative.
    note: 'MRR is estimated from plan price times active subscribers. It does not account for discounts, proration, tax or annual billing. Stripe is the source of truth.',
  })
})

/* ------------------------------ admin: audit ------------------------------ */

app.get('/api/admin/audit', async (req, res) => {
  const cursor = Math.max(Number(req.query.cursor) || 0, 0)
  const limitN = Math.min(Number(req.query.limit) || 100, 500)
  const log = await auditLog({ cursor, limit: limitN, action: String(req.query.action || '') || null })

  // Resolve the user ids the log stores into the emails an admin recognizes.
  // Batched: an audit page should not cost one lookup per row.
  const ids = [...new Set(log.entries.filter((e) => e.targetType === 'user').map((e) => e.targetId))]
  const found = await users.byIds(ids)
  const emails = Object.fromEntries(found.map((u) => [u.id, u.email]))

  res.json({
    ...log,
    entries: log.entries.map((e) => ({
      ...e,
      targetLabel: e.targetType === 'user' ? emails[e.targetId] || e.targetId : e.targetId,
    })),
  })
})

/* ------------------------------ admin: health ----------------------------- */

/**
 * Storage integrity: does every index agree with the records behind it?
 *
 * This exists because the alternative was telling an operator to copy
 * production database credentials onto a laptop to run a command line tool.
 * The check itself is shared with `npm run doctor`, so both answer the same.
 */
app.get('/api/admin/health', async (req, res) => {
  const who = String(req.query.user || '').trim() || null
  const report = await checkIntegrity({ user: who })

  // The fix list is an implementation detail and can be enormous. The browser
  // needs the counts and the evidence, not the command stream.
  const { fixes, ...rest } = report
  res.json({
    ...rest,
    fixable: fixes.length,
    accounts: rest.accounts.slice(0, 200),
    accountsShown: Math.min(rest.accounts.length, 200),
    zsetMissing: rest.zsetMissing.slice(0, 50),
    zsetMissingTotal: report.zsetMissing.length,
  })
})

/**
 * Rebuild the indexes from the records.
 *
 * Deliberately narrow: it adds and removes index entries and does nothing else.
 * No link is deleted, no destination is changed, no click count is touched, so
 * the worst case of running it at the wrong moment is wasted writes. It still
 * asks for confirmation and still lands in the audit log, because an operator
 * should be able to see afterwards who ran it and what it did.
 */
app.post('/api/admin/health/repair', async (req, res) => {
  if (req.body?.confirm !== 'repair') {
    return res.status(400).json({ error: 'Send confirm: "repair" to run this.' })
  }
  const who = String(req.body?.user || '').trim() || null
  const report = await checkIntegrity({ user: who })
  if (!report.fixes.length) return res.json({ ok: true, applied: 0, attempted: 0 })

  const result = await applyFixes(report.fixes)
  await audit({
    actor: req.user,
    action: 'system.reindex',
    targetType: 'system',
    targetId: who || 'all',
    meta: {
      applied: result.applied,
      attempted: result.attempted,
      accounts: report.accounts.filter((a) => !a.healthy).length,
      recencyGaps: report.zsetMissing.length,
    },
  })
  res.json({ ok: true, ...result })
})

/* --------------------------- branded host routing ------------------------- */

/**
 * A customer's branded host serves their short links and nothing else.
 *
 * Without this, `links.theircompany.com` would also serve our homepage, our
 * pricing, our signup form and the dashboard, all on their domain. That is
 * confusing at best, and a cookie-scope and phishing problem at worst. Anything
 * that is not a redirect goes to the canonical site instead.
 */
app.use(async (req, res, next) => {
  if (!CUSTOM_DOMAINS_LIVE) return next()
  const host = req.get('host')
  if (hostMatchesSelf(host)) return next()

  const brand = await ownerForHost(host)
  if (!brand) return next()

  // The bare host, and any non-slug path, belong to us, not to the brand.
  //
  // "signup", "login" and "dashboard" all match the short-code pattern, so a
  // naive shape check would hand a customer's domain our signup form. A path is
  // only a short code here if it is not one of our own reserved names.
  const path = req.path.replace(/\/$/, '') || '/'
  const isSlug =
    /^\/[a-zA-Z0-9_-]{1,32}$/.test(req.path) && !RESERVED.has(req.path.slice(1).toLowerCase())
  if (isSlug && req.method === 'GET') return next()
  if (path === '/robots.txt') {
    // A branded host must not be indexed: its content is redirects.
    return res.type('text/plain').send('User-agent: *\nDisallow: /\n')
  }

  // Somebody typed the bare domain, or followed a link to it. Sending them to
  // our homepage on their own company's domain is the wrong answer, so the
  // account gets to say where it goes. Unset, they land on the canonical site.
  if (path === '/' && brand.entry.rootRedirect) {
    res.set('Cache-Control', 'no-store')
    return res.redirect(302, brand.entry.rootRedirect)
  }
  return res.redirect(302, CANONICAL_URL + (path === '/' ? '' : path))
})

/* ============================ funnel measurement ========================== */

/** The public pages whose traffic is the top of the funnel. */
const LANDING_PATHS = new Set([
  '/utm-link-tracker',
  '/qr-code-tracking',
  '/qr-code-generator',
  '/bitly-alternative',
  '/pricing',
])

/**
 * Count a view of a public page, server-side.
 *
 * Doing this here rather than with a browser beacon means it is not blocked,
 * not dropped on a fast bounce, and not forgeable. Bots are excluded using the
 * same classifier the redirect uses, so crawler traffic does not inflate the
 * top of the funnel and make conversion look worse than it is.
 */
app.use((req, res, next) => {
  if (req.method !== 'GET') return next()
  const path = req.path.replace(/\/$/, '') || '/'
  const isHome = path === '/'
  const isLanding = LANDING_PATHS.has(path)
  const isSignup = path === '/signup'
  if (!isHome && !isLanding && !isSignup) return next()
  if (classifyRequest(req).isBot) return next()

  const source = sourceOf(req.get('referer'), { landing: SELF_HOST })
  if (isSignup) trackAsync('signup_viewed', { source })
  else trackAsync(isHome ? 'page_view_home' : 'page_view_landing', { source })
  next()
})

/**
 * The few events only a browser can see: someone starting to type in the
 * tracker, or clicking an upgrade button. Everything else is observed
 * server-side, so this endpoint accepts a short allowlist and nothing more.
 */
app.post('/api/events', limit('redirect:minute'), (req, res) => {
  const name = String(req.body?.event || '')
  if (!CLIENT_EVENTS.has(name)) return res.status(204).end()
  if (classifyRequest(req).isBot) return res.status(204).end()
  trackAsync(name, { source: sourceOf(req.get('referer'), { landing: SELF_HOST }) })
  res.status(204).end()
})

/* ================================== SEO =================================== */

/**
 * Public, indexable pages. Generated rather than hand-kept so a page cannot be
 * added and then silently left out of the sitemap.
 *
 * Only genuinely distinct pages belong here. Thin keyword-swapped variants of
 * the homepage would be worse than not having them.
 */
const PUBLIC_PAGES = [
  { path: '/', priority: '1.0', changefreq: 'weekly' },
  { path: '/pricing', priority: '0.9', changefreq: 'monthly' },
  { path: '/utm-link-tracker', priority: '0.8', changefreq: 'monthly' },
  { path: '/qr-code-tracking', priority: '0.8', changefreq: 'monthly' },
  { path: '/qr-code-generator', priority: '0.8', changefreq: 'monthly' },
  { path: '/bitly-alternative', priority: '0.7', changefreq: 'monthly' },
  { path: '/report', priority: '0.3', changefreq: 'yearly' },
  { path: '/privacy', priority: '0.3', changefreq: 'yearly' },
  { path: '/terms', priority: '0.3', changefreq: 'yearly' },
]

app.get('/sitemap.xml', (_req, res) => {
  const today = new Date().toISOString().slice(0, 10)
  const urls = PUBLIC_PAGES.filter((p) => {
    // Never advertise a page that does not exist yet.
    const file = p.path === '/' ? 'index.html' : `${p.path.replace(/^\//, '')}.html`
    try {
      return readdirSync(PUBLIC_DIR).includes(file)
    } catch {
      return p.path === '/'
    }
  })
    .map(
      (p) => `  <url>
    <loc>${BASE_URL}${p.path}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`,
    )
    .join('\n')

  res
    .type('application/xml')
    .set('Cache-Control', 'public, max-age=3600')
    .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`)
})

/* ------------------------ static pages + redirect ------------------------- */

/**
 * The admin pages are gated before express.static ever sees them. Serving the
 * shell to anyone and relying on the API to refuse would still confirm that
 * /admin exists, which is exactly what requireAdmin's 404 is written to avoid.
 */
app.get(/^\/admin(\/.*)?$/, (req, res, next) => {
  if (!isAdmin(req.user)) return res.status(404).type('html').send(notFoundPage())
  res.set('Cache-Control', 'no-store')
  next()
})

app.use(
  express.static(PUBLIC_DIR, {
    extensions: ['html'],
    setHeaders(res, path) {
      if (/\.(css|js|svg)$/.test(path)) res.set('Cache-Control', 'public, max-age=3600')
    },
  }),
)

const BROWSERS = [
  [/edg\//i, 'Edge'], [/opr\/|opera/i, 'Opera'], [/samsungbrowser/i, 'Samsung Internet'],
  [/firefox\//i, 'Firefox'], [/chrome\/|crios/i, 'Chrome'], [/safari\//i, 'Safari'],
]
const SYSTEMS = [
  [/windows nt/i, 'Windows'], [/iphone|ipad|ipod/i, 'iOS'], [/mac os x|macintosh/i, 'macOS'],
  [/android/i, 'Android'], [/cros/i, 'ChromeOS'], [/linux/i, 'Linux'],
]
const firstMatch = (list, ua, fallback) => list.find(([re]) => re.test(ua))?.[1] || fallback

/**
 * Analytics context for one click. The visitor id is an HMAC of IP plus
 * user-agent, truncated: enough to count a repeat visitor, not enough to
 * identify one, and the raw IP is never written anywhere.
 */
function clickContext(req) {
  const ua = req.get('user-agent') || ''
  const bot = classifyRequest(req)
  const device = /tablet|ipad/i.test(ua) ? 'tablet' : /mobi|android|iphone|ipod/i.test(ua) ? 'mobile' : 'desktop'
  const country = req.get('x-vercel-ip-country') || 'XX'

  let refHost = 'Direct'
  const ref = req.get('referer')
  if (ref) {
    try {
      refHost = new URL(ref).hostname.replace(/^www\./, '')
    } catch {
      /* keep Direct */
    }
  }

  return {
    device,
    country,
    refHost,
    // Our own QR codes carry ?s=qr. The marker is read here and goes no
    // further: the destination never sees it.
    channel: req.query?.s === 'qr' ? 'qr' : 'link',
    browser: firstMatch(BROWSERS, ua, 'Other'),
    os: firstMatch(SYSTEMS, ua, 'Other'),
    isBot: bot.isBot,
    botName: bot.name,
    visitorId: bot.isBot ? null : hashClient(`${clientIp(req)}|${ua}`),
  }
}

const notFoundPage = () =>
  htmlPage(
    'Link not found',
    `<h1>404</h1><p>That short link does not exist, or it was removed.</p>
     <a class="btn" href="/">Create a tracking link</a>`,
  )

const gonePage = (heading, message) =>
  htmlPage(
    heading,
    `<h1>${heading}</h1><p>${message}</p><a class="btn" href="/">Create a tracking link</a>
     <p class="msg-foot"><a href="/report">Report a link</a></p>`,
  )

const interstitialPage = (link) =>
  htmlPage(
    'Check this link before continuing',
    `<h1>Hold on</h1>
     <p>This link has been flagged for review and has not been confirmed as safe.
        It points to:</p>
     <p class="msg-url">${String(link.url).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])}</p>
     <p>Continue only if you trust it.</p>
     <a class="btn" rel="nofollow noreferrer" href="${link.url}">Continue anyway</a>
     <p class="msg-foot"><a href="/report">Report this link</a> &middot; <a href="/">ashrt.link</a></p>`,
  )

app.get('/:slug', limit('redirect:minute'), async (req, res) => {
  const slug = req.params.slug

  // On a branded host, an unknown code can go somewhere the account chose
  // rather than to our 404 page on their domain.
  const brand = await ownerForHost(req.get('host'))
  const missing = () => {
    if (brand?.entry?.notFoundRedirect) {
      res.set('Cache-Control', 'no-store')
      return res.redirect(302, brand.entry.notFoundRedirect)
    }
    return res.status(404).type('html').send(notFoundPage())
  }

  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(slug)) return missing()

  const link = await store.get(slug)
  if (!link) return missing()

  // On a branded host, only that account's links resolve. Without this every
  // customer's domain would serve every link on the service, so one person's
  // domain could be used to launder someone else's destination.
  if (brand && link.owner !== brand.user.id) return missing()

  const status = effectiveStatus(link)
  if (status === 'disabled') {
    return res.status(410).type('html').send(gonePage('Link disabled', 'This link was disabled for violating our terms.'))
  }
  if (status === 'expired') {
    return res
      .status(410)
      .type('html')
      .send(gonePage('Link expired', 'This guest link has expired. Create a free account to keep links permanently.'))
  }

  const ctx = clickContext(req)

  // Where this particular visitor goes. The rules live on the record we have
  // already read, so this is a loop over a short array rather than a lookup.
  const routed = resolveDestination(link, ctx)
  ctx.ruleId = routed.rule?.id || 'default'

  // Re-check the destination against the blocklist on every redirect, so
  // blocking a domain immediately kills links that already point at it. A rule
  // destination is checked exactly like the link's own.
  const blocked = await blockedDomains()
  let safe = checkStored(routed.url, { blocked })
  if (!safe.ok && routed.rule) {
    // A blocked rule destination must not take the whole link down with it:
    // fall back to the link's own destination, which is checked in its turn.
    ctx.ruleId = 'default'
    safe = checkStored(link.url, { blocked })
  }
  if (!safe.ok) {
    return res.status(410).type('html').send(gonePage('Link disabled', safe.error))
  }

  if (status === 'flagged') {
    // Record the visit, then warn rather than forward silently.
    await store.recordClick(slug, ctx, link).catch(() => {})
    return res.status(200).type('html').send(interstitialPage(link))
  }

  await store.recordClick(slug, ctx, link).catch(() => {})
  res.set('Cache-Control', 'no-store')
  res.redirect(302, safe.url)
})

/* ================================= startup ================================ */

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  app.listen(PORT, () => {
    console.log(`\n  ashrt.link running at ${BASE_URL}`)
    console.log(`  store: ${store.driver}\n`)
  })
}

export default app
export { BASE_URL, RESERVED }
