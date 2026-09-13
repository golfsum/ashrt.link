/**
 * Custom domains: proof of ownership, DNS diagnostics, and the platform side.
 *
 * Three separate questions get confused constantly, so they are kept apart
 * here:
 *
 *   1. Does this account control the domain?      TXT record we ask for.
 *   2. Does the domain point at this deployment?  CNAME or A record.
 *   3. Will HTTPS work?                           Certificate, issued by the
 *                                                 platform, not by us.
 *
 * A domain can pass 1 and fail 2, or pass both and still be waiting on 3, and
 * the person setting it up needs to be told which. "Pending" with no detail is
 * how a five-minute DNS task becomes a support ticket.
 *
 * The platform half is optional. With VERCEL_TOKEN and VERCEL_PROJECT_ID set,
 * the app attaches the domain and reads certificate state itself. Without them
 * everything else still works: ownership is still proven, DNS is still checked,
 * and the domain waits in a state that names the manual step instead of
 * pretending to be broken.
 */

import crypto from 'node:crypto'
import dns from 'node:dns'
import { promisify } from 'node:util'

const resolveTxt = promisify(dns.resolveTxt)
const resolveCname = promisify(dns.resolveCname)
const resolve4 = promisify(dns.resolve4)

/** Where a customer's DNS should point. Overridable: hosting targets change. */
export const CNAME_TARGET = process.env.DOMAIN_CNAME_TARGET || 'cname.vercel-dns.com'
export const A_TARGET = process.env.DOMAIN_A_TARGET || '76.76.21.21'

export const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

/**
 * States a domain can be in, in the order they are usually passed through.
 *
 * Each one names what the person has to do next, which is the only reason a
 * status is worth showing at all.
 */
export const DOMAIN_STATES = {
  pending_dns: 'Waiting for the verification record',
  dns_missing: 'The domain is not pointing here yet',
  dns_incorrect: 'The domain points somewhere else',
  pending_platform: 'Verified. Waiting for the domain to be attached',
  pending_ssl: 'Waiting for the HTTPS certificate',
  active: 'Live',
  error: 'Needs attention',
}

/** Is this the naked domain (example.com) rather than a subdomain? */
export const isApex = (domain) => domain.split('.').length === 2

/** The TXT value a domain must publish to prove it belongs to an account. */
export function verificationToken(userId, domain) {
  return (
    'ashrt-verify=' +
    crypto
      .createHmac('sha256', process.env.SESSION_SECRET || 'ashrt-dev-salt')
      .update(`${userId}|${domain.toLowerCase()}`)
      .digest('base64url')
      .slice(0, 32)
  )
}

/**
 * The exact records to publish.
 *
 * An apex domain cannot be a CNAME, so it gets an A record. Getting this wrong
 * is the single most common reason a custom domain never comes up.
 */
export function dnsInstructions(domain, token) {
  const records = [
    { purpose: 'ownership', name: `_ashrt.${domain}`, type: 'TXT', value: token },
  ]
  if (isApex(domain)) {
    records.push({ purpose: 'routing', name: '@', type: 'A', value: A_TARGET })
  } else {
    const [label] = domain.split('.')
    records.push({ purpose: 'routing', name: label, type: 'CNAME', value: CNAME_TARGET })
  }
  return records
}

/* ------------------------------ DNS checking ------------------------------ */

/** Did the domain publish our TXT value? */
export async function checkOwnership(domain, expected) {
  try {
    const records = await resolveTxt(`_ashrt.${domain}`)
    const flat = records.map((r) => (Array.isArray(r) ? r.join('') : String(r)).trim())
    return { ok: flat.includes(expected), found: flat.slice(0, 5) }
  } catch (err) {
    return { ok: false, found: [], error: err.code || 'lookup failed' }
  }
}

/**
 * Is the domain pointing at this deployment?
 *
 * Distinguishes "nothing there" from "something else there": the first is a
 * record that has not been added, the second is usually a domain still serving
 * someone's old site, and the fix is different.
 */
export async function checkRouting(domain) {
  if (isApex(domain)) {
    try {
      const ips = await resolve4(domain)
      if (!ips.length) return { state: 'dns_missing', found: [] }
      return { state: ips.includes(A_TARGET) ? 'ok' : 'dns_incorrect', found: ips.slice(0, 5) }
    } catch (err) {
      return { state: 'dns_missing', found: [], error: err.code || 'lookup failed' }
    }
  }

  try {
    const targets = await resolveCname(domain)
    if (!targets.length) return { state: 'dns_missing', found: [] }
    const ok = targets.some((t) => t.toLowerCase().replace(/\.$/, '') === CNAME_TARGET)
    return { state: ok ? 'ok' : 'dns_incorrect', found: targets.slice(0, 5) }
  } catch {
    // No CNAME. An A record pointing at us is unusual for a subdomain but
    // works, so it is checked rather than rejected.
    try {
      const ips = await resolve4(domain)
      if (ips.includes(A_TARGET)) return { state: 'ok', found: ips.slice(0, 5) }
      return { state: ips.length ? 'dns_incorrect' : 'dns_missing', found: ips.slice(0, 5) }
    } catch (err) {
      return { state: 'dns_missing', found: [], error: err.code || 'lookup failed' }
    }
  }
}

/* ---------------------------- the platform side --------------------------- */

const VERCEL_TOKEN = process.env.VERCEL_TOKEN || ''
const VERCEL_PROJECT = process.env.VERCEL_PROJECT_ID || ''
const VERCEL_TEAM = process.env.VERCEL_TEAM_ID || ''

/** Can this deployment attach domains itself, or does a person have to? */
export const platformEnabled = () => Boolean(VERCEL_TOKEN && VERCEL_PROJECT)

