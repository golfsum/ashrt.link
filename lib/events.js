/**
 * Product analytics for the acquisition funnel.
 *
 * The question this exists to answer: does search traffic actually become
 * users? Without it the repositioning is a guess, and the answer only starts
 * accumulating once this is deployed.
 *
 * Two deliberate constraints:
 *
 * 1. **Counters, not an event stream.** Every event is a per-day tally. There
 *    is no per-person event log, nothing to join back to an individual, and
 *    nothing to leak. The cost is that you cannot replay one person's journey,
 *    which is not a question worth the privacy surface here.
 *
 * 2. **Server-side wherever the event is server-observable.** A signup, a link
 *    creation and a checkout are all things the server watches happen, so they
 *    are counted there: no beacon to be blocked, dropped or forged. Only
 *    genuine in-page interactions go through the client endpoint.
 *
 * Bot traffic is never counted.
 */

import { useKV, redis, pipeline, jsonMapFile, today } from './kv.js'

const file = jsonMapFile('.events.json')

/** Per-day retention for the counters. */
export const RETENTION_DAYS = 400

/**
 * Every event the system will record. An unknown name is dropped rather than
 * stored, so a client cannot invent cardinality by posting junk.
 */
export const EVENTS = [
  // Top of funnel
  'page_view_home',
  'page_view_landing',
  'tracker_started',

  // Activation
  'guest_link_created',
  'guest_link_viewed_stats',
  'user_link_created',
  'api_link_created',
  'bulk_links_created',

  // Signup
  'signup_viewed',
  'signup_started',
  'signup_completed',
  'login_completed',
  'guest_link_claimed',

  // Engagement
  'qr_created',
  'campaign_created',
  'api_key_created',
  'returning_user',

  // Revenue
  'upgrade_clicked',
  'checkout_started',
  'subscription_started',
]

const EVENT_SET = new Set(EVENTS)

/** Events a browser is allowed to report. Everything else is server-observed. */
export const CLIENT_EVENTS = new Set(['tracker_started', 'upgrade_clicked', 'signup_started'])

/* ------------------------------ acquisition ------------------------------- */

/**
 * Reduce a referrer to a handful of buckets.
 *
 * Keeping the raw referrer host would give unbounded cardinality and turn a
 * counter into something closer to a log. These buckets answer the actual
 * question, which is whether search is working.
 */
export function sourceOf(referer, { landing = '' } = {}) {
  if (!referer) return 'direct'
  let host
  try {
    host = new URL(referer).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return 'direct'
  }
  if (/(^|\.)google\./.test(host)) return 'google'
  if (/(^|\.)bing\.com$/.test(host)) return 'bing'
  if (/duckduckgo\.com$/.test(host)) return 'duckduckgo'
  if (/(^|\.)(yahoo|yandex|baidu|ecosia|brave)\./.test(host)) return 'search-other'
  if (/(twitter\.com|x\.com|t\.co|facebook\.com|instagram\.com|linkedin\.com|reddit\.com|news\.ycombinator\.com|pinterest\.|tiktok\.com|youtube\.com)$/.test(host)) {
    return 'social'
  }
  if (/mail\.|outlook\.|proton\.me$/.test(host)) return 'email'
  // Our own pages referring onward are not an acquisition source.
  if (landing && host.endsWith(landing)) return 'internal'
  return 'referral'
}

/* -------------------------------- recording ------------------------------- */

/**
 * Count one event. Never throws and never blocks the caller's real work:
 * analytics must not be able to fail a signup.
 *
 * @param {string} name   one of EVENTS
 * @param {object} [opts]
 * @param {string} [opts.source]  acquisition bucket, for funnel events
 * @param {number} [opts.count]   record N at once (default 1)
 */
export async function track(name, { source = null, count = 1 } = {}) {
  if (!EVENT_SET.has(name)) return false
  const day = today()
  try {
    if (useKV) {
      const cmds = [['HINCRBY', `ashrt:ev:${day}`, name, count]]
      if (source) cmds.push(['HINCRBY', `ashrt:acq:${day}`, `${name}|${source}`, count])
      // Expire the day buckets rather than sweeping them later.
      cmds.push(['EXPIRE', `ashrt:ev:${day}`, RETENTION_DAYS * 86400])
      if (source) cmds.push(['EXPIRE', `ashrt:acq:${day}`, RETENTION_DAYS * 86400])
      await pipeline(cmds)
    } else {
      const all = file.read()
      all[day] = all[day] || { events: {}, acq: {} }
      all[day].events[name] = (all[day].events[name] || 0) + count
      if (source) {
        const key = `${name}|${source}`
        all[day].acq[key] = (all[day].acq[key] || 0) + count
      }
      // KV expires its day buckets; the file backend has to drop old ones
      // itself or it grows without bound.
      const days = Object.keys(all).sort()
      if (days.length > RETENTION_DAYS) {
        for (const old of days.slice(0, days.length - RETENTION_DAYS)) delete all[old]
      }
      file.write(all)
    }
    return true
  } catch {
    return false
  }
}

