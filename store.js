/**
 * Links, users, campaigns and usage counters.
 *
 * Backend selection lives in lib/kv.js. This file is about the data model.
 *
 * Redis layout:
 *   ashrt:links      hash  slug           -> link JSON
 *   ashrt:linkidx    zset  slug           scored by createdAt (admin paging)
 *   ashrt:byowner:<uid>  set  slug        a user's links, without scanning
 *   ashrt:gtok       hash  tokenHash      -> slug   (guest link management)
 *   ashrt:domain     hash  domain(lower)  -> userId (custom domain routing)
 *   ashrt:users      hash  userId         -> user JSON
 *   ashrt:useridx    zset  userId         scored by createdAt
 *   ashrt:email      hash  email(lower)   -> userId
 *   ashrt:apikey     hash  apiKeyHash     -> userId
 *   ashrt:oauth      hash  provider:sub   -> userId
 *   ashrt:stripe     hash  customerId     -> userId
 *   ashrt:campaigns  hash  campaignId     -> campaign JSON
 *   ashrt:bycamp:<uid>  set campaignId
 *   ashrt:uv:<slug>  hll   unique visitors per link
 *   ashrt:uvo:<uid>  hll   unique visitors per owner
 *   ashrt:meta       hash  migration flags
 *
 * The owner/campaign sets and the zsets are what stop a dashboard load from
 * reading every link in the system. Links created before they existed are
 * picked up by scripts/migrate.js.
 */

import crypto from 'node:crypto'
import { hashApiKey, keysOf } from './lib/apikeys.js'
import {
  useKV,
  driver,
  redis,
  pipeline,
  collection,
  jsonMapFile,
  today,
} from './lib/kv.js'

const linkBackend = collection('ashrt:links', '.links.json', 'slug')
const userBackend = collection('ashrt:users', '.users.json', 'id')
const campBackend = collection('ashrt:campaigns', '.campaigns.json', 'id')

const emailIdx = useKV ? collection('ashrt:email') : null
const apiKeyIdx = useKV ? collection('ashrt:apikey') : null
const oauthIdx = useKV ? collection('ashrt:oauth') : null
const stripeIdx = useKV ? collection('ashrt:stripe') : null
const guestTokIdx = useKV ? collection('ashrt:gtok') : null
// domain(lower) -> userId, so a branded host resolves in one lookup.
const domainIdx = useKV ? collection('ashrt:domain') : null

const actFile = jsonMapFile('.activity.json')
const whqFile = jsonMapFile('.webhookq.json')
const hitsFile = jsonMapFile('.apihits.json')
const guestFile = jsonMapFile('.guesttokens.json')

const lc = (s) => String(s || '').trim().toLowerCase()

/**
 * How many days of per-day click history to keep on a link record.
 *
 * This is storage, not entitlement: it matches the longest window any plan
 * sells (lib/plans.js), so the record can always answer what the top plan
 * promises. What each plan is allowed to *see* is windowed at the API. Keeping
 * the record longer than the plan shows is deliberate — upgrading reveals
 * history that was already there rather than starting the clock again.
 */
export const DAILY_RETENTION_DAYS = 730

/* ----------------------------- migration flags ---------------------------- */

let metaCache = { at: 0, flags: {} }

async function metaFlags() {
  if (Date.now() - metaCache.at < 60_000) return metaCache.flags
  if (!useKV) {
    metaCache = { at: Date.now(), flags: { ownerIndexBuilt: false } }
    return metaCache.flags
  }
  try {
    const flat = (await redis(['HGETALL', 'ashrt:meta'])) || []
    const flags = {}
    for (let i = 0; i < flat.length; i += 2) flags[flat[i]] = flat[i + 1]
    metaCache = { at: Date.now(), flags }
  } catch {
    /* keep the previous value */
  }
  return metaCache.flags
}

/**
 * Is the owner index trustworthy? Until the backfill has run we fall back to
 * scanning, so this ships without a flag day.
 */
async function ownerIndexReady() {
  if (!useKV) return false
  return (await metaFlags()).ownerIndexBuilt === '1'
}

export async function setMetaFlag(key, value) {
  if (!useKV) return
  await redis(['HSET', 'ashrt:meta', key, String(value)])
  metaCache.at = 0
}

/* -------------------------------- helpers --------------------------------- */

/**
 * API keys are stored hashed, so a database dump does not hand over accounts.
 * Re-exported from lib/apikeys.js rather than reimplemented: two hash functions
 * that drift apart would lock everybody out of the API at once.
 */
export { hashApiKey }

export function hashGuestToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex')
}

/**
 * Apply index writes, and do not let them fail quietly.
 *
 * The record itself is written before these run, so a swallowed failure here
 * produces a link that exists and redirects but that its owner cannot see and
 * cannot manage. That is a worse outcome than a slow request, so a failed
 * pipeline is retried command by command, and anything still failing after that
 * is logged loudly rather than discarded.
 */