const teamQuery = VERCEL_TEAM ? `?teamId=${encodeURIComponent(VERCEL_TEAM)}` : ''

async function vercelApi(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.vercel.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${VERCEL_TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message = json?.error?.message || `platform responded ${res.status}`
    const err = new Error(message)
    err.status = res.status
    err.code = json?.error?.code
    throw err
  }
  return json
}

/**
 * Attach a domain to the deployment.
 *
 * Only ever called after ownership is proven. Attaching a domain somebody else
 * controls would let them point it here later and collect the traffic.
 */
export async function attachDomain(domain) {
  if (!platformEnabled()) return { attached: false, reason: 'not_configured' }
  try {
    await vercelApi(`/v10/projects/${encodeURIComponent(VERCEL_PROJECT)}/domains${teamQuery}`, {
      method: 'POST',
      body: { name: domain },
    })
    return { attached: true }
  } catch (err) {
    // Already attached is a success from where we stand.
    if (err.code === 'domain_already_in_use' || err.status === 409) return { attached: true }
    return { attached: false, reason: err.message }
  }
}

export async function detachDomain(domain) {
  if (!platformEnabled()) return { detached: false, reason: 'not_configured' }
  try {
    await vercelApi(
      `/v9/projects/${encodeURIComponent(VERCEL_PROJECT)}/domains/${encodeURIComponent(domain)}${teamQuery}`,
      { method: 'DELETE' },
    )
    return { detached: true }
  } catch (err) {
    return { detached: false, reason: err.message }
  }
}

/**
 * What the platform thinks of this domain: attached, configured, certificate.
 *
 * Returns `known: false` rather than guessing when there is no token. An
 * unknown certificate state has to read as unknown, because telling someone
 * their domain is live when it will serve a TLS warning is worse than saying
 * nothing.
 */
export async function platformStatus(domain) {
  if (!platformEnabled()) return { known: false }
  try {
    const [project, config] = await Promise.all([
      vercelApi(
        `/v9/projects/${encodeURIComponent(VERCEL_PROJECT)}/domains/${encodeURIComponent(domain)}${teamQuery}`,
      ).catch((err) => (err.status === 404 ? null : Promise.reject(err))),
      vercelApi(`/v6/domains/${encodeURIComponent(domain)}/config${teamQuery}`),
    ])
    return {
      known: true,
      attached: Boolean(project),
      verified: Boolean(project?.verified),
      misconfigured: Boolean(config?.misconfigured),
    }
  } catch (err) {
    return { known: false, error: err.message }
  }
}

/* -------------------------------- diagnosis ------------------------------- */

/**
 * One call that answers "what is wrong with my domain".
 *
 * Order matters: ownership first, because everything else is meaningless
 * without it, then routing, then the certificate. Each state carries the next
 * action rather than a status word on its own.
 */
export async function diagnose({ domain, userId }) {
  const token = verificationToken(userId, domain)
  const checks = []

  const ownership = await checkOwnership(domain, token)
  checks.push({
    name: 'Ownership (TXT)',
    ok: ownership.ok,
    detail: ownership.ok
      ? `_ashrt.${domain} matches`
      : ownership.found?.length
        ? `Found a TXT record at _ashrt.${domain}, but not this value`
        : `No TXT record at _ashrt.${domain} yet`,
  })
  if (!ownership.ok) {
    return {
      state: 'pending_dns',
      message: `Add the TXT record at _ashrt.${domain}, then check again. DNS usually takes a few minutes.`,
      checks,
      records: dnsInstructions(domain, token),
    }
  }

  const routing = await checkRouting(domain)
  checks.push({
    name: isApex(domain) ? 'Routing (A)' : 'Routing (CNAME)',
    ok: routing.state === 'ok',
    detail:
      routing.state === 'ok'
        ? 'Pointing here'
        : routing.state === 'dns_incorrect'
          ? `Points at ${routing.found.join(', ')} instead`
          : 'No routing record found',
  })
  if (routing.state !== 'ok') {
    return {
      state: routing.state,
      message:
        routing.state === 'dns_incorrect'
          ? `${domain} is pointing somewhere else. Update the record to ${isApex(domain) ? A_TARGET : CNAME_TARGET} and check again.`
          : `Add the ${isApex(domain) ? 'A' : 'CNAME'} record and check again.`,
      checks,
      records: dnsInstructions(domain, token),
    }
  }

  const platform = await platformStatus(domain)
  if (!platform.known) {
    checks.push({
      name: 'Certificate',
      ok: false,
      detail: platform.error ? `Could not check: ${platform.error}` : 'Waiting to be attached',
    })
    return {
      state: 'pending_platform',
      message:
        'DNS is correct and ownership is proven. The domain still has to be attached to the deployment before HTTPS works, which we do on our side.',
      checks,
      records: dnsInstructions(domain, token),
      needsOperator: true,
    }
  }

  if (!platform.attached) {
    const attached = await attachDomain(domain)
    if (!attached.attached) {
      checks.push({ name: 'Certificate', ok: false, detail: attached.reason || 'Could not attach' })
      return {
        state: 'error',
        message: `The domain could not be attached automatically: ${attached.reason}. We have been told about it.`,
        checks,
        records: dnsInstructions(domain, token),
        needsOperator: true,
      }
    }
  }

  const after = platform.attached ? platform : await platformStatus(domain)
  const ready = after.known && after.verified && !after.misconfigured
  checks.push({
    name: 'Certificate',
    ok: ready,
    detail: ready ? 'Issued' : 'Being issued, usually within a minute or two',
  })

  return {
    state: ready ? 'active' : 'pending_ssl',
    message: ready
      ? `${domain} is live. New links can use it.`
      : 'Everything is in place. The HTTPS certificate is still being issued.',
    checks,
    records: dnsInstructions(domain, token),
  }
}
