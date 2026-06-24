import express from 'express'
import cors from 'cors'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import dotenv from 'dotenv'
import { store, users, campaigns, apiUsage } from './store.js'
import {
  newUserId,
  newApiKey,
  hashPassword,
  verifyPassword,
  setSession,
  clearSession,
  attachUser,
  requireUser,
  oauthEnabled,
  oauthConfigured,
  setOAuthState,
  checkOAuthState,
  authUrl,
  fetchProfile,
} from './auth.js'
import { billingEnabled, planAvailable, createCheckoutUrl, parseWebhook, FREE_LINK_LIMIT, PAID_PLANS } from './billing.js'
import QRCode from 'qrcode'

dotenv.config()

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 4000
// On Vercel, VERCEL_URL is the deployment host; otherwise use BASE_URL or localhost.
const BASE_URL = (
  process.env.BASE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`)
).replace(/\/$/, '')

const app = express()

// Stripe webhook needs the raw, unparsed body for signature verification, so it
// must be registered BEFORE the JSON body parser.
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
        await users.update(user)
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object
      const user = await users.getByStripe(sub.customer)
      if (user) {
        user.plan = 'free'
        await users.update(user)
      }
    } else if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object
      const user = await users.getByStripe(sub.customer)
      if (user) {
        const active = ['active', 'trialing'].includes(sub.status)
        user.plan = active ? sub.metadata?.plan || user.plan || 'pro' : 'free'
        await users.update(user)
      }
    }
  } catch (err) {
    console.error('[webhook]', err.message)
  }
  res.json({ received: true })
})

app.use(express.json())
app.use(cors())

// Never cache auth/API responses — stale auth state causes login/redirect loops.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
    res.set('Cache-Control', 'no-store')
  }
  next()
})

app.use(attachUser(users))

// Count programmatic (API-key) requests to /api/* for the usage graph.
app.use((req, _res, next) => {
  if (req.user && req.get('x-api-key') && req.path.startsWith('/api/')) {
    apiUsage.record(req.user.id).catch(() => {})
  }
  next()
})

const isPaid = (u) => PAID_PLANS.includes(u?.plan)

// Names that can't be used as a custom alias (they're routes or static assets).
const RESERVED = new Set([
  'api', 'auth', 'login', 'signup', 'dashboard', 'account', 'health',
  'privacy', 'terms', 'links', 'link', 'analytics', 'qr', 'campaigns', 'billing', 'settings',
  'robots.txt', 'favicon.svg', 'index.html', 'styles.css',
  'app.js', 'auth.js', 'landing.js', 'account.js', 'charts.js', 'dashboard.js',
  'shell.js', 'links.js', 'link.js', 'qr.js', 'campaigns.js', 'api.js', 'settings.js',
  'login.html', 'signup.html', 'dashboard.html', 'account.html',
  'privacy.html', 'terms.html', 'links.html', 'link.html', 'qr.html',
  'campaigns.html', 'api.html', 'settings.html',
])

const shortUrl = (slug) => `${BASE_URL}/${slug}`
const withUrl = (l) => ({ ...l, shortUrl: shortUrl(l.slug) })
const randomSlug = () => crypto.randomBytes(4).toString('base64url').slice(0, 6)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function normalize(input) {
  const t = String(input || '').trim()
  if (!t) return ''
  return /^https?:\/\//i.test(t) ? t : `https://${t}`
}

// Public-safe view of a user. `key: true` also exposes the API key (account page).
function safeUser(u, { key = false } = {}) {
  if (!u) return null
  const out = {
    id: u.id,
    email: u.email,
    name: u.name,
    provider: u.provider || 'password',
    plan: u.plan || 'free',
    createdAt: u.createdAt,
  }
  if (key) out.apiKey = u.apiKey
  return out
}

/* ================================== auth ================================== */

app.get('/auth/config', (_req, res) => res.json({ providers: oauthEnabled() }))

app.get('/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' })
  res.json({ user: safeUser(req.user) })
})

