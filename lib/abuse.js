/**
 * Abuse controls: the blocked-domain list, public reports, automatic suspicion
 * scoring, and the audit trail.
 *
 * Two principles run through this file.
 *
 * 1. Reports never take a link down on their own. Auto-disabling on report
 *    count would hand anyone a button for removing a competitor's link, so
 *    reports raise a flag for a human and nothing more.
 * 2. Blocks are checked at redirect time, not only at creation time, so
 *    blocking a domain kills every link already pointing at it.
 */

import crypto from 'node:crypto'
import { useKV, redis, collection, jsonMapFile, today } from './kv.js'
import { hostMatches, registrableDomain } from './urls.js'

const blockedStore = collection('ashrt:blocked', '.blocked.json', 'domain')
const reportStore = collection('ashrt:reports', '.reports.json', 'id')
const auditFile = jsonMapFile('.audit.json')

const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('base64url')}`

/* --------------------------- blocked destinations ------------------------- */

/**
 * The blocklist is read on every link creation and every redirect, so it is
 * cached in-process for a few seconds. Each serverless instance caches
 * independently; a block takes at most CACHE_MS to reach all of them.
 */
const CACHE_MS = 30_000
let cache = { at: 0, domains: [] }

export async function blockedDomains({ fresh = false } = {}) {
  if (!fresh && Date.now() - cache.at < CACHE_MS) return cache.domains
  try {
    const rows = await blockedStore.all()
    cache = { at: Date.now(), domains: rows.map((r) => r.domain) }
  } catch {
    // Never fail a redirect because the blocklist read failed; keep the last
    // known list rather than falling open to an empty one.
  }
  return cache.domains
}

export async function blockedEntries() {
  return (await blockedStore.all()).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
}

export async function blockDomain(domain, { reason = '', actor = null } = {}) {
  const d = String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^\*?\./, '')
    .replace(/\/.*$/, '')
  if (!/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) {
    return { ok: false, error: 'Enter a domain like example.com' }
  }
  await blockedStore.put(d, {
    domain: d,
    reason: String(reason || '').slice(0, 500),
    addedBy: actor?.id || null,
    addedAt: Date.now(),
  })
  cache.at = 0
  await audit({ actor, action: 'domain.blocked', targetType: 'domain', targetId: d, meta: { reason } })
  return { ok: true, domain: d }
}

export async function unblockDomain(domain, { actor = null } = {}) {
  const d = String(domain || '').trim().toLowerCase()
  await blockedStore.del(d)
  cache.at = 0
  await audit({ actor, action: 'domain.unblocked', targetType: 'domain', targetId: d })
  return { ok: true }
}

export function isBlocked(host, list) {
  return list.some((b) => hostMatches(host, b))
}

/* --------------------------- suspicion heuristics ------------------------- */

/** Brand names that phishing pages impersonate most often. */
const IMPERSONATED = [
  'paypal', 'apple', 'icloud', 'microsoft', 'office365', 'outlook', 'netflix',
  'amazon', 'google', 'gmail', 'facebook', 'instagram', 'whatsapp', 'coinbase',
  'binance', 'metamask', 'chase', 'wellsfargo', 'bankofamerica', 'hsbc',
  'dhl', 'fedex', 'ups', 'usps', 'irs', 'hmrc', 'steam', 'discord', 'roblox',
]

/** Hosts that hand out free subdomains, heavily used to stand up throwaway pages. */
const THROWAWAY_HOSTS = [
  'ngrok.io', 'ngrok-free.app', 'trycloudflare.com', 'loca.lt', 'serveo.net',
  'repl.co', 'replit.dev', 'glitch.me', 'vercel.app', 'netlify.app',
  'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'github.io',
  'weebly.com', 'wixsite.com', 'blogspot.com', '000webhostapp.com',
  'r2.dev', 'surge.sh', 'onrender.com', 'herokuapp.com',
]

/** Other shorteners: chaining them is how people launder a destination. */
const SHORTENERS = [
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly',
  'rebrand.ly', 'cutt.ly', 'shorturl.at', 'rb.gy', 'tiny.cc', 'bl.ink',
  's.id', 'short.io', 'lnkd.in', 'db.tt', 'qr.ae', 'adf.ly', 'shorte.st',
]

const CREDENTIAL_WORDS = /\b(login|signin|sign-in|verify|verification|secure|account|update|confirm|suspend|unlock|billing|invoice|password|wallet|seed|recover)\b/i

/**
 * Score a destination for review-worthiness. This is a triage signal for the
 * admin queue, not a verdict: nothing here blocks a link by itself.
 *
 * @returns {{score:number, signals:string[]}}
 */
export function suspicionScore(url, host) {
  const signals = []
  let score = 0
  const h = String(host || '').toLowerCase()
  const full = String(url || '').toLowerCase()
  const domain = registrableDomain(h)
  const labels = h.split('.')

  // A brand name in the subdomain or hyphenated into the domain, where the
  // registrable domain is not actually that brand's.
  for (const brand of IMPERSONATED) {
    if (h.includes(brand) && !domain.startsWith(brand + '.')) {
      score += 3
      signals.push(`impersonates:${brand}`)
      break
    }
  }

  if (THROWAWAY_HOSTS.some((t) => hostMatches(h, t))) {
    score += 2
    signals.push('throwaway-host')
  }
  if (SHORTENERS.some((s) => hostMatches(h, s))) {
    score += 2
    signals.push('shortener-chain')
  }
  if (h.startsWith('xn--') || labels.some((l) => l.startsWith('xn--'))) {
    score += 2
    signals.push('punycode-host')
  }
  if (labels.length >= 5) {
    score += 1
    signals.push('deep-subdomain')
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    score += 2
    signals.push('raw-ip-host')
  }
  if (CREDENTIAL_WORDS.test(full)) {
    score += 1
    signals.push('credential-language')
  }
  if (h.length > 40) {
    score += 1
    signals.push('long-host')
  }
  if ((h.match(/-/g) || []).length >= 4) {
    score += 1
    signals.push('hyphen-heavy')
  }
  if (full.length > 500) {
    score += 1
    signals.push('very-long-url')
  }

  return { score, signals }
}

/** At or above this, a new link is flagged for review (it still works). */
export const AUTO_FLAG_SCORE = 4

/* --------------------------------- reports -------------------------------- */

export const REPORT_REASONS = [
  'phishing', 'malware', 'spam', 'scam', 'adult', 'copyright', 'harassment', 'other',
]

export const REPORT_STATUSES = ['new', 'reviewing', 'actioned', 'dismissed']

/** Distinct reporters needed before a link is auto-flagged for a human. */
export const AUTO_FLAG_REPORTS = 3

export async function createReport({ slug, url, owner, reason, detail, reporterHash }) {
  const r = {
    id: newId('rep'),
    slug,
    url: String(url || '').slice(0, 2048),
    owner: owner || null,
    reason: REPORT_REASONS.includes(reason) ? reason : 'other',
    detail: String(detail || '').slice(0, 1000),
    reporterHash: reporterHash || null,
    status: 'new',
    notes: [],
    createdAt: Date.now(),
    resolvedAt: null,
    resolvedBy: null,
  }
  await reportStore.put(r.id, r)
  if (useKV) {
    await redis(['SADD', `ashrt:repbylink:${slug}`, r.id])
    await redis(['HINCRBY', 'ashrt:repcount', today(), 1])
  }
  return r
}

export async function reportsForLink(slug) {
  const all = await reportStore.all()
  return all.filter((r) => r.slug === slug).sort((a, b) => b.createdAt - a.createdAt)
}

export async function listReports({ status = null, limit = 100, cursor = 0 } = {}) {
  let all = await reportStore.all()
  if (status) all = all.filter((r) => r.status === status)
  all.sort((a, b) => b.createdAt - a.createdAt)
  const page = all.slice(cursor, cursor + limit)
  return { reports: page, total: all.length, nextCursor: cursor + limit < all.length ? cursor + limit : null }
}

export async function getReport(id) {
  return reportStore.get(id)
}

export async function updateReport(id, patch, { actor = null } = {}) {
  const r = await reportStore.get(id)
  if (!r) return null
  if (patch.status && REPORT_STATUSES.includes(patch.status)) {
    r.status = patch.status
    if (patch.status === 'actioned' || patch.status === 'dismissed') {
      r.resolvedAt = Date.now()
      r.resolvedBy = actor?.id || null
    }
  }
  if (patch.note) {
    r.notes.push({
      at: Date.now(),
      by: actor?.id || null,
      byEmail: actor?.email || null,
      text: String(patch.note).slice(0, 2000),
    })
  }
  await reportStore.put(r.id, r)
  await audit({
    actor,
    action: 'report.updated',
    targetType: 'report',
    targetId: r.id,
    meta: { status: r.status, slug: r.slug },
  })
  return r
}

/**
 * Should this link be flagged for review? True once enough *distinct* reporters
 * have complained. Flagging surfaces it to an admin; it does not disable it.
 */
export async function shouldAutoFlag(slug) {
  const reports = await reportsForLink(slug)
  const distinct = new Set(reports.map((r) => r.reporterHash).filter(Boolean))
  return distinct.size >= AUTO_FLAG_REPORTS
}

/* -------------------------------- audit log ------------------------------- */

const AUDIT_CAP = 2000

/**
 * Record a privileged action. Written for every admin mutation so a mistake can
 * be traced back. Deliberately stores no secrets: ids and short metadata only.
 */
export async function audit({ actor, action, targetType, targetId, meta = {} }) {
  const entry = {
    id: newId('aud'),
    at: Date.now(),
    actorId: actor?.id || null,
    actorEmail: actor?.email || null,
    action,
    targetType: targetType || null,
    targetId: targetId || null,
    meta,
  }
  try {
    if (useKV) {
      await redis(['LPUSH', 'ashrt:audit', JSON.stringify(entry)])
      await redis(['LTRIM', 'ashrt:audit', 0, AUDIT_CAP - 1])
    } else {
      const all = auditFile.read()
      all.entries = [entry, ...(all.entries || [])].slice(0, AUDIT_CAP)
      auditFile.write(all)
    }
  } catch {
    // The audit log is important but must never block the action it describes.
  }
  return entry
}

export async function auditLog({ limit = 100, cursor = 0, action = null } = {}) {
  let entries = []
  try {
    if (useKV) {
      const raw = (await redis(['LRANGE', 'ashrt:audit', 0, AUDIT_CAP - 1])) || []
      entries = raw.map((s) => {
        try {
          return JSON.parse(s)
        } catch {
          return null
        }
      }).filter(Boolean)
    } else {
      entries = auditFile.read().entries || []
    }
  } catch {
    entries = []
  }
  if (action) entries = entries.filter((e) => e.action === action)
  const page = entries.slice(cursor, cursor + limit)
  return { entries: page, total: entries.length, nextCursor: cursor + limit < entries.length ? cursor + limit : null }
}

/** Test hook: drop the blocklist cache. */
export function _clearCache() {
  cache = { at: 0, domains: [] }
}