/** Fire and forget, for call sites that must not wait on analytics. */
export function trackAsync(name, opts) {
  track(name, opts).catch(() => {})
}

/* --------------------------------- reading -------------------------------- */

const dayKeys = (days) => {
  const out = []
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10))
  }
  return out
}

/**
 * Per-day counts for every event over the last `days`.
 * @returns {Promise<{series: Record<string, Record<string, number>>, totals: Record<string, number>}>}
 */
export async function eventSeries(days = 30) {
  const keys = dayKeys(days)
  const series = {}
  const totals = {}

  const add = (day, name, n) => {
    series[day] = series[day] || {}
    series[day][name] = (series[day][name] || 0) + n
    totals[name] = (totals[name] || 0) + n
  }

  try {
    if (useKV) {
      const results = await pipeline(keys.map((d) => ['HGETALL', `ashrt:ev:${d}`]))
      keys.forEach((day, i) => {
        const flat = results[i] || []
        for (let j = 0; j < flat.length; j += 2) add(day, flat[j], Number(flat[j + 1]) || 0)
      })
    } else {
      const all = file.read()
      for (const day of keys) {
        for (const [name, n] of Object.entries(all[day]?.events || {})) add(day, name, n)
      }
    }
  } catch {
    /* an empty report beats a failed page */
  }

  for (const day of keys) series[day] = series[day] || {}
  return { series, totals, days: keys }
}

/** Signup counts by acquisition source over the last `days`. */
export async function acquisition(days = 30, event = 'signup_completed') {
  const keys = dayKeys(days)
  const bySource = {}
  try {
    if (useKV) {
      const results = await pipeline(keys.map((d) => ['HGETALL', `ashrt:acq:${d}`]))
      for (const flat of results) {
        const rows = flat || []
        for (let j = 0; j < rows.length; j += 2) {
          const [name, source] = String(rows[j]).split('|')
          if (name !== event) continue
          bySource[source] = (bySource[source] || 0) + (Number(rows[j + 1]) || 0)
        }
      }
    } else {
      const all = file.read()
      for (const day of keys) {
        for (const [key, n] of Object.entries(all[day]?.acq || {})) {
          const [name, source] = key.split('|')
          if (name !== event) continue
          bySource[source] = (bySource[source] || 0) + n
        }
      }
    }
  } catch {
    /* empty is fine */
  }
  return bySource
}

/**
 * The funnel, as stages with counts and step conversion.
 *
 * A rate is only reported when the stage above it has enough volume to mean
 * something. Two visitors and one signup is not a 50% conversion rate, it is
 * two visitors.
 */
export const MIN_FUNNEL_BASE = 20

export function buildFunnel(totals) {
  const visitors = (totals.page_view_home || 0) + (totals.page_view_landing || 0)
  const stages = [
    { key: 'visitors', label: 'Visited a public page', count: visitors },
    { key: 'tracker_started', label: 'Started using the tracker', count: totals.tracker_started || 0 },
    { key: 'guest_link_created', label: 'Created a link as a guest', count: totals.guest_link_created || 0 },
    { key: 'signup_completed', label: 'Created an account', count: totals.signup_completed || 0 },
    { key: 'subscription_started', label: 'Subscribed', count: totals.subscription_started || 0 },
  ]

  return stages.map((s, i) => {
    if (i === 0) return { ...s, rate: null, of: null }
    const prev = stages[i - 1]
    const rate = prev.count >= MIN_FUNNEL_BASE ? Math.round((s.count / prev.count) * 1000) / 10 : null
    return { ...s, rate, of: prev.label, enoughData: prev.count >= MIN_FUNNEL_BASE }
  })
}

/** Test hook. */
export function _reset() {
  if (!useKV) file.write({})
}