async function writeIndexes(cmds, context = '') {
  if (!cmds.length) return true

  // A pipeline fails two ways. The whole call can throw, which is obvious, or
  // it can come back with per-command errors that lib/kv.js reports as null
  // results while the HTTP request itself "succeeded". The second kind is the
  // dangerous one, and it is the kind that strands a slug in an owner set.
  // Every command used for indexing (SADD, SREM, ZADD, ZREM, HSET, HDEL, DEL)
  // answers with a count, so a null here is always an error, never data.
  let retry = cmds
  try {
    const results = await pipeline(cmds)
    retry = cmds.filter((_, i) => results[i] === null || results[i] === undefined)
    if (!retry.length) return true
    console.error(
      `[store] ${retry.length} index command(s) rejected (${context}); retrying individually`,
    )
  } catch (err) {
    console.error(`[store] index pipeline failed (${context}): ${err.message}; retrying individually`)
  }

  let failed = 0
  for (const cmd of retry) {
    try {
      await redis(cmd)
    } catch (err) {
      failed++
      console.error(`[store] index write failed (${context}): ${cmd[0]} ${cmd[1]} - ${err.message}`)
    }
  }
  if (failed) {
    console.error(
      `[store] ${failed} index write(s) lost for ${context}. ` +
        'Links may be missing from dashboards until `npm run doctor -- --repair` is run.',
    )
  }
  return failed === 0
}

/**
 * Remove owner-index entries that are provably not that owner's links.
 *
 * Two kinds qualify: the record is gone, or the record exists and names a
 * different owner (a claimed guest link, a transfer). Anything else - a record
 * that would not parse, a read that came back short - is left in place, because
 * an index entry is cheap and an unindexed link is invisible.
 */
async function healOwnerIndex(owner, slugs, records, mine) {
  const parsed = new Map(records.filter(Boolean).map((l) => [l.slug, l]))
  const live = new Set(mine.map((l) => l.slug))
  const unaccounted = slugs.filter((s) => !live.has(s))
  if (!unaccounted.length) return

  const drop = []
  const unknown = []
  for (const slug of unaccounted) {
    const rec = parsed.get(slug)
    if (rec) drop.push(slug) // exists, belongs to someone else
    else unknown.push(slug) // missing, or unreadable - ask before removing
  }

  if (unknown.length) {
    const exists = await pipeline(unknown.map((s) => ['HEXISTS', 'ashrt:links', s]))
    unknown.forEach((slug, i) => {
      if (exists[i] === 0 || exists[i] === '0') drop.push(slug)
      else if (exists[i] === null || exists[i] === undefined) {
        // The check itself failed. Keep the entry.
      } else {
        console.error(
          `[store] ${slug} is indexed to ${owner} and still stored, but could not be read. ` +
            'Leaving the index entry in place; run `npm run doctor` to inspect it.',
        )
      }
    })
  }

  if (drop.length) await pipeline(drop.map((s) => ['SREM', `ashrt:byowner:${owner}`, s]))
}

/** Trim a per-day map so a long-lived link's record cannot grow without bound. */
function trimDaily(daily) {
  const keys = Object.keys(daily)
  if (keys.length <= DAILY_RETENTION_DAYS) return daily
  const keep = keys.sort().slice(-DAILY_RETENTION_DAYS)
  const out = {}
  for (const k of keep) out[k] = daily[k]
  return out
}

/** Defaults applied to every link so older records read like new ones. */
function hydrate(link) {
  if (!link) return null
  return {
    status: 'active',
    clicks: 0,
    botClicks: 0,
    daily: {},
    devices: {},
    countries: {},
    referrers: {},
    browsers: {},
    os: {},
    tags: [],
    rules: [],
    history: [],
    hours: {},
    weekdays: {},
    channels: {},
    title: null,
    campaign: null,
    expiresAt: null,
    startsAt: null,
    guest: !link.owner,
    lastClickAt: null,
    flagScore: 0,
    flagSignals: [],
    ...link,
  }
}

export function isExpired(link) {
  return Boolean(link?.expiresAt && link.expiresAt <= Date.now())
}

/**
 * A link with a go-live date that has not arrived yet.
 *
 * Separate from expired because it is the opposite problem and needs the
 * opposite message: "not yet" rather than "no longer", and the link is going to
 * start working on its own.
 */
export function isScheduled(link) {
  return Boolean(link?.startsAt && link.startsAt > Date.now())
}

/** The status a link should be treated as right now. */
export function effectiveStatus(link) {
  if (!link) return 'missing'
  if (link.status === 'disabled') return 'disabled'
  if (isExpired(link)) return 'expired'
  if (isScheduled(link)) return 'scheduled'
  return link.status || 'active'
}

/* ------------------------------ link storage ------------------------------ */

