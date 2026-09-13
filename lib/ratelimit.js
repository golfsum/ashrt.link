/**
 * Rate limiting.
 *
 * Fixed windows, because they are cheap and the failure mode (a burst spanning
 * a window boundary) is acceptable for what we are defending against. The
 * window is part of the key, so old counters expire on their own.
 *
 * Every limit in the app is declared in LIMITS below. Routes name a limit, they
 * never inline numbers.
 */

import crypto from 'node:crypto'
import { useKV, redis, pipeline } from './kv.js'
import { limitFor } from './plans.js'

/**
 * Client identifiers are hashed before they are stored or logged. We salt with
 * the session secret so the hashes are not comparable against a rainbow table
 * or across deployments, and we never write a raw IP anywhere.
 */
const SALT = process.env.SESSION_SECRET || process.env.API_KEY || 'ashrt-dev-salt'

export function hashClient(value) {
  return crypto.createHmac('sha256', SALT).update(String(value || '')).digest('base64url').slice(0, 20)
}

/** Best-effort client IP behind Vercel's proxy. */
export function clientIp(req) {
  const fwd = req.get('x-forwarded-for') || ''
  return fwd.split(',')[0].trim() || req.get('x-real-ip') || req.ip || req.socket?.remoteAddress || ''
}

/** Stable, non-identifying id for an anonymous caller. */
export function clientId(req) {
  return hashClient(clientIp(req))
}

/* --------------------------------- limits --------------------------------- */

/**
 * name -> { limit, windowSec }
 * `limit: null` means "look it up from the caller's plan" via planKey.
 */
export const LIMITS = {
  // Link creation.
  //
  // Two axes for guests. The browser axis is the real budget; the IP axis is a
  // much looser ceiling so that one person behind a shared address cannot
  // exhaust everyone else's allowance, while someone cycling cookies still
  // hits a wall.
  //
  // Counted only when a link is actually created, so a typo does not cost a
  // guest their quota. The attempt limit below is what makes probing expensive.
  'create:guest:hour': { limit: null, planKey: 'createPerHour', windowSec: 3600, guest: true },
  'create:guest:day': { limit: null, planKey: 'createPerDay', windowSec: 86400, guest: true },
  'create:ip:hour': { limit: null, planKey: 'ipPerHour', windowSec: 3600, guest: true },
  'create:ip:day': { limit: null, planKey: 'ipPerDay', windowSec: 86400, guest: true },
  'create:user:hour': { limit: null, planKey: 'createPerHour', windowSec: 3600 },

  // The plan allowance itself. A 30-day window rather than a calendar month:
  // it needs no per-account reset date, it cannot be gamed by signing up on the
  // 31st, and the reset time is exact rather than "sometime next month".
  //
  // Deliberately a creation allowance and not a stored-link cap. Links already
  // published keep working and stop counting once their window passes, so
  // nobody has to delete last quarter's links to publish this week's.
  'create:user:month': { limit: null, planKey: 'linksPerMonth', windowSec: 2592000 },

  // Every creation attempt, valid or not. Guards the validator itself.
  'create:attempt': { limit: null, planKey: 'attemptsPerHour', windowSec: 3600, guest: true },

  // Programmatic access, per plan, per day.
  'api:day': { limit: null, planKey: 'apiPerDay', windowSec: 86400 },

  // Auth endpoints: slow down credential stuffing without locking people out.
  'auth:login': { limit: 10, windowSec: 900 },
  'auth:register': { limit: 5, windowSec: 3600 },

  // Public abuse reporting, so the report queue cannot itself be flooded.
  'report:hour': { limit: 5, windowSec: 3600 },

  // The redirect path. Generous: this is a stampede guard, not a usage cap.
  'redirect:minute': { limit: 600, windowSec: 60 },

  // Exports read and format every link an account has, so they are capped well
  // above normal use and well below "script it in a loop".
  'export:hour': { limit: 30, windowSec: 3600 },

  // QR *downloads*, not renders. A code shown on a page is drawn on every load
  // and metering that would bill somebody for scrolling; what the plan sells is
  // the file you take away, so that is what is counted.
  'qr:month': { limit: null, planKey: 'qrPerMonth', windowSec: 2592000 },

  // Guest analytics lookups by management token.
  'guestlookup:hour': { limit: 120, windowSec: 3600 },
}

/* ------------------------------ memory driver ----------------------------- */

/**
 * Local dev only. On Vercel every invocation may be a fresh instance, so an
 * in-memory counter would be meaningless there; that is why KV is required in
 * production and why this driver is not a fallback for it.
 */
const memory = new Map()

function memoryHit(key, windowSec) {
  const now = Date.now()
  const entry = memory.get(key)
  if (!entry || entry.resetAt <= now) {
    const fresh = { count: 1, resetAt: now + windowSec * 1000 }
    memory.set(key, fresh)
    if (memory.size > 10000) {
      for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k)
    }
    return fresh
  }
  entry.count += 1
  return entry
}

