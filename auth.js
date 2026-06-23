import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'

/**
 * Auth helpers: password hashing, a self-contained signed session cookie
 * (HMAC, no DB lookup needed to validate), and the OAuth2 dance for Google
 * and GitHub. No external auth service required.
 */

// Sessions are signed with this. On Vercel set SESSION_SECRET to a long random
// string so cookies survive across deployments/instances. Falls back to API_KEY.
const SECRET = process.env.SESSION_SECRET || process.env.API_KEY || 'insecure-dev-secret-change-me'
if (SECRET === 'insecure-dev-secret-change-me') {
  console.warn('  [auth] SESSION_SECRET is not set - using an insecure dev secret.')
}

const isProd = Boolean(process.env.VERCEL)
const COOKIE = 'ashrt_session'
const STATE_COOKIE = 'ashrt_oauth'
const SESSION_DAYS = 30

/* ------------------------------ ids & secrets ----------------------------- */

export const newUserId = () => 'u_' + crypto.randomBytes(9).toString('base64url')
export const newApiKey = () => 'ak_' + crypto.randomBytes(24).toString('base64url')

export async function hashPassword(pw) {
  return bcrypt.hash(pw, 10)
}
export async function verifyPassword(pw, hash) {
  if (!hash) return false
  return bcrypt.compare(pw, hash)
}

/* -------------------------------- sessions -------------------------------- */

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url')

// token = base64url(payload).signature
export function makeToken(userId) {
  const payload = b64({ uid: userId, exp: Date.now() + SESSION_DAYS * 864e5 })
  return `${payload}.${sign(payload)}`
}

export function readToken(token) {
  if (!token || !token.includes('.')) return null
  const [payload, sig] = token.split('.')
  // Constant-time compare to avoid signature timing leaks.
  const expected = sign(payload)
  if (sig.length !== expected.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString())
    if (!uid || !exp || Date.now() > exp) return null
    return uid
  } catch {
    return null
  }
}

function parseCookies(req) {
  const out = {}
  const raw = req.headers.cookie
  if (!raw) return out
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export function setSession(res, userId) {
  res.cookie(COOKIE, makeToken(userId), {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 864e5,
  })
}
export function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' })
}

/**
 * Resolve the current user from either a session cookie (dashboard) or an
 * `x-api-key` header (Schedlytics / programmatic). Sets req.user or leaves it
 * undefined. Never rejects - use requireUser to gate.
 */
export function attachUser(users) {
  return async (req, _res, next) => {
    try {
      const key = req.get('x-api-key')
      if (key) {
        const u = await users.getByApiKey(key)
        if (u) req.user = u
        return next()
      }
      const uid = readToken(parseCookies(req)[COOKIE])
      if (uid) {
        const u = await users.getById(uid)
        if (u) req.user = u
      }
    } catch {
      /* fall through unauthenticated */
    }
    next()
  }
}

export function requireUser(req, res, next) {
  if (req.user) return next()
  res.status(401).json({ error: 'Sign in to continue' })
}

/* ---------------------------------- OAuth --------------------------------- */

const PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    id: () => process.env.GOOGLE_CLIENT_ID,
    secret: () => process.env.GOOGLE_CLIENT_SECRET,
  },
  github: {
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    id: () => process.env.GITHUB_CLIENT_ID,
    secret: () => process.env.GITHUB_CLIENT_SECRET,
  },
}

// Which social logins are configured (so the UI can show only those buttons).
export function oauthEnabled() {
  return {
    google: Boolean(PROVIDERS.google.id() && PROVIDERS.google.secret()),
    github: Boolean(PROVIDERS.github.id() && PROVIDERS.github.secret()),
  }
}

export function oauthConfigured(provider) {
  const p = PROVIDERS[provider]
  return Boolean(p && p.id() && p.secret())
}

// Short-lived signed state cookie for CSRF protection on the OAuth round-trip.
export function setOAuthState(res) {
  const state = crypto.randomBytes(16).toString('base64url')
  res.cookie(STATE_COOKIE, `${state}.${sign(state)}`, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60 * 1000,
  })
  return state
}
export function checkOAuthState(req, state) {
  const cookie = parseCookies(req)[STATE_COOKIE]
  if (!cookie || !state || !cookie.includes('.')) return false
  const [val, sig] = cookie.split('.')
  return val === state && sig === sign(val)
}

export function authUrl(provider, redirectUri, state) {
  const p = PROVIDERS[provider]
  const params = new URLSearchParams({
    client_id: p.id(),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: p.scope,
    state,
  })
  if (provider === 'google') params.set('access_type', 'online')
  return `${p.authUrl}?${params}`
}

// Exchange an auth code for a normalized profile: { provider, sub, email, name }.
export async function fetchProfile(provider, code, redirectUri) {
  const p = PROVIDERS[provider]
  const tokenRes = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: p.id(),
      client_secret: p.secret(),
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  const token = await tokenRes.json()
  if (!token.access_token) throw new Error(token.error_description || 'OAuth token exchange failed')

  if (provider === 'google') {
    const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    })
    const u = await r.json()
    if (!u.id) throw new Error('Could not read Google profile')
    return { provider, sub: String(u.id), email: u.email, name: u.name || u.email }
  }

  // github
  const ghHeaders = { Authorization: `Bearer ${token.access_token}`, 'User-Agent': 'ashrt.link', Accept: 'application/json' }
  const u = await (await fetch('https://api.github.com/user', { headers: ghHeaders })).json()
  if (!u.id) throw new Error('Could not read GitHub profile')
  let email = u.email
  if (!email) {
    const emails = await (await fetch('https://api.github.com/user/emails', { headers: ghHeaders })).json()
    const primary = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified) || emails[0] : null
    email = primary?.email
  }
  return { provider, sub: String(u.id), email, name: u.name || u.login }
}
