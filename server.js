import express from 'express'
import cors from 'cors'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import dotenv from 'dotenv'
import { store, users } from './store.js'
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
import { billingEnabled, createCheckoutUrl, parseWebhook, FREE_LINK_LIMIT } from './billing.js'

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
        user.plan = 'pro'
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
        user.plan = ['active', 'trialing'].includes(sub.status) ? 'pro' : 'free'
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
app.use(attachUser(users))

// Names that can't be used as a custom alias (they're routes or static assets).
const RESERVED = new Set([
  'api', 'auth', 'login', 'signup', 'dashboard', 'account', 'health',
  'privacy', 'terms',
  'robots.txt', 'favicon.svg', 'index.html', 'styles.css',
  'app.js', 'auth.js', 'landing.js', 'account.js',
  'login.html', 'signup.html', 'dashboard.html', 'account.html',
  'privacy.html', 'terms.html',
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

/* ================================ billing ================================= */

app.get('/api/billing/status', (req, res) => {
  res.json({ enabled: billingEnabled(), plan: req.user?.plan || 'free', freeLimit: FREE_LINK_LIMIT })
})

app.post('/api/billing/checkout', requireUser, async (req, res) => {
  if (!billingEnabled()) return res.status(503).json({ error: 'Billing is not set up yet' })
  if (req.user.plan === 'pro') return res.status(400).json({ error: "You're already on Pro" })
  try {
    const url = await createCheckoutUrl(req.user, BASE_URL)
    res.json({ url })
  } catch (err) {
    console.error('[checkout]', err.message)
    res.status(500).json({ error: 'Could not start checkout' })
  }
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

  // Free-plan link cap (Pro is unlimited). Doesn't apply to anonymous links.
  if (req.user && (req.user.plan || 'free') !== 'pro') {
    const mine = await store.byOwner(req.user.id)
    if (mine.length >= FREE_LINK_LIMIT) {
      return res.status(402).json({
        error: `Free accounts can keep ${FREE_LINK_LIMIT} links. Upgrade to Pro for unlimited.`,
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
    source: req.body?.source || (req.user ? (req.get('x-api-key') ? 'api' : 'dashboard') : 'anon'),
  })
  res.json(withUrl(link))
})

app.get('/api/links', requireUser, async (req, res) => {
  const links = await store.byOwner(req.user.id)
  const totalClicks = links.reduce((s, l) => s + (l.clicks || 0), 0)
  res.json({ totalLinks: links.length, totalClicks, links: links.map(withUrl) })
})

app.delete('/api/links/:slug', requireUser, async (req, res) => {
  const link = await store.get(req.params.slug)
  if (!link) return res.json({ ok: true })
  if (link.owner !== req.user.id) return res.status(403).json({ error: 'Not your link' })
  await store.remove(req.params.slug)
  res.json({ ok: true })
})

/* ------------------------ static pages + redirect ------------------------- */

// Serves index.html at /, and clean URLs like /login -> login.html.
app.use(express.static(join(__dirname, 'public'), { extensions: ['html'] }))

app.get('/:slug', async (req, res) => {
  const link = await store.recordClick(req.params.slug)
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