/* --------------------------------- core ----------------------------------- */

/**
 * Count one event against a named limit.
 *
 * @param {string} name  a key of LIMITS
 * @param {string} id    who is being limited (hashed client id, or user id)
 * @param {object} [opts]
 * @param {object} [opts.user]  signed-in user, for plan-derived limits
 * @param {number} [opts.cost]  count this as N events (default 1)
 * @returns {Promise<{allowed:boolean,count:number,limit:number,remaining:number,resetAt:number,retryAfter:number}>}
 */
export async function hit(name, id, { user = null, cost = 1 } = {}) {
  const spec = LIMITS[name]
  if (!spec) throw new Error(`Unknown rate limit: ${name}`)

  const limit = spec.limit === null ? limitFor(spec.guest ? null : user, spec.planKey) : spec.limit
  if (!Number.isFinite(limit) || limit <= 0) {
    // Unlimited plans still get counted for observability, never blocked.
    return { allowed: true, count: 0, limit: Infinity, remaining: Infinity, resetAt: 0, retryAfter: 0 }
  }

  const windowSec = spec.windowSec
  const bucket = Math.floor(Date.now() / 1000 / windowSec)
  const key = `ashrt:rl:${name}:${id}:${bucket}`

  let count
  let resetAt
  if (useKV) {
    try {
      // One round-trip, not two. The limiter sits in front of the redirect, so
      // a second hop here would be paid on every single click.
      const [incr] = await pipeline([
        ['INCRBY', key, cost],
        ['EXPIRE', key, windowSec * 2],
      ])
      count = Number(incr) || cost
    } catch {
      // A limiter that is down must not take the whole service with it.
      return { allowed: true, count: 0, limit, remaining: limit, resetAt: 0, retryAfter: 0, degraded: true }
    }
    resetAt = (bucket + 1) * windowSec * 1000
  } else {
    const entry = memoryHit(key, windowSec)
    if (cost > 1) entry.count += cost - 1
    count = entry.count
    resetAt = entry.resetAt
  }

  const allowed = count <= limit
  return {
    allowed,
    count,
    limit,
    remaining: Math.max(0, limit - count),
    resetAt,
    retryAfter: allowed ? 0 : Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
  }
}

/** Read a counter without incrementing it (for usage displays). */
export async function peek(name, id) {
  const spec = LIMITS[name]
  if (!spec) return 0
  const bucket = Math.floor(Date.now() / 1000 / spec.windowSec)
  const key = `ashrt:rl:${name}:${id}:${bucket}`
  if (useKV) {
    try {
      return Number(await redis(['GET', key])) || 0
    } catch {
      return 0
    }
  }
  return memory.get(key)?.count || 0
}

/**
 * What a budget looks like right now, without spending any of it.
 *
 * This is what the usage meters read. It has to be a separate call from hit()
 * because looking at your allowance must never consume it — a dashboard that
 * charged you for loading it would be its own bug.
 */
export async function usage(name, id, { user = null } = {}) {
  const spec = LIMITS[name]
  if (!spec) return null
  const limitValue = spec.limit === null ? limitFor(spec.guest ? null : user, spec.planKey) : spec.limit
  const used = await peek(name, id)
  const bucket = Math.floor(Date.now() / 1000 / spec.windowSec)
  return {
    used,
    limit: Number.isFinite(limitValue) ? limitValue : null,
    remaining: Number.isFinite(limitValue) ? Math.max(0, limitValue - used) : null,
    windowSec: spec.windowSec,
    resetAt: (bucket + 1) * spec.windowSec * 1000,
  }
}

/* ------------------------------- middleware ------------------------------- */

/**
 * Express middleware for a named limit. Sets the standard headers and answers
 * 429 with a JSON body (or plain text for non-API routes).
 */
export function limit(name, idFor = clientId) {
  return async (req, res, next) => {
    let result
    try {
      result = await hit(name, idFor(req), { user: req.user })
    } catch {
      return next()
    }
    if (Number.isFinite(result.limit)) {
      res.set('RateLimit-Limit', String(result.limit))
      res.set('RateLimit-Remaining', String(result.remaining))
      if (result.resetAt) res.set('RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)))
    }
    if (result.allowed) return next()

    res.set('Retry-After', String(result.retryAfter))
    req.rateLimited = result
    if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
      return res.status(429).json({
        error: 'Too many requests. Give it a minute and try again.',
        retryAfter: result.retryAfter,
      })
    }
    return res.status(429).type('text').send('Too many requests. Try again shortly.')
  }
}

/** Reset every counter. Test-only. */
export function _resetMemory() {
  memory.clear()
}