export const store = {
  driver,

  async all() {
    const links = await linkBackend.all()
    return links.map(hydrate).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  },

  /**
   * A user's links. Uses the owner set when the backfill has run, and falls
   * back to a full scan only until then.
   */
  async byOwner(owner) {
    if (!owner) return []
    if (useKV && (await ownerIndexReady())) {
      const slugs = (await redis(['SMEMBERS', `ashrt:byowner:${owner}`])) || []
      if (!slugs.length) return []
      const links = await linkBackend.many(slugs)
      const mine = links
        .map(hydrate)
        .filter((l) => l.owner === owner)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))

      // Self-heal, but only what can be proven dead.
      //
      // A slug in this set that no longer has a record, or whose record now
      // belongs to somebody else, is dead weight: it can never be shown, and it
      // used to count against the account's quota. Those get dropped here.
      //
      // A slug that is missing from the read for any other reason - a record
      // that failed to parse, a partial response - is left alone. Removing it
      // would quietly unindex a link that still exists and still redirects,
      // which is the exact failure this code is here to prevent.
      if (mine.length !== slugs.length) {
        healOwnerIndex(owner, slugs, links, mine).catch(() => {})
      }
      return mine
    }
    const links = await linkBackend.all()
    return links
      .filter((l) => l.owner === owner)
      .map(hydrate)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  },

  /**
   * How many links this account actually has.
   *
   * Deliberately counts the same thing byOwner() returns, rather than SCARD on
   * the index. Those are different numbers the moment the index drifts: a stale
   * slug left in the set counts toward the quota while showing up nowhere, so
   * someone is told they have used 19 of 25 links and cannot find any of them.
   *
   * The quota must count what you can see.
   */
  async countByOwner(owner) {
    if (!owner) return 0
    return (await this.byOwner(owner)).length
  },

  async get(slug) {
    return hydrate(await linkBackend.get(slug))
  },

  async exists(slug) {
    return Boolean(await linkBackend.get(slug))
  },

  /** Upsert. Keeps every index in step with the record. */
  async add(link) {
    const full = hydrate({ createdAt: Date.now(), ...link })
    full.daily = trimDaily(full.daily || {})
    await linkBackend.put(full.slug, full)
    if (useKV) {
      const cmds = [['ZADD', 'ashrt:linkidx', String(full.createdAt || Date.now()), full.slug]]
      if (full.owner) cmds.push(['SADD', `ashrt:byowner:${full.owner}`, full.slug])
      if (full.guestTokenHash) cmds.push(['HSET', 'ashrt:gtok', full.guestTokenHash, full.slug])
      await writeIndexes(cmds, `add ${full.slug}`)
    } else if (full.guestTokenHash) {
      const all = guestFile.read()
      all[full.guestTokenHash] = full.slug
      guestFile.write(all)
    }
    return full
  },

  async remove(slug) {
    const link = await linkBackend.get(slug)
    await linkBackend.del(slug)
    if (useKV) {
      const cmds = [['ZREM', 'ashrt:linkidx', slug], ['DEL', `ashrt:uv:${slug}`]]
      if (link?.owner) cmds.push(['SREM', `ashrt:byowner:${link.owner}`, slug])
      if (link?.guestTokenHash) cmds.push(['HDEL', 'ashrt:gtok', link.guestTokenHash])
      // A lost SREM here is what strands a slug in the owner set: the record is
      // gone, so it can never be displayed, but it used to keep counting
      // against the quota.
      await writeIndexes(cmds, `remove ${slug}`)
    }
  },

  /** Move a guest link to a real account (claiming it after signup). */
  async claim(slug, ownerId) {
    const link = await linkBackend.get(slug)
    if (!link) return null
    const previousOwner = link.owner
    link.owner = ownerId
    link.guest = false
    link.guestTokenHash = null
    link.expiresAt = null
    link.claimedAt = Date.now()
    await linkBackend.put(slug, link)
    if (useKV) {
      const cmds = [['SADD', `ashrt:byowner:${ownerId}`, slug]]
      if (previousOwner) cmds.push(['SREM', `ashrt:byowner:${previousOwner}`, slug])
      await pipeline(cmds).catch(() => {})
    }
    return hydrate(link)
  },

  async bySlugs(slugs) {
    if (!slugs?.length) return []
    return (await linkBackend.many(slugs)).map(hydrate)
  },

  /** Resolve a guest management token to its link. */
  async byGuestToken(token) {
    const h = hashGuestToken(token)
    if (!h) return null
    let slug
    if (useKV) {
      slug = await guestTokIdx.getRaw(h)
    } else {
      slug = guestFile.read()[h]
    }
    return slug ? this.get(slug) : null
  },

  /* -------------------------------- clicks -------------------------------- */

  /**
   * Record a click. Every write is batched into a single round-trip, because
   * this sits directly in the redirect path and a click must not cost a dozen
   * sequential network hops.
   *
   * Bot traffic is counted separately and never touches the human-facing
   * dimensions, so a Slack preview cannot masquerade as a visitor.
   */
  async recordClick(slug, ctx = {}, known = null) {
    // The redirect route has already read the link to check its status. Reuse
    // that instead of paying for a second HGET on the hottest path in the app.
    const raw = known || (await linkBackend.get(slug))
    if (!raw) return null
    const link = hydrate(raw)

    const day = ctx.day || today()

    if (ctx.isBot) {
      link.botClicks = (link.botClicks || 0) + 1
      link.botDaily = link.botDaily || {}
      link.botDaily[day] = (link.botDaily[day] || 0) + 1
      if (ctx.botName) {
        link.bots = link.bots || {}
        link.bots[ctx.botName] = (link.bots[ctx.botName] || 0) + 1
      }
      link.botDaily = trimDaily(link.botDaily)
      await linkBackend.put(slug, link)
      return link
    }

    const prev = link.clicks || 0
    link.clicks = prev + 1
    link.lastClickAt = Date.now()
    link.daily[day] = (link.daily[day] || 0) + 1
    link.daily = trimDaily(link.daily)

    const bump = (map, key) => {
      if (!key) return
      link[map] = link[map] || {}
      link[map][key] = (link[map][key] || 0) + 1
    }
    bump('devices', ctx.device)
    bump('countries', ctx.country)
    bump('referrers', ctx.refHost)
    bump('browsers', ctx.browser)
    bump('os', ctx.os)

    // When people click, in UTC. Two small fixed-size maps (24 and 7 keys), so
    // they cost nothing to keep and answer "when should I post" without
    // storing a row per click.
    const at = new Date()
    bump('hours', String(ctx.hour ?? at.getUTCHours()))
    bump('weekdays', String(ctx.weekday ?? at.getUTCDay()))

    // How the person arrived: a scanned QR code, or the link itself. Our own
    // codes carry a marker, so this is measured rather than guessed.
    bump('channels', ctx.channel === 'qr' ? 'qr' : 'link')

    // Which routing rule served this click, so a rule can be judged on its own
    // traffic rather than on a guess. "default" is the link's own destination.
    if (link.rules?.length) bump('routed', ctx.ruleId || 'default')

    if (useKV) {
      const cmds = [['HSET', 'ashrt:links', slug, JSON.stringify(link)]]
      if (ctx.visitorId) {
        cmds.push(['PFADD', `ashrt:uv:${slug}`, ctx.visitorId])
        if (link.owner) cmds.push(['PFADD', `ashrt:uvo:${link.owner}`, ctx.visitorId])
      }
      cmds.push(['HINCRBY', 'ashrt:clicks:day', day, 1])
      // Per-owner running total. Free to maintain here (the pipeline is going
      // out anyway) and it is what lets the admin user list show click volume
      // without reading every user's links.
      if (link.owner) cmds.push(['HINCRBY', 'ashrt:clicks:owner', link.owner, 1])
      await pipeline(cmds)
    } else {
      if (ctx.visitorId) {
        link.uv = link.uv || []
        if (!link.uv.includes(ctx.visitorId)) link.uv.push(ctx.visitorId)
        if (link.uv.length > 10000) link.uv = link.uv.slice(-10000)
      }
      await linkBackend.put(slug, link)
    }

    if (link.owner) {
      for (const m of [100, 1000, 10000, 100000]) {
        if (prev < m && link.clicks >= m) {
          await this.logActivity(link.owner, { type: 'milestone', slug, value: m, at: Date.now() })
        }
      }
    }
    return link
  },

  /** Approximate unique visitors for one link. */
  async uniquesForLink(slug) {
    if (useKV) {
      try {
        return Number(await redis(['PFCOUNT', `ashrt:uv:${slug}`])) || 0
      } catch {
        return 0
      }
    }
    const link = await linkBackend.get(slug)
    return link?.uv?.length || 0
  },

  /**
   * Unique visitors for many links in one round-trip. This replaces the
   * per-link PFCOUNT that made listing N links cost N network calls.
   */
  async uniquesForLinks(slugs) {
    const out = {}
    if (!slugs?.length) return out
    if (useKV) {
      try {
        const results = await pipeline(slugs.map((s) => ['PFCOUNT', `ashrt:uv:${s}`]))
        slugs.forEach((s, i) => (out[s] = Number(results[i]) || 0))
      } catch {
        for (const s of slugs) out[s] = 0
      }
      return out
    }
    const links = await linkBackend.many(slugs)
    for (const s of slugs) out[s] = links.find((l) => l.slug === s)?.uv?.length || 0
    return out
  },

  /* ------------------------------- analytics ------------------------------ */

  async linkSummary(slug) {
    const l = await this.get(slug)
    if (!l) return null
    return {
      slug: l.slug,
      url: l.url,
      owner: l.owner,
      title: l.title,
      status: effectiveStatus(l),
      campaign: l.campaign,
      tags: l.tags,
      clicks: l.clicks || 0,
      botClicks: l.botClicks || 0,
      visitors: await this.uniquesForLink(slug),
      createdAt: l.createdAt,
      expiresAt: l.expiresAt,
      startsAt: l.startsAt || null,
      lastClickAt: l.lastClickAt || null,
      series: l.daily || {},
      botSeries: l.botDaily || {},
      devices: l.devices || {},
      countries: l.countries || {},
      referrers: l.referrers || {},
      browsers: l.browsers || {},
      os: l.os || {},
      hours: l.hours || {},
      weekdays: l.weekdays || {},
      channels: l.channels || {},
      routed: l.routed || {},
      rules: l.rules || [],
      bots: l.bots || {},
    }
  },

  /** Aggregated analytics for a user's dashboard. */
  async summary(owner) {
    const links = await this.byOwner(owner)
    const series = {}
    // Links created per day. Needed so the dashboard can show an honest
    // period-over-period change for link count; there is no such history for
    // unique visitors (a HyperLogLog has no time dimension) or campaigns, which
    // is why neither of those gets a percentage.
    const linksSeries = {}
    const devices = {}
    const countries = {}
    const referrers = {}
    const browsers = {}
    const os = {}
    const hours = {}
    const weekdays = {}
    const channels = {}
    let totalClicks = 0
    let totalBotClicks = 0

    for (const l of links) {
      totalClicks += l.clicks || 0
      totalBotClicks += l.botClicks || 0
      if (l.createdAt) {
        const day = new Date(l.createdAt).toISOString().slice(0, 10)
        linksSeries[day] = (linksSeries[day] || 0) + 1
      }
      for (const [k, n] of Object.entries(l.daily || {})) series[k] = (series[k] || 0) + n
      for (const [k, n] of Object.entries(l.devices || {})) devices[k] = (devices[k] || 0) + n
      for (const [k, n] of Object.entries(l.countries || {})) countries[k] = (countries[k] || 0) + n
      for (const [k, n] of Object.entries(l.referrers || {})) referrers[k] = (referrers[k] || 0) + n
      for (const [k, n] of Object.entries(l.browsers || {})) browsers[k] = (browsers[k] || 0) + n
      for (const [k, n] of Object.entries(l.os || {})) os[k] = (os[k] || 0) + n
      for (const [k, n] of Object.entries(l.hours || {})) hours[k] = (hours[k] || 0) + n
      for (const [k, n] of Object.entries(l.weekdays || {})) weekdays[k] = (weekdays[k] || 0) + n
      for (const [k, n] of Object.entries(l.channels || {})) channels[k] = (channels[k] || 0) + n
    }

    let uniqueVisitors = 0
    if (useKV) {
      try {
        uniqueVisitors = Number(await redis(['PFCOUNT', `ashrt:uvo:${owner}`])) || 0
      } catch {
        uniqueVisitors = 0
      }
    } else {
      const set = new Set()
      for (const l of links) for (const id of l.uv || []) set.add(id)
      uniqueVisitors = set.size
    }

    const top = [...links].sort((a, b) => (b.clicks || 0) - (a.clicks || 0)).slice(0, 5)
    const uniques = await this.uniquesForLinks(top.map((l) => l.slug))
    const topLinks = top.map((l) => ({
      slug: l.slug,
      url: l.url,
      title: l.title,
      clicks: l.clicks || 0,
      visitors: uniques[l.slug] || 0,
      daily: l.daily || {},
    }))

    return {
      totalLinks: links.length,
      totalClicks,
      totalBotClicks,
      uniqueVisitors,
      series,
      linksSeries,
      devices,
      countries,
      referrers,
      browsers,
      os,
      hours,
      weekdays,
      channels,
      topLinks,
      activity: await this.activity(owner),
    }
  },

  /* ------------------------------- activity ------------------------------- */

  async logActivity(owner, event) {
    if (!owner) return
    try {
      if (useKV) {
        await pipeline([
          ['LPUSH', `ashrt:act:${owner}`, JSON.stringify(event)],
          ['LTRIM', `ashrt:act:${owner}`, 0, 49],
        ])
      } else {
        const all = actFile.read()
        all[owner] = [event, ...(all[owner] || [])].slice(0, 50)
        actFile.write(all)
      }
    } catch {
      /* activity is a nicety, never a blocker */
    }
  },

  async activity(owner) {
    try {
      if (useKV) {
        const raw = (await redis(['LRANGE', `ashrt:act:${owner}`, 0, 49])) || []
        return raw.map((s) => {
          try {
            return JSON.parse(s)
          } catch {
            return null
          }
        }).filter(Boolean)
      }
      return actFile.read()[owner] || []
    } catch {
      return []
    }
  },

  /* ---------------------------- webhook retries --------------------------- */

  /**
   * Deliveries that failed and are waiting to be tried again.
   *
   * A queue rather than an inline retry: a receiver that is down should not
   * hold open the request that triggered the event, and a serverless function
   * that has already answered cannot keep retrying in the background.
   *
   * Capped, because a permanently broken endpoint must not be able to fill the
   * store. The oldest entries are dropped first, which is the right direction:
   * a two-hour-old notification is worth less than a fresh one.
   */
  async queueDelivery(entry) {
    try {
      if (useKV) {
        await pipeline([
          ['LPUSH', 'ashrt:whq', JSON.stringify(entry)],
          ['LTRIM', 'ashrt:whq', 0, 999],
        ])
      } else {
        const all = whqFile.read()
        all.items = [entry, ...(all.items || [])].slice(0, 1000)
        whqFile.write(all)
      }
    } catch {
      /* a lost retry is better than a failed request */
    }
  },

  /** Take everything currently queued, leaving the queue empty. */
  async takeQueuedDeliveries(limit = 100) {
    try {
      if (useKV) {
        const raw = (await redis(['LRANGE', 'ashrt:whq', 0, limit - 1])) || []
        if (raw.length) await redis(['LTRIM', 'ashrt:whq', raw.length, -1])
        return raw
          .map((s) => {
            try {
              return JSON.parse(s)
            } catch {
              return null
            }
          })
          .filter(Boolean)
      }
      const all = whqFile.read()
      const items = (all.items || []).slice(0, limit)
      all.items = (all.items || []).slice(limit)
      whqFile.write(all)
      return items
    } catch {
      return []
    }
  },

  /* -------------------------------- admin --------------------------------- */

  /** Newest links first, paged, without reading the whole hash. */
  async page({ cursor = 0, limit = 50 } = {}) {
    if (useKV) {
      const slugs =
        (await redis(['ZREVRANGE', 'ashrt:linkidx', String(cursor), String(cursor + limit - 1)])) || []
      const links = (await linkBackend.many(slugs)).map(hydrate)
      const order = new Map(slugs.map((s, i) => [s, i]))
      links.sort((a, b) => (order.get(a.slug) ?? 0) - (order.get(b.slug) ?? 0))
      const total = Number(await redis(['ZCARD', 'ashrt:linkidx'])) || links.length
      return { links, total, nextCursor: cursor + limit < total ? cursor + limit : null }
    }
    const all = await this.all()
    return {
      links: all.slice(cursor, cursor + limit),
      total: all.length,
      nextCursor: cursor + limit < all.length ? cursor + limit : null,
    }
  },

  async totalLinks() {
    if (useKV) {
      try {
        return Number(await redis(['ZCARD', 'ashrt:linkidx'])) || (await linkBackend.count())
      } catch {
        return 0
      }
    }
    return linkBackend.count()
  },

  /**
   * Search across every link, for the admin link table.
   *
   * Redis has no secondary index on destination or owner, so this walks the
   * recency zset in chunks and filters as it goes, stopping at `maxScan`. The
   * result says whether it stopped early, because a search that silently
   * returns partial results is worse than one that admits it.
   */
  async searchPage({ q = '', status = '', guest = null, owner = '', cursor = 0, limit = 50, maxScan = 3000 } = {}) {
    const needle = String(q || '').trim().toLowerCase()

    // An exact short code is a direct lookup, not a scan.
    if (needle && /^[a-zA-Z0-9_-]{2,32}$/.test(needle)) {
      const direct = await this.get(needle)
      if (direct) return { links: [direct], total: 1, nextCursor: null, scanned: 1, truncated: false }
    }

    const matches = (l) => {
      if (status && effectiveStatus(l) !== status) return false
      if (guest !== null && Boolean(l.guest) !== guest) return false
      if (owner && l.owner !== owner) return false
      if (!needle) return true
      return (
        l.slug.toLowerCase().includes(needle) ||
        (l.url || '').toLowerCase().includes(needle) ||
        (l.title || '').toLowerCase().includes(needle)
      )
    }

    const found = []
    let scanned = 0
    let at = cursor
    let truncated = false

    while (found.length < limit + 1 && scanned < maxScan) {
      const batch = await this.page({ cursor: at, limit: 200 })
      if (!batch.links.length) break
      scanned += batch.links.length
      at += batch.links.length
      for (const l of batch.links) if (matches(l)) found.push(l)
      if (batch.nextCursor === null) break
      if (scanned >= maxScan) truncated = true
    }

    const page = found.slice(0, limit)
    return {
      links: page,
      total: found.length,
      nextCursor: found.length > limit ? at : null,
      scanned,
      truncated,
    }
  },

  /**
   * Link counts for many owners, in two round-trips rather than two per owner.
   *
   * Counts records, not index membership, for the same reason countByOwner
   * does: a stale slug in an owner set would otherwise show an admin "19 links"
   * for an account whose detail page lists six, which is exactly the
   * disagreement this whole area exists to stop. HKEYS returns slugs only, not
   * the records behind them, so the cost is one list of short strings however
   * many owners the page is showing.
   */
  async countsByOwners(ownerIds) {
    const out = {}
    if (!ownerIds?.length) return out
    if (useKV) {
      try {
        const [live, sets] = await Promise.all([
          redis(['HKEYS', 'ashrt:links']),
          pipeline(ownerIds.map((id) => ['SMEMBERS', `ashrt:byowner:${id}`])),
        ])
        const exists = new Set(live || [])
        ownerIds.forEach((id, i) => {
          const members = Array.isArray(sets[i]) ? sets[i] : []
          out[id] = members.filter((slug) => exists.has(slug)).length
        })
        return out
      } catch {
        // Falling back to the index is better than reporting zero for everyone:
        // it can overcount drift, but it is the right order of magnitude.
        try {
          const results = await pipeline(ownerIds.map((id) => ['SCARD', `ashrt:byowner:${id}`]))
          ownerIds.forEach((id, i) => (out[id] = Number(results[i]) || 0))
        } catch {
          for (const id of ownerIds) out[id] = 0
        }
        return out
      }
    }
    const all = await linkBackend.all()
    for (const id of ownerIds) out[id] = all.filter((l) => l.owner === id).length
    return out
  },

  /** Total clicks per owner, maintained incrementally by recordClick. */
  async clicksByOwner() {
    if (!useKV) {
      const all = await linkBackend.all()
      const out = {}
      for (const l of all) if (l.owner) out[l.owner] = (out[l.owner] || 0) + (l.clicks || 0)
      return out
    }
    try {
      const flat = (await redis(['HGETALL', 'ashrt:clicks:owner'])) || []
      const out = {}
      for (let i = 0; i < flat.length; i += 2) out[flat[i]] = Number(flat[i + 1])
      return out
    } catch {
      return {}
    }
  },

  /** Service-wide counts by link status, for the admin overview. */
  async statusCounts({ maxScan = 5000 } = {}) {
    const counts = { active: 0, flagged: 0, disabled: 0, expired: 0, guest: 0, owned: 0 }
    let at = 0
    let scanned = 0
    while (scanned < maxScan) {
      const batch = await this.page({ cursor: at, limit: 200 })
      if (!batch.links.length) break
      for (const l of batch.links) {
        counts[effectiveStatus(l)] = (counts[effectiveStatus(l)] || 0) + 1
        if (l.guest) counts.guest++
        else counts.owned++
      }
      scanned += batch.links.length
      at += batch.links.length
      if (batch.nextCursor === null) break
    }
    counts.scanned = scanned
    return counts
  },

  /** Clicks per day across the whole service, for the admin charts. */
  async clicksByDay() {
    if (!useKV) {
      const all = await this.all()
      const out = {}
      for (const l of all) for (const [d, n] of Object.entries(l.daily || {})) out[d] = (out[d] || 0) + n
      return out
    }
    try {
      const flat = (await redis(['HGETALL', 'ashrt:clicks:day'])) || []
      const out = {}
      for (let i = 0; i < flat.length; i += 2) out[flat[i]] = Number(flat[i + 1])
      return out
    } catch {
      return {}
    }
  },
}

