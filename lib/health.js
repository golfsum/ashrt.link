/**
 * Is the other end of the link still there?
 *
 * A short link outlives the page it points at. The destination 404s, the domain
 * lapses, the certificate expires, and the link keeps redirecting people into
 * the wall. This checks destinations on a schedule and says which ones broke.
 *
 * Three constraints shape the whole design:
 *
 *   1. **Never on the redirect path.** A click must not wait for anybody else's
 *      server. Checks run from a scheduled invocation, and a click only ever
 *      reads what the last check recorded.
 *   2. **Do not hammer other people's sites.** One check per link per interval,
 *      a HEAD where possible, a short timeout, and a longer interval for links
 *      nobody is clicking. Being a polite client is not optional when the
 *      requests are automated and aimed at somebody else.
 *   3. **Fetching a user-supplied URL from our server is an SSRF risk.** The
 *      destination passed validation when it was saved, but DNS can be
 *      repointed at a private address afterwards, and a redirect can lead
 *      anywhere. So every hop is re-validated, and redirects are followed
 *      manually rather than by the fetch client.
 */

import { validateUrl } from './urls.js'

/** How long to wait for somebody else's server before calling it a timeout. */
export const TIMEOUT_MS = 6000

/** Redirect hops we will follow before calling it a loop. */
export const MAX_HOPS = 5

/** Consecutive failures before a link is reported as broken. */
export const FAILURES_BEFORE_ALERT = 2

/**
 * How often a link is worth checking, in hours.
 *
 * Links nobody clicks are checked rarely: a broken destination on a link with
 * no traffic is not urgent, and checking it costs somebody else's bandwidth.
 */
export const INTERVALS = {
  active: 12, // clicked in the last week
  warm: 48, // clicked in the last month
  cold: 24 * 7, // no recent clicks
  broken: 6, // currently failing: check more often so recovery is noticed
}

export const HEALTH_STATES = {
  ok: 'Reachable',
  not_found: 'Page not found',
  server_error: 'Server error',
  dns: 'Domain not resolving',
  tls: 'Certificate problem',
  timeout: 'Timed out',
  loop: 'Redirect loop',
  blocked: 'Destination no longer allowed',
  unreachable: 'Could not be reached',
}

/** Clicks in the last N days, from the per-day map already on the record. */
function clicksSince(link, days) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  let total = 0
  for (const [day, n] of Object.entries(link.daily || {})) if (day >= cutoff) total += Number(n) || 0
  return total
}

/** Which schedule this link is on. */
export function intervalFor(link) {
  if (link.health && link.health.status !== 'ok' && link.health.status) return INTERVALS.broken
  if (clicksSince(link, 7) > 0) return INTERVALS.active
  if (clicksSince(link, 30) > 0) return INTERVALS.warm
  return INTERVALS.cold
}

/** Is this link due for a check? */
export function isDue(link, now = Date.now()) {
  if (!link?.url) return false
  if (link.status === 'disabled') return false
  const last = link.health?.checkedAt || 0
  return now - last >= intervalFor(link) * 3600 * 1000
}

/**
 * Pick what to check this run, most overdue first.
 *
 * Bounded on purpose: a scheduled invocation has a time limit, and a run that
 * tries to check everything finishes nothing.
 */
export function dueLinks(links, { limit = 40, now = Date.now() } = {}) {
  return links
    .filter((l) => isDue(l, now))
    .sort((a, b) => (a.health?.checkedAt || 0) - (b.health?.checkedAt || 0))
    .slice(0, limit)
}

/** Turn a fetch failure into something a person can act on. */
function classifyError(err) {
  const text = `${err?.name || ''} ${err?.message || ''} ${err?.cause?.code || ''}`.toLowerCase()
  if (text.includes('abort') || text.includes('timeout')) return 'timeout'
  if (text.includes('enotfound') || text.includes('eai_again') || text.includes('dns')) return 'dns'
  if (text.includes('cert') || text.includes('tls') || text.includes('ssl')) return 'tls'
  return 'unreachable'
}

/**
 * Check one destination.
 *
 * Redirects are followed by hand, and every hop is validated before it is
 * requested, so a destination cannot redirect this server somewhere a link
 * would never have been allowed to point in the first place.
 *
 * @param {string} url
 * @param {{ blocked?: string[], fetchImpl?: Function }} opts
 */
export async function checkUrl(url, { blocked = [], fetchImpl = fetch } = {}) {
  let current = url
  const chain = []

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const safe = validateUrl(current, { blocked })
    if (!safe.ok) return { status: 'blocked', detail: safe.error, url: current }
    current = safe.url

    if (chain.includes(current)) return { status: 'loop', detail: 'Redirects back to itself', url: current }
    chain.push(current)

    let res
    try {
      res = await fetchImpl(current, {
        method: hop === 0 ? 'HEAD' : 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          // Say who this is. An automated request that does not identify itself
          // is the kind that gets a whole range blocked.
          'User-Agent': 'ashrt.link-link-checker/1.0 (+https://www.ashrt.link/)',
          Accept: '*/*',
        },
      })
    } catch (err) {
      // Node wraps the real reason one level down, and "fetch failed" on its
      // own tells the person nothing they can act on.
      const cause = err?.cause?.code || err?.cause?.message
      return {
        status: classifyError(err),
        detail: cause ? `${err.message} (${cause})` : err?.message || 'Request failed',
        url: current,
      }
    }

    const code = res.status

    if (code >= 300 && code < 400) {
      const next = res.headers.get('location')
      if (!next) return { status: 'unreachable', code, detail: 'Redirect with no destination', url: current }
      try {
        current = new URL(next, current).toString()
      } catch {
        return { status: 'unreachable', code, detail: 'Redirect to an unreadable address', url: current }
      }
      continue
    }

    // Some servers refuse HEAD but serve GET perfectly well. That is a quirk of
    // the other end, not a broken link, so it is retried once rather than
    // reported.
    if (hop === 0 && (code === 405 || code === 501)) {
      chain.length = 0
      continue
    }

    if (code === 404 || code === 410) return { status: 'not_found', code, url: current }
    if (code >= 500) return { status: 'server_error', code, url: current }
    if (code >= 400) {
      // 401, 403 and friends: the page exists and is refusing us, which is not
      // the same as being broken. A members-only page is working as intended.
      return { status: 'ok', code, note: 'refused an automated request', url: current }
    }
    return { status: 'ok', code, url: current }
  }

  return { status: 'loop', detail: `More than ${MAX_HOPS} redirects`, url: current }
}

/**
 * Fold a check result into the link's health record.
 *
 * A single failure does not raise an alarm: sites blip, and a checker that
 * cries wolf gets ignored, which is worse than not having one. Two consecutive
 * failures is the threshold.
 */
export function applyResult(link, result, now = Date.now()) {
  const previous = link.health || {}
  const failing = result.status !== 'ok'
  const failures = failing ? (previous.failures || 0) + 1 : 0

  return {
    status: result.status,
    code: result.code || null,
    detail: result.detail || result.note || null,
    checkedAt: now,
    failures,
    // When it first went wrong, kept across subsequent failures so the report
    // can say how long it has been broken.
    failingSince: failing ? previous.failingSince || now : null,
    lastOkAt: failing ? previous.lastOkAt || null : now,
    alerting: failures >= FAILURES_BEFORE_ALERT,
  }
}

/** Should this be shown to its owner as a problem? */
export const isBroken = (link) => Boolean(link?.health?.alerting)