app.post('/auth/logout', (_req, res) => {
  clearSession(res)
  res.json({ ok: true })
})

app.post('/auth/register', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  const name = String(req.body?.name || '').trim() || email.split('@')[0]
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email' })
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' })
  if (await users.getByEmail(email)) return res.status(409).json({ error: 'An account with that email already exists' })

  const user = {
    id: newUserId(),
    email,
    name,
    provider: 'password',
    passwordHash: await hashPassword(password),
    apiKey: newApiKey(),
    oauth: [],
    createdAt: Date.now(),
  }
  await users.create(user)
  setSession(res, user.id)
  res.json({ user: safeUser(user) })
})

app.post('/auth/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  const user = await users.getByEmail(email)
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Wrong email or password' })
  }
  setSession(res, user.id)
  res.json({ user: safeUser(user) })
})

/* ------------------------------ OAuth (social) ---------------------------- */

app.get('/auth/:provider', (req, res, next) => {
  const provider = req.params.provider
  if (provider !== 'google' && provider !== 'github') return next()
  if (!oauthConfigured(provider)) return res.status(404).send(`${provider} sign-in is not configured`)
  const state = setOAuthState(res)
  const redirectUri = `${BASE_URL}/auth/${provider}/callback`
  res.redirect(authUrl(provider, redirectUri, state))
})

app.get('/auth/:provider/callback', async (req, res) => {
  const provider = req.params.provider
  if ((provider !== 'google' && provider !== 'github') || !oauthConfigured(provider)) {
    return res.redirect('/login?error=oauth')
  }
  try {
    if (!checkOAuthState(req, req.query.state)) return res.redirect('/login?error=state')
    const redirectUri = `${BASE_URL}/auth/${provider}/callback`
    const profile = await fetchProfile(provider, req.query.code, redirectUri)
    if (!profile.email) return res.redirect('/login?error=email')

    const tag = `${provider}:${profile.sub}`
    // Prefer an existing social identity, then fall back to matching email.
    let user = await users.getByOAuth(provider, profile.sub)
    if (!user) {
      const existing = await users.getByEmail(profile.email)
      if (existing) {
        existing.oauth = Array.from(new Set([...(existing.oauth || []), tag]))
        await users.update(existing)
        user = existing
      } else {
        user = {
          id: newUserId(),
          email: profile.email.toLowerCase(),
          name: profile.name || profile.email,
          provider,
          apiKey: newApiKey(),
          oauth: [tag],
          createdAt: Date.now(),
        }
        await users.create(user)
      }
    }
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
  const oldApiKey = req.user.apiKey
  req.user.apiKey = newApiKey()
  await users.update(req.user, { oldApiKey })
  res.json({ apiKey: req.user.apiKey })
})

// Update profile (currently just display name).
app.patch('/api/account', requireUser, async (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (name) {
    req.user.name = name
    await users.update(req.user)
  }
  res.json({ user: safeUser(req.user) })
})

/* ----------------------------- custom domains ----------------------------- */

const DOMAIN_RE = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i

app.get('/api/domains', requireUser, (req, res) => {
  res.json({ domains: req.user.domains || [] })
})

app.post('/api/domains', requireUser, async (req, res) => {
  if (req.user.plan !== 'business') {
    return res.status(402).json({ error: 'Custom domains are a Business feature', needsUpgrade: true })
  }
  const domain = String(req.body?.domain || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
  if (!DOMAIN_RE.test(domain)) return res.status(400).json({ error: 'Enter a valid domain like links.yourbrand.com' })
  req.user.domains = req.user.domains || []
  if (req.user.domains.some((d) => d.domain === domain)) return res.status(409).json({ error: 'Domain already added' })
  req.user.domains.push({ domain, status: 'pending', addedAt: Date.now() })
  await users.update(req.user)
  res.json({ domains: req.user.domains })
})

app.delete('/api/domains/:domain', requireUser, async (req, res) => {
  req.user.domains = (req.user.domains || []).filter((d) => d.domain !== req.params.domain)
  await users.update(req.user)
  res.json({ ok: true })
})

/* ================================ billing ================================= */

app.get('/api/billing/status', (req, res) => {
  res.json({
    enabled: billingEnabled(),
    plan: req.user?.plan || 'free',
    freeLimit: FREE_LINK_LIMIT,
    available: { pro: planAvailable('pro'), business: planAvailable('business') },
  })
})

app.post('/api/billing/checkout', requireUser, async (req, res) => {
  const plan = PAID_PLANS.includes(req.body?.plan) ? req.body.plan : 'pro'
  if (!planAvailable(plan)) return res.status(503).json({ error: `The ${plan} plan isn't set up yet` })
  if (req.user.plan === plan) return res.status(400).json({ error: `You're already on ${plan}` })
  try {
    const url = await createCheckoutUrl(req.user, BASE_URL, plan)
    res.json({ url })
  } catch (err) {
    console.error('[checkout]', err.message)
    res.status(500).json({ error: 'Could not start checkout' })
  }
})

/* ================================ campaigns =============================== */

app.get('/api/campaigns', requireUser, async (req, res) => {
  const list = await campaigns.byOwner(req.user.id)
  const links = await store.byOwner(req.user.id)
  const out = []
  for (const c of list) {
    const linksIn = links.filter((l) => l.campaign === c.id)
    let visitors = 0
    for (const l of linksIn) visitors += await store.uniquesForLink(l.slug)
    out.push({
      ...c,
      links: linksIn.length,
      clicks: linksIn.reduce((s, l) => s + (l.clicks || 0), 0),
      visitors,
    })
  }
  res.json({ campaigns: out })
})

app.post('/api/campaigns', requireUser, async (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return res.status(400).json({ error: 'Name your campaign' })
  const camp = { id: 'c_' + crypto.randomBytes(6).toString('base64url'), owner: req.user.id, name, createdAt: Date.now() }
  await campaigns.create(camp)
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
  const today = new Date().toISOString().slice(0, 10)
  const month = today.slice(0, 7)
  const monthTotal = Object.entries(byDay).reduce((s, [d, n]) => (d.startsWith(month) ? s + n : s), 0)
  const limits = { free: 100, pro: 1000, business: 10000 }
  res.json({
    byDay,
    today: byDay[today] || 0,
    month: monthTotal,
    plan: req.user.plan || 'free',
    dailyLimit: limits[req.user.plan || 'free'] || limits.free,
  })
})

/* ================================== links ================================= */

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, store: store.driver, providers: oauthEnabled() }),
)

