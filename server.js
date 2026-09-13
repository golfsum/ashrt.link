import express from 'express'
import cors from 'cors'
import crypto from 'node:crypto'
import { readdirSync } from 'node:fs'
import dns from 'node:dns'
import { promisify } from 'node:util'
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

const dnsResolveTxt = promisify(dns.resolveTxt)

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
    if (u && (u.domains || []).some((d) => d.domain === h && d.status === 'verified') && u.status !== 'suspended') {
      owner = u
    }
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

app.use(express.json({ limit: '64kb' }))

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
  const brand = (user?.domains || []).find((d) => d.status === 'verified')
  if (CUSTOM_DOMAINS_LIVE && brand) return `https://${brand.domain}/${slug}`
  return `${BASE_URL}/${slug}`
}

const shortUrl = (slug) => `${BASE_URL}/${slug}`
const withUrl = (l) => ({ ...l, shortUrl: shortUrl(l.slug) })
const randomSlug = () => crypto.randomBytes(6).toString('base64url').slice(0, 7)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

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
  if (key) out.apiKey = u.apiKey || null
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

app.post('/api/account/rotate-key', requireUser, async (req, res) => {
  const oldApiKeyHash = req.user.apiKeyHash || hashApiKey(req.user.apiKey)
  const apiKey = newApiKey()
  req.user.apiKey = apiKey
  req.user.apiKeyHash = hashApiKey(apiKey)
  req.user.apiKeyCreatedAt = Date.now()
  await users.update(req.user, { oldApiKeyHash })
  trackAsync('api_key_created')
  res.json({ apiKey })
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

const DOMAIN_RE = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i

/**
 * Custom domains.
 *
 * The routing is real: a request arriving on a verified branded host resolves
 * that host to its owner and serves only that owner's links (see the redirect
 * handler). What is deliberately gated is *verification*: a domain has to prove
 * it is controlled by the account before it will serve anything, otherwise
 * anyone could claim `links.someoneelse.com` and catch traffic meant for them.
 *
 * Verification is a DNS TXT record. It needs no platform API and no secrets, it
 * is checked on demand, and it is re-checkable if a domain is ever moved.
 *
 * CUSTOM_DOMAINS=1 turns the feature on. It stays off by default because the
 * host also has to be pointed at this deployment at the platform level, which
 * is a manual step outside the app.
 */
const CUSTOM_DOMAINS_LIVE = process.env.CUSTOM_DOMAINS === '1'

/** The TXT value a domain must publish to prove it belongs to an account. */
function domainVerificationToken(userId, domain) {
  return (
    'ashrt-verify=' +
    crypto
      .createHmac('sha256', process.env.SESSION_SECRET || 'ashrt-dev-salt')
      .update(`${userId}|${domain.toLowerCase()}`)
      .digest('base64url')
      .slice(0, 32)
  )
}

const domainInstructions = (domain, token) => ({
  txt: { name: `_ashrt.${domain}`, type: 'TXT', value: token },
  cname: { name: domain, type: 'CNAME', value: 'cname.vercel-dns.com' },
})

app.get('/api/domains', requireUser, (req, res) => {
  const domains = (req.user.domains || []).map((d) => ({
    ...d,
    token: domainVerificationToken(req.user.id, d.domain),
    dns: domainInstructions(d.domain, domainVerificationToken(req.user.id, d.domain)),
  }))
  res.json({
    domains,
    available: CUSTOM_DOMAINS_LIVE,
    entitled: can(req.user, 'customDomains'),
    limit: limitFor(req.user, 'domains'),
  })
})

app.post('/api/domains', requireUser, async (req, res) => {
  if (!CUSTOM_DOMAINS_LIVE) {
    return res.status(503).json({
      error:
        'Custom domains are not switched on for this deployment yet. The routing is built, but the domain also has to be pointed here at the hosting level first.',
      unavailable: true,
    })
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

  // One account per domain, first to verify. Claiming here only reserves it;
  // it serves nothing until the TXT record checks out.
  const existing = await users.getByDomain(domain)
  if (existing && existing.id !== req.user.id) {
    return res.status(409).json({ error: 'That domain is already verified on another account' })
  }

  const token = domainVerificationToken(req.user.id, domain)
  req.user.domains.push({ domain, status: 'pending', addedAt: Date.now() })
  await users.update(req.user)

  await audit({
    actor: req.user,
    action: 'domain.added',
    targetType: 'domain',
    targetId: domain,
    meta: { owner: req.user.id },
  })
  res.json({ domains: req.user.domains, token, dns: domainInstructions(domain, token) })
})

/**
 * Check the TXT record and, if it matches, start serving links on this host.
 * Uses DNS directly rather than trusting anything the client says.
 */
app.post('/api/domains/:domain/verify', requireUser, async (req, res) => {
  if (!CUSTOM_DOMAINS_LIVE) return res.status(503).json({ error: 'Custom domains are not switched on', unavailable: true })

  const domain = String(req.params.domain || '').toLowerCase()
  const entry = (req.user.domains || []).find((d) => d.domain === domain)
  if (!entry) return res.status(404).json({ error: 'Not found' })

  const expected = domainVerificationToken(req.user.id, domain)
  let records = []
  try {
    records = await dnsResolveTxt(`_ashrt.${domain}`)
  } catch {
    return res.status(400).json({
      error: 'No TXT record found at _ashrt.' + domain + '. DNS changes can take a few minutes to propagate.',
      dns: domainInstructions(domain, expected),
    })
  }

  const flat = records.map((r) => (Array.isArray(r) ? r.join('') : String(r)).trim())
  if (!flat.includes(expected)) {
    return res.status(400).json({
      error: 'The TXT record does not match. Check the value and try again.',
      found: flat.slice(0, 5),
      dns: domainInstructions(domain, expected),
    })
  }

  const claim = await users.claimDomain(domain, req.user.id)
  if (!claim.ok) return res.status(409).json({ error: 'That domain is already verified on another account' })

  entry.status = 'verified'
  entry.verifiedAt = Date.now()
  await users.update(req.user)
  clearDomainCache(domain)

  await audit({ actor: req.user, action: 'domain.verified', targetType: 'domain', targetId: domain })
  res.json({ ok: true, domains: req.user.domains })
})

app.delete('/api/domains/:domain', requireUser, async (req, res) => {
  const domain = String(req.params.domain || '').toLowerCase()
  const owned = (req.user.domains || []).some((d) => d.domain === domain)
  req.user.domains = (req.user.domains || []).filter((d) => d.domain !== domain)
  await users.update(req.user)
  if (owned) {
    await users.releaseDomain(domain)
    clearDomainCache(domain)
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
app.post('/api/links', async (req, res) => {
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

  if (user) {
    const cap = limitFor(user, 'links')
    if (Number.isFinite(cap) && (await store.countByOwner(user.id)) >= cap) {
      return res.status(402).json({
        error: `Free accounts can keep ${cap} links. Upgrade for unlimited.`,
        needsUpgrade: true,
      })
    }
  }

  // The request is good and will produce a link, so now spend the budget.
  const budget = user
    ? [['create:user:hour', user.id]]
    : [
        ['create:guest:hour', guest],
        ['create:guest:day', guest],
        ['create:ip:hour', clientId(req)],
        ['create:ip:day', clientId(req)],
      ]
  for (const [name, id] of budget) {
    const r = await hit(name, id, { user })
    if (!r.allowed) {
      return tooMany(
        user
          ? 'You are creating links very quickly. Try again shortly.'
          : 'Guest link limit reached. Create a free account to keep going, it takes a moment.',
        r,
      )
    }
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

app.get('/api/links', requireUser, async (req, res) => {
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

app.patch('/api/links/:slug', requireUser, async (req, res) => {
  const link = await store.get(req.params.slug)
  if (!link) return res.status(404).json({ error: 'Link not found' })
  if (link.owner !== req.user.id) return res.status(403).json({ error: 'Not your link' })

  if (req.body?.url !== undefined) {
    const built = await buildLinkPayload(req, { user: req.user })
    if (built.error) return res.status(built.error.status).json(built.error.body)
    link.url = built.url
    link.flagScore = built.score
    link.flagSignals = built.signals
  }
  if (req.body?.campaign !== undefined) link.campaign = req.body.campaign || null
  if (req.body?.title !== undefined) link.title = String(req.body.title).trim().slice(0, 200) || null
  if (req.body?.tags !== undefined && Array.isArray(req.body.tags)) {
    link.tags = req.body.tags.slice(0, 10).map((t) => String(t).slice(0, 40))
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

app.get('/api/links/:slug/stats', requireUser, async (req, res) => {
  const link = await store.get(req.params.slug)
  if (!link) return res.status(404).json({ error: 'Link not found' })
  if (link.owner !== req.user.id) return res.status(403).json({ error: 'Not your link' })
  const summary = await store.linkSummary(req.params.slug)
  res.json({ ...summary, shortUrl: shortUrlFor(req.params.slug, req.user) })
})

app.delete('/api/links/:slug', requireUser, async (req, res) => {
  const link = await store.get(req.params.slug)
  if (!link) return res.json({ ok: true })
  if (link.owner !== req.user.id) return res.status(403).json({ error: 'Not your link' })
  await store.remove(req.params.slug)
  await store.logActivity(req.user.id, { type: 'deleted', slug: req.params.slug, at: Date.now() })
  res.json({ ok: true })
})

app.get('/api/stats', requireUser, async (req, res) => {
  const summary = await store.summary(req.user.id)
  const camps = await campaigns.byOwner(req.user.id)
  res.json({ ...summary, totalCampaigns: camps.length })
})

/* ------------------------------- QR codes --------------------------------- */

/**
 * QR codes. Signed-in users can encode anything; guests can encode only one of
 * our own short URLs, so the endpoint stays useful on the guest tracking page
 * without becoming a free general-purpose QR API for anyone to point a script at.
 */
app.get('/api/qr', limit('redirect:minute'), async (req, res) => {
  const data = String(req.query.data || '').slice(0, 2048)
  if (!data) return res.status(400).send('missing data')

  if (!req.user) {
    const ours = data.startsWith(`${BASE_URL}/`) && /^[a-zA-Z0-9_-]{1,32}$/.test(data.slice(BASE_URL.length + 1))
    if (!ours) return res.status(401).send('sign in to generate QR codes')
  }

  const wantColor = String(req.query.color || '').replace('#', '')
  const dark = can(req.user, 'brandedQr') && /^[0-9a-fA-F]{6}$/.test(wantColor) ? `#${wantColor}` : '#0A0A0A'
  const opts = { margin: 1, color: { dark, light: '#FFFFFF' } }
  const name = String(req.query.name || 'qr').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || 'qr'
  try {
    if (req.query.format === 'png') {
      const buf = await QRCode.toBuffer(data, { ...opts, type: 'png', width: 512 })
      if (req.query.download) res.set('Content-Disposition', `attachment; filename="${name}.png"`)
      return res.type('image/png').send(buf)
    }
    const svg = await QRCode.toString(data, { ...opts, type: 'svg' })
    if (req.query.download) res.set('Content-Disposition', `attachment; filename="${name}.svg"`)
    res.type('image/svg+xml').send(svg)
  } catch {
    res.status(500).send('qr error')
  }
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
      // Rotate to a fresh key the owner can retrieve, rather than leaving the
      // account with no way to use the API at all.
      const oldApiKeyHash = user.apiKeyHash || (user.apiKey ? hashApiKey(user.apiKey) : null)
      const key = newApiKey()
      user.apiKey = key
      user.apiKeyHash = hashApiKey(key)
      user.apiKeyCreatedAt = Date.now()
      await users.update(user, { oldApiKeyHash })
      await audit({ actor: req.user, action: 'user.revoke-key', targetType: 'user', targetId: user.id, meta: { reason } })
      return res.json({ user: adminUser(user) })
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

  const owner = await ownerForHost(host)
  if (!owner) return next()

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
  return res.redirect(302, CANONICAL_URL + (path === '/' ? '' : path))
})

/* ============================ funnel measurement ========================== */

/** The public pages whose traffic is the top of the funnel. */
const LANDING_PATHS = new Set(['/utm-link-tracker', '/qr-code-tracking'])

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
  { path: '/utm-link-tracker', priority: '0.8', changefreq: 'monthly' },
  { path: '/qr-code-tracking', priority: '0.8', changefreq: 'monthly' },
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
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(slug)) return res.status(404).type('html').send(notFoundPage())

  const link = await store.get(slug)
  if (!link) return res.status(404).type('html').send(notFoundPage())

  // On a branded host, only that account's links resolve. Without this every
  // customer's domain would serve every link on the service, so one person's
  // domain could be used to launder someone else's destination.
  const brandOwner = await ownerForHost(req.get('host'))
  if (brandOwner && link.owner !== brandOwner.id) {
    return res.status(404).type('html').send(notFoundPage())
  }

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

  // Re-check the destination against the blocklist on every redirect, so
  // blocking a domain immediately kills links that already point at it.
  const safe = checkStored(link.url, { blocked: await blockedDomains() })
  if (!safe.ok) {
    return res.status(410).type('html').send(gonePage('Link disabled', safe.error))
  }

  const ctx = clickContext(req)

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