/* ------------------------------ user storage ------------------------------ */

export const users = {
  async getById(id) {
    return userBackend.get(id)
  },

  async getByEmail(email) {
    if (useKV) {
      const id = await emailIdx.getRaw(lc(email))
      return id ? userBackend.get(id) : null
    }
    const all = await userBackend.all()
    return all.find((u) => lc(u.email) === lc(email)) || null
  },

  /**
   * API keys are looked up by hash. Records created before hashing still carry
   * a plaintext `apiKey`, so we fall back to that until the backfill runs.
   */
  async getByApiKey(key) {
    if (!key) return null
    const h = hashApiKey(key)
    if (useKV) {
      const id = (await apiKeyIdx.getRaw(h)) || (await apiKeyIdx.getRaw(key))
      return id ? userBackend.get(id) : null
    }
    const all = await userBackend.all()
    // keysOf covers both the multi-key list and an account that still has the
    // single key it was created with.
    return all.find((u) => u.apiKey === key || keysOf(u).some((k) => k.hash === h)) || null
  },

  async getByOAuth(provider, sub) {
    const field = `${provider}:${sub}`
    if (useKV) {
      const id = await oauthIdx.getRaw(field)
      return id ? userBackend.get(id) : null
    }
    const all = await userBackend.all()
    return all.find((u) => (u.oauth || []).includes(field)) || null
  },

  async getByStripe(customerId) {
    if (!customerId) return null
    if (useKV) {
      const id = await stripeIdx.getRaw(customerId)
      return id ? userBackend.get(id) : null
    }
    const all = await userBackend.all()
    return all.find((u) => u.stripeCustomerId === customerId) || null
  },

  async create(user) {
    await userBackend.put(user.id, user)
    if (useKV) {
      const cmds = [['ZADD', 'ashrt:useridx', String(user.createdAt || Date.now()), user.id]]
      if (user.email) cmds.push(['HSET', 'ashrt:email', lc(user.email), user.id])
      for (const k of keysOf(user)) cmds.push(['HSET', 'ashrt:apikey', k.hash, user.id])
      if (user.stripeCustomerId) cmds.push(['HSET', 'ashrt:stripe', user.stripeCustomerId, user.id])
      for (const o of user.oauth || []) cmds.push(['HSET', 'ashrt:oauth', o, user.id])
      await pipeline(cmds).catch(() => {})
    }
    return user
  },

  /**
   * Pass the hashes of any keys that no longer exist, so their index entries
   * go with them. A revoked key that is still indexed still authenticates.
   */
  async update(user, { oldApiKeyHash, removedKeyHashes = [] } = {}) {
    await userBackend.put(user.id, user)
    if (useKV) {
      const cmds = []
      const live = new Set(keysOf(user).map((k) => k.hash))
      for (const h of [oldApiKeyHash, ...removedKeyHashes]) {
        if (h && !live.has(h)) cmds.push(['HDEL', 'ashrt:apikey', h])
      }
      for (const k of keysOf(user)) cmds.push(['HSET', 'ashrt:apikey', k.hash, user.id])
      if (user.email) cmds.push(['HSET', 'ashrt:email', lc(user.email), user.id])
      if (user.stripeCustomerId) cmds.push(['HSET', 'ashrt:stripe', user.stripeCustomerId, user.id])
      for (const o of user.oauth || []) cmds.push(['HSET', 'ashrt:oauth', o, user.id])
      if (cmds.length) await pipeline(cmds).catch(() => {})
    }
    return user
  },

  async all() {
    return userBackend.all()
  },

  /** Fetch many accounts at once, for resolving ids to emails in lists. */
  async byIds(ids) {
    if (!ids?.length) return []
    return userBackend.many(ids)
  },

  /**
   * Which account owns a custom domain.
   *
   * Sits in the redirect path for any request arriving on a branded host, so it
   * is an index lookup, never a scan, and the result is cached by the caller.
   */
  async getByDomain(domain) {
    const d = lc(domain)
    if (!d) return null
    if (useKV) {
      const id = await domainIdx.getRaw(d)
      return id ? userBackend.get(id) : null
    }
    const all = await userBackend.all()
    return all.find((u) => (u.domains || []).some((x) => lc(x.domain) === d && x.status === 'verified')) || null
  },

  /** Claim a domain for an account, or report who already holds it. */
  async claimDomain(domain, userId) {
    const d = lc(domain)
    if (useKV) {
      const existing = await domainIdx.getRaw(d)
      if (existing && existing !== userId) return { ok: false, takenBy: existing }
      await domainIdx.put(d, userId)
    }
    return { ok: true }
  },

  async releaseDomain(domain) {
    if (useKV) await domainIdx.del(lc(domain))
  },

  /** Every verified custom domain, for the admin view. */
  async allDomains() {
    const out = []
    for (const u of await userBackend.all()) {
      for (const d of u.domains || []) out.push({ ...d, owner: u.id, ownerEmail: u.email })
    }
    return out
  },

  /**
   * Find accounts by email, name or id, for admin support work.
   *
   * This scans the user hash. That is acceptable where a link scan is not:
   * accounts are orders of magnitude fewer than links, and this runs on an
   * admin page rather than in the redirect path. If the account count ever
   * approaches the link count, this needs an index like the links have.
   */
  async search(q, { limit = 50 } = {}) {
    const needle = String(q || '').trim().toLowerCase()
    if (!needle) return []
    const all = await userBackend.all()
    return all
      .filter(
        (u) =>
          String(u.id).toLowerCase() === needle ||
          String(u.email || '').toLowerCase().includes(needle) ||
          String(u.name || '').toLowerCase().includes(needle),
      )
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, limit)
  },

  /** How many accounts were created in a time window. */
  async countSince(since) {
    if (useKV) {
      try {
        return Number(await redis(['ZCOUNT', 'ashrt:useridx', String(since), '+inf'])) || 0
      } catch {
        return 0
      }
    }
    return (await userBackend.all()).filter((u) => (u.createdAt || 0) >= since).length
  },

  /** Plan distribution. Scans accounts, for the reason given on search(). */
  async planDistribution() {
    const out = { free: 0, pro: 0, business: 0, suspended: 0, admin: 0 }
    for (const u of await userBackend.all()) {
      const plan = ['free', 'pro', 'business'].includes(u.plan) ? u.plan : 'free'
      out[plan]++
      if (u.status === 'suspended') out.suspended++
      if (u.role === 'admin') out.admin++
    }
    return out
  },

  async count() {
    if (useKV) {
      try {
        return Number(await redis(['ZCARD', 'ashrt:useridx'])) || (await userBackend.count())
      } catch {
        return 0
      }
    }
    return userBackend.count()
  },

  /** Newest users first, paged. */
  async page({ cursor = 0, limit = 50 } = {}) {
    if (useKV) {
      const ids =
        (await redis(['ZREVRANGE', 'ashrt:useridx', String(cursor), String(cursor + limit - 1)])) || []
      const rows = await userBackend.many(ids)
      const order = new Map(ids.map((id, i) => [id, i]))
      rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      const total = Number(await redis(['ZCARD', 'ashrt:useridx'])) || rows.length
      return { users: rows, total, nextCursor: cursor + limit < total ? cursor + limit : null }
    }
    const all = (await userBackend.all()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    return {
      users: all.slice(cursor, cursor + limit),
      total: all.length,
      nextCursor: cursor + limit < all.length ? cursor + limit : null,
    }
  },
}