// Anyone can shorten a URL (anonymous = random code only). Signed-in users also
// get custom aliases; free accounts are capped, Pro is unlimited.
app.post('/api/links', async (req, res) => {
  const url = normalize(req.body?.url)
  if (!url) return res.status(400).json({ error: 'Give me a URL to shorten' })

  const wantsAlias = Boolean(String(req.body?.alias || '').trim())
  if (wantsAlias && !req.user) {
    return res.status(401).json({ error: 'Sign up for a free account to use custom aliases', needsAccount: true })
  }

  // Free-plan link cap (paid plans are unlimited). Doesn't apply to anonymous links.
  if (req.user && !isPaid(req.user)) {
    const mine = await store.byOwner(req.user.id)
    if (mine.length >= FREE_LINK_LIMIT) {
      return res.status(402).json({
        error: `Free accounts can keep ${FREE_LINK_LIMIT} links. Upgrade for unlimited.`,
        needsUpgrade: true,
      })
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
    do {
      slug = randomSlug()
    } while (RESERVED.has(slug.toLowerCase()) || (await store.exists(slug)))
  }

  const link = await store.add({
    slug,
    url,
    owner: req.user ? req.user.id : null,
    campaign: (req.user && req.body?.campaign) || null,
    source: req.body?.source || (req.user ? (req.get('x-api-key') ? 'api' : 'dashboard') : 'anon'),
  })
  if (req.user) await store.logActivity(req.user.id, { type: 'created', slug, at: Date.now() })
  res.json(withUrl(link))
})

app.get('/api/links', requireUser, async (req, res) => {
  const links = await store.byOwner(req.user.id)
  const totalClicks = links.reduce((s, l) => s + (l.clicks || 0), 0)
  const enriched = []
  for (const l of links) {
    enriched.push({ ...withUrl(l), visitors: await store.uniquesForLink(l.slug), status: 'active' })
  }
  res.json({ totalLinks: links.length, totalClicks, links: enriched })
})

// Edit a link's destination.
app.patch('/api/links/:slug', requireUser, async (req, res) => {
  const link = await store.get(req.params.slug)
  if (!link) return res.status(404).json({ error: 'Link not found' })
  if (link.owner !== req.user.id) return res.status(403).json({ error: 'Not your link' })
  const url = normalize(req.body?.url)
  if (!url) return res.status(400).json({ error: 'Give me a URL' })
  link.url = url
  if (req.body?.campaign !== undefined) link.campaign = req.body.campaign || null
  await store.add(link) // add() upserts by slug
  await store.logActivity(req.user.id, { type: 'edited', slug: link.slug, at: Date.now() })
  res.json(withUrl(link))
})

// Per-link analytics for its detail page.
app.get('/api/links/:slug/stats', requireUser, async (req, res) => {
  const link = await store.get(req.params.slug)
  if (!link) return res.status(404).json({ error: 'Link not found' })
  if (link.owner !== req.user.id) return res.status(403).json({ error: 'Not your link' })
  const summary = await store.linkSummary(req.params.slug)
  res.json({ ...summary, shortUrl: shortUrl(req.params.slug) })
})

// QR code for any text/URL (PNG or SVG). ?download=1 forces a file download.
app.get('/api/qr', requireUser, async (req, res) => {
  const data = String(req.query.data || '')
  if (!data) return res.status(400).send('missing data')
  const opts = { margin: 1, color: { dark: '#0A0A0A', light: '#FFFFFF' } }
  const name = String(req.query.name || 'qr').replace(/[^a-zA-Z0-9_-]/g, '')
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

app.delete('/api/links/:slug', requireUser, async (req, res) => {
  const link = await store.get(req.params.slug)
  if (!link) return res.json({ ok: true })
  if (link.owner !== req.user.id) return res.status(403).json({ error: 'Not your link' })
  await store.remove(req.params.slug)
  await store.logActivity(req.user.id, { type: 'deleted', slug: req.params.slug, at: Date.now() })
  res.json({ ok: true })
})

// Aggregated analytics for the dashboard.
app.get('/api/stats', requireUser, async (req, res) => {
  res.json(await store.summary(req.user.id))
})

/* ------------------------ static pages + redirect ------------------------- */

// Serves index.html at /, and clean URLs like /login -> login.html.
app.use(express.static(join(__dirname, 'public'), { extensions: ['html'] }))

// Derive analytics context from the request: device, country, referrer host,
// and a hashed, non-identifying unique-visitor id (ip + user-agent).
function clickContext(req) {
  const ua = req.get('user-agent') || ''
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
  const ip = (req.get('x-forwarded-for') || '').split(',')[0].trim() || req.ip || ''
  const visitorId = crypto.createHash('sha256').update(`${ip}|${ua}`).digest('hex').slice(0, 16)
  return { device, country, refHost, visitorId }
}

app.get('/:slug', async (req, res) => {
  const link = await store.recordClick(req.params.slug, clickContext(req))
  if (!link) {
    return res
      .status(404)
      .type('html')
      .send(
        '<body style="font-family:system-ui;background:#0b0b0f;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="margin:0;font-size:48px">404</h1><p style="color:#9aa">That short link does not exist.</p><a href="/" style="color:#8b8bff">Make one</a></div></body>',
      )
  }
  res.redirect(302, link.url)
})

// Run a normal server locally; on Vercel the app is imported by api/index.js.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  app.listen(PORT, () => {
    console.log(`\n  ashrt.link running at ${BASE_URL}`)
    console.log(`  store: ${store.driver}\n`)
  })
}

export default app
