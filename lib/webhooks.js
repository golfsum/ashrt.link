/**
 * Webhooks: tell somebody else's server when something happens here.
 *
 * Deliberate omission, first, because it is the one people ask for: there is no
 * per-click webhook. A click is a 302 that takes a few milliseconds, and
 * hanging an outbound HTTP request off it would make the fastest part of the
 * product depend on the slowest server subscribed to it. Click volume is
 * delivered as a periodic summary from the scheduled job instead, which is the
 * same information without putting anyone else's outage on our redirect path.
 *
 * Everything else follows from three facts:
 *
 *   - The endpoint URL is supplied by a user and we make requests to it, so it
 *     is validated exactly like a link destination and re-validated at delivery.
 *   - The receiver has to be able to tell a real delivery from a forgery, so
 *     every request is signed, with a timestamp, over the exact bytes sent.
 *   - Receivers go down. A failed delivery is queued and retried by the
 *     scheduler rather than retried inline, and an endpoint that keeps failing
 *     is switched off rather than hammered forever.
 */

import crypto from 'node:crypto'

export const EVENTS = {
  'link.created': 'A link was created',
  'link.updated': 'A link was changed',
  'link.deleted': 'A link was deleted',
  'domain.verified': 'A custom domain went live',
  'destination.failed': 'A destination stopped answering',
  'clicks.summary': 'Periodic click totals, instead of a webhook per click',
}

export const EVENT_NAMES = Object.keys(EVENTS)

export const MAX_ENDPOINTS = 5

/** How long we will wait on a receiver before giving up and queueing a retry. */
export const TIMEOUT_MS = 5000

/** Consecutive failures before an endpoint is switched off. */
export const FAILURES_BEFORE_DISABLE = 10

/** Retries, and how long after the attempt before each one. */
export const RETRY_DELAYS_MS = [60_000, 10 * 60_000, 60 * 60_000]

export const newSecret = () => 'whsec_' + crypto.randomBytes(24).toString('base64url')

/**
 * Sign a delivery.
 *
 * Stripe's scheme, because it is well understood and receivers often already
 * have code for it: the timestamp is signed along with the body, so a captured
 * request cannot be replayed later, and the receiver compares in constant time.
 */
export function sign(body, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return { header: `t=${timestamp},v1=${mac}`, timestamp, mac }
}

/** For a receiver's own tests, and for ours. */
export function verify(body, header, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  const parts = Object.fromEntries(
    String(header || '')
      .split(',')
      .map((p) => p.split('=').map((x) => x.trim())),
  )
  const t = Number(parts.t)
  if (!t || !parts.v1) return false
  if (Math.abs(now / 1000 - t) > toleranceSec) return false

  const expected = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(String(parts.v1))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** Public view of an endpoint. The secret is shown once, when it is created. */
export const publicEndpoint = (e) => ({
  id: e.id,
  url: e.url,
  events: e.events,
  active: e.active !== false,
  createdAt: e.createdAt || null,
  lastDeliveryAt: e.lastDeliveryAt || null,
  lastStatus: e.lastStatus ?? null,
  failures: e.failures || 0,
  disabledReason: e.disabledReason || null,
})

/** Which endpoints on an account want this event. */
export const subscribers = (user, event) =>
  (user?.webhooks || []).filter((e) => e.active !== false && (e.events || []).includes(event))

/**
 * The body of a delivery.
 *
 * An id and a timestamp so a receiver can make its own handling idempotent,
 * which matters because a retry can arrive after the original eventually landed.
 */
export function buildDelivery(event, data) {
  return {
    id: 'evt_' + crypto.randomBytes(9).toString('base64url'),
    event,
    createdAt: new Date().toISOString(),
    data,
  }
}

/**
 * Send one delivery.
 *
 * Returns what happened rather than throwing: the caller decides whether to
 * queue a retry, and a webhook failure must never surface as an error in the
 * request that triggered it.
 */
export async function deliver(endpoint, delivery, { fetchImpl = fetch, validate } = {}) {
  // The URL was checked when it was saved. DNS can be repointed since, so it is
  // checked again here rather than trusted.
  if (validate) {
    const safe = validate(endpoint.url)
    if (!safe.ok) return { ok: false, status: 0, error: safe.error, permanent: true }
  }

  const body = JSON.stringify(delivery)
  const { header } = sign(body, endpoint.secret)

  try {
    const res = await fetchImpl(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ashrt.link-webhooks/1.0',
        'X-Ashrt-Event': delivery.event,
        'X-Ashrt-Delivery': delivery.id,
        'X-Ashrt-Signature': header,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual',
    })
    // Anything 2xx is accepted. A redirect is not followed: a webhook endpoint
    // that moves should be updated, not chased.
    const ok = res.status >= 200 && res.status < 300
    return { ok, status: res.status }
  } catch (err) {
    return { ok: false, status: 0, error: err?.message || 'Request failed' }
  }
}

/** When a queued delivery should next be attempted, or null to give up. */
export function nextAttemptAt(attempt, now = Date.now()) {
  const delay = RETRY_DELAYS_MS[attempt]
  return delay === undefined ? null : now + delay
}
