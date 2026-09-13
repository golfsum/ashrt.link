// Vercel serverless entry. The whole Express app runs as one function;
// vercel.json routes every request here.
import express from 'express'

import app from '../server.js'
import { users } from '../store.js'
import { guestId, readToken } from '../auth.js'
import { clientIp, hashClient } from '../lib/ratelimit.js'
import { runStartupMaintenance } from '../lib/startup-maintenance.js'
import {
  emailVerificationConfigured,
  isEmailVerified,
  readVerificationToken,
  sendVerificationEmail,
} from '../lib/verification.js'

await runStartupMaintenance()

const outer = express()
const SESSION_COOKIE = 'ashrt_session'
const DAY_MS = 864e5
const HOUR_MS = 36e5

function cookies(req) {
  const out = {}
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

async function requestUser(req) {
  const key = req.get('x-api-key')
  if (key) return users.getByApiKey(key)
  const uid = readToken(cookies(req)[SESSION_COOKIE])
  return uid ? users.getById(uid) : null
}

function verificationView(user) {
  const verified = isEmailVerified(user)
  return { emailVerified: verified, verificationRequired: !verified }
}

outer.use('/auth/register', async (req, res, next) => {
  if (!emailVerificationConfigured()) {
    return res.status(503).json({
      error: 'Email signup is temporarily unavailable. Continue with Google or GitHub, or try again shortly.',
    })
  }

  const device = guestId(req, res)
  const ipHash = hashClient(clientIp(req))
  const deviceHash = hashClient(`device:${device}`)
  const now = Date.now()

  try {
    const all = await users.all()
    const recentDay = all.filter((u) => (u.createdAt || 0) >= now - DAY_MS)
    const recentHour = recentDay.filter((u) => (u.createdAt || 0) >= now - HOUR_MS)
    const deviceDay = recentDay.filter((u) => u.signupDeviceHash && u.signupDeviceHash === deviceHash).length
    const deviceHour = recentHour.filter((u) => u.signupDeviceHash && u.signupDeviceHash === deviceHash).length
    const ipDay = recentDay.filter((u) => u.signupIpHash && u.signupIpHash === ipHash).length
    const ipHour = recentHour.filter((u) => u.signupIpHash && u.signupIpHash === ipHash).length

    if (deviceHour >= 2 || deviceDay >= 3 || ipHour >= 5 || ipDay >= 8) {
      return res.status(429).json({
        error: 'Too many accounts have been created from this device or network recently. Try again later.',
      })
    }
  } catch {
    // The inner route still has its ordinary rate limiter. A temporary index
    // read problem must not turn signup into an outage.
  }

  const originalJson = res.json.bind(res)
  res.json = (body) => {
    if (res.statusCode >= 400 || !body?.user?.id || body.user.provider !== 'password') return originalJson(body)

    ;(async () => {
      let sent = false
      try {
        const user = await users.getById(body.user.id)
        if (user) {
          user.emailVerified = false
          user.emailVerifiedAt = null
          user.signupDeviceHash = deviceHash
          user.signupIpHash = user.signupIpHash || ipHash
          user.verificationSentAt = Date.now()
          user.verificationSendDay = new Date().toISOString().slice(0, 10)
          user.verificationSendCount = 1
          await users.update(user)
          await sendVerificationEmail(user)
          sent = true
          Object.assign(body.user, verificationView(user))
        }
      } catch (err) {
        console.error('[verification] initial email:', err.message)
      }
      body.verificationEmailSent = sent
      originalJson(body)
    })()
    return res
  }
  next()
})

// Add verification state from the stored record, because safeUser intentionally
// does not expose every internal account field.
outer.use('/auth/me', (_req, res, next) => {
  const originalJson = res.json.bind(res)
  res.json = (body) => {
    if (res.statusCode >= 400 || !body?.user?.id) return originalJson(body)
    ;(async () => {
      const stored = await users.getById(body.user.id).catch(() => null)
      Object.assign(body.user, verificationView(stored || body.user))
      originalJson(body)
    })()
    return res
  }
  next()
})

outer.get('/auth/verify-email', async (req, res) => {
  const payload = readVerificationToken(String(req.query.token || ''))
  if (!payload) return res.redirect('/login?error=verification')

  const user = await users.getById(payload.uid)
  if (!user || String(user.email || '').toLowerCase() !== payload.email) {
    return res.redirect('/login?error=verification')
  }

  user.emailVerified = true
  user.emailVerifiedAt = Date.now()
  user.verificationSentAt = null
  await users.update(user)
  res.redirect('/dashboard?verified=1')
})

outer.post('/api/verification/resend', async (req, res) => {
  const user = await requestUser(req)
  if (!user) return res.status(401).json({ error: 'Sign in to continue' })
  if (isEmailVerified(user)) return res.json({ ok: true, alreadyVerified: true })
  if (!emailVerificationConfigured()) return res.status(503).json({ error: 'Verification email is not configured' })

  const now = Date.now()
  if (user.verificationSentAt && now - user.verificationSentAt < 60_000) {
    return res.status(429).json({ error: 'A verification email was just sent. Wait a minute before trying again.' })
  }

  const day = new Date().toISOString().slice(0, 10)
  const count = user.verificationSendDay === day ? Number(user.verificationSendCount) || 0 : 0
  if (count >= 5) return res.status(429).json({ error: 'Verification email limit reached for today. Try again tomorrow.' })

  try {
    await sendVerificationEmail(user)
    user.verificationSentAt = now
    user.verificationSendDay = day
    user.verificationSendCount = count + 1
    await users.update(user)
    res.json({ ok: true })
  } catch (err) {
    console.error('[verification] resend:', err.message)
    res.status(502).json({ error: 'Could not send the verification email. Try again shortly.' })
  }
})

outer.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  if (
    req.path === '/api/verification/resend' ||
    req.path === '/api/billing/webhook' ||
    req.path === '/api/report' ||
    req.path === '/api/events'
  ) return next()

  try {
    const user = await requestUser(req)
    if (user && !isEmailVerified(user)) {
      return res.status(403).json({
        error: 'Verify your email before creating permanent links or using account features.',
        needsVerification: true,
      })
    }
  } catch {
    // The inner app remains authoritative for auth failures.
  }
  next()
})

outer.use(app)

export default outer