/* ---------------------------- campaign storage ---------------------------- */

export const campaigns = {
  async byOwner(owner) {
    if (useKV && (await ownerIndexReady())) {
      const ids = (await redis(['SMEMBERS', `ashrt:bycamp:${owner}`])) || []
      if (!ids.length) return []
      const rows = await campBackend.many(ids)
      return rows.filter((c) => c.owner === owner).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    }
    const all = await campBackend.all()
    return all.filter((c) => c.owner === owner).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  },
  async get(id) {
    return campBackend.get(id)
  },
  async create(camp) {
    await campBackend.put(camp.id, camp)
    if (useKV) await redis(['SADD', `ashrt:bycamp:${camp.owner}`, camp.id]).catch(() => {})
    return camp
  },
  async update(camp) {
    await campBackend.put(camp.id, camp)
    return camp
  },
  async remove(id) {
    const camp = await campBackend.get(id)
    await campBackend.del(id)
    if (useKV && camp?.owner) await redis(['SREM', `ashrt:bycamp:${camp.owner}`, id]).catch(() => {})
  },
  async count() {
    return campBackend.count()
  },
}

/* ----------------------------- API usage stats ---------------------------- */

export const apiUsage = {
  async record(owner) {
    if (!owner) return
    try {
      if (useKV) {
        await redis(['HINCRBY', `ashrt:apihits:${owner}`, today(), 1])
      } else {
        const all = hitsFile.read()
        all[owner] = all[owner] || {}
        all[owner][today()] = (all[owner][today()] || 0) + 1
        hitsFile.write(all)
      }
    } catch {
      /* usage counters are not worth failing a request over */
    }
  },

  async byDay(owner) {
    try {
      if (useKV) {
        const flat = (await redis(['HGETALL', `ashrt:apihits:${owner}`])) || []
        const out = {}
        for (let i = 0; i < flat.length; i += 2) out[flat[i]] = Number(flat[i + 1])
        return out
      }
      return hitsFile.read()[owner] || {}
    } catch {
      return {}
    }
  },
}

export { useKV, driver }
