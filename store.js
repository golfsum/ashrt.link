import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Storage with two backends, chosen automatically:
 *   - Vercel KV / Upstash Redis  (when KV_REST_API_URL + KV_REST_API_TOKEN are set)
 *   - local JSON files           (everything else, e.g. `npm start` on your machine)
 *
 * Vercel's filesystem is read-only, so production must use KV. Locally the files
 * keep things zero-config. All methods are async so both backends look the same.
 *
 * Redis layout:
 *   ashrt:links   hash  slug            -> link JSON  (link has an `owner` userId)
 *   ashrt:users   hash  userId          -> user JSON
 *   ashrt:email   hash  email(lower)    -> userId      (login + uniqueness)
 *   ashrt:apikey  hash  apiKey          -> userId      (API-key auth)
 *   ashrt:oauth   hash  provider:subId  -> userId      (social login)
 */

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
const useKV = Boolean(KV_URL && KV_TOKEN)

const H_LINKS = 'ashrt:links'
const H_USERS = 'ashrt:users'
const H_EMAIL = 'ashrt:email'
const H_APIKEY = 'ashrt:apikey'
const H_OAUTH = 'ashrt:oauth'
const H_STRIPE = 'ashrt:stripe'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LINKS_FILE = join(__dirname, '.links.json')
const USERS_FILE = join(__dirname, '.users.json')
const ACT_FILE = join(__dirname, '.activity.json')

const today = () => new Date().toISOString().slice(0, 10)

/* ------------------------------- KV backend ------------------------------- */

async function redis(command) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  })
  const json = await res.json()
  if (json.error) throw new Error(json.error)
  return json.result
}

// Generic hash helpers over Redis.
const kvHash = (name) => ({
  async all() {
    const flat = (await redis(['HGETALL', name])) || []
    const out = []
    for (let i = 1; i < flat.length; i += 2) out.push(JSON.parse(flat[i]))
    return out
  },
  async get(field) {
    const v = await redis(['HGET', name, field])
    return v ? JSON.parse(v) : null
  },
  // Stored as a plain string (used by the index hashes that map -> userId).
  async getRaw(field) {
    return (await redis(['HGET', name, field])) || null
  },
  async put(field, value) {
    await redis(['HSET', name, field, typeof value === 'string' ? value : JSON.stringify(value)])
  },
  async del(field) {
    await redis(['HDEL', name, field])
  },
})

/* ------------------------------ file backend ------------------------------ */

function fileRead(path) {
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}
function fileWrite(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2))
}

// A file-backed hash: an array of records keyed by `key`.
const fileHash = (path, key) => ({
  async all() {
    return fileRead(path)
  },
  async get(field) {
    return fileRead(path).find((r) => r[key] === field) || null
  },
  async put(field, value) {
    const all = fileRead(path).filter((r) => r[key] !== field)
    all.push(value)
    fileWrite(path, all)
  },
  async del(field) {
    fileWrite(path, fileRead(path).filter((r) => r[key] !== field))
  },
})

/* ------------------------------ link storage ------------------------------ */

const linkBackend = useKV ? kvHash(H_LINKS) : fileHash(LINKS_FILE, 'slug')

export const store = {
  driver: useKV ? 'kv' : 'file',

  async all() {
    const links = await linkBackend.all()
    return links.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  },
  // Links owned by a single user, newest first.
  async byOwner(owner) {
    const links = await linkBackend.all()
    return links.filter((l) => l.owner === owner).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  },
  async get(slug) {
    return linkBackend.get(slug)
  },
  async exists(slug) {
    return Boolean(await linkBackend.get(slug))
  },
  async add(link) {
    const full = { clicks: 0, createdAt: Date.now(), daily: {}, ...link }
    await linkBackend.put(full.slug, full)
    return full
  },
  async remove(slug) {
    await linkBackend.del(slug)
  },
  // Record a click and roll up the analytics dimensions we capture at redirect
  // time: device, country, referrer host, and a hashed unique-visitor id.
  async recordClick(slug, ctx = {}) {
    const link = await linkBackend.get(slug)
    if (!link) return null
    const prev = link.clicks || 0
    link.clicks = prev + 1
    link.lastClickAt = Date.now()
    link.daily = link.daily || {}
    link.daily[ctx.day || today()] = (link.daily[ctx.day || today()] || 0) + 1

    if (ctx.device) {
      link.devices = link.devices || {}
      link.devices[ctx.device] = (link.devices[ctx.device] || 0) + 1
    }
    if (ctx.country) {
      link.countries = link.countries || {}
      link.countries[ctx.country] = (link.countries[ctx.country] || 0) + 1
    }
    if (ctx.refHost) {
      link.referrers = link.referrers || {}
      link.referrers[ctx.refHost] = (link.referrers[ctx.refHost] || 0) + 1
    }
    if (ctx.visitorId) {
      if (useKV) {
        await redis(['PFADD', `ashrt:uv:${slug}`, ctx.visitorId])
        if (link.owner) await redis(['PFADD', `ashrt:uvo:${link.owner}`, ctx.visitorId])
      } else {
        link.uv = link.uv || []
        if (!link.uv.includes(ctx.visitorId)) link.uv.push(ctx.visitorId)
      }
    }
    await linkBackend.put(slug, link)

    // Note click milestones in the owner's activity feed.
    if (link.owner) {
      for (const m of [100, 1000, 10000, 100000]) {
        if (prev < m && link.clicks >= m) {
          await this.logActivity(link.owner, { type: 'milestone', slug, value: m, at: Date.now() })
        }
      }
    }
    return link
  },

  // Approximate unique visitors for one link (HLL on KV, a set in file mode).
  async uniquesForLink(slug) {
    if (useKV) return Number(await redis(['PFCOUNT', `ashrt:uv:${slug}`])) || 0
    const link = await linkBackend.get(slug)
    return link?.uv?.length || 0
  },

  // Full analytics for a single link (its detail page).
  async linkSummary(slug) {
    const l = await linkBackend.get(slug)
    if (!l) return null
    return {
      slug: l.slug,
      url: l.url,
      owner: l.owner,
      clicks: l.clicks || 0,
      visitors: await this.uniquesForLink(slug),
      createdAt: l.createdAt,
      lastClickAt: l.lastClickAt || null,
      series: l.daily || {},
      devices: l.devices || {},
      countries: l.countries || {},
      referrers: l.referrers || {},
    }
  },

  // Aggregated analytics for a user's dashboard.
  async summary(owner) {
    const links = await this.byOwner(owner)
    const series = {}
    const devices = {}
    const countries = {}
    const referrers = {}
    let totalClicks = 0
    for (const l of links) {
      totalClicks += l.clicks || 0
      for (const [k, n] of Object.entries(l.daily || {})) series[k] = (series[k] || 0) + n
      for (const [k, n] of Object.entries(l.devices || {})) devices[k] = (devices[k] || 0) + n
      for (const [k, n] of Object.entries(l.countries || {})) countries[k] = (countries[k] || 0) + n
      for (const [k, n] of Object.entries(l.referrers || {})) referrers[k] = (referrers[k] || 0) + n
    }

    let uniqueVisitors = 0
    if (useKV) {
      uniqueVisitors = Number(await redis(['PFCOUNT', `ashrt:uvo:${owner}`])) || 0
    } else {
      const set = new Set()
      for (const l of links) for (const id of l.uv || []) set.add(id)
      uniqueVisitors = set.size
    }

    const top = [...links].sort((a, b) => (b.clicks || 0) - (a.clicks || 0)).slice(0, 5)
    const topLinks = []
    for (const l of top) {
      topLinks.push({
        slug: l.slug,
        url: l.url,
        clicks: l.clicks || 0,
        visitors: await this.uniquesForLink(l.slug),
        daily: l.daily || {},
      })
    }

    return {
      totalLinks: links.length,
      totalClicks,
      uniqueVisitors,
      series,
      devices,
      countries,
      referrers,
      topLinks,
      activity: await this.activity(owner),
    }
  },

  // Owner activity feed (newest first), capped at 50 entries.
  async logActivity(owner, event) {
    if (!owner) return
    if (useKV) {
      await redis(['LPUSH', `ashrt:act:${owner}`, JSON.stringify(event)])
      await redis(['LTRIM', `ashrt:act:${owner}`, 0, 49])
    } else {
      const all = actRead()
      all[owner] = [event, ...(all[owner] || [])].slice(0, 50)
      actWrite(all)
    }
  },
  async activity(owner) {
    if (useKV) {
      const raw = (await redis(['LRANGE', `ashrt:act:${owner}`, 0, 49])) || []
      return raw.map((s) => JSON.parse(s))
    }
    return actRead()[owner] || []
  },
}

function actRead() {
  if (!existsSync(ACT_FILE)) return {}
  try {
    return JSON.parse(readFileSync(ACT_FILE, 'utf8'))
  } catch {
    return {}
  }
}
function actWrite(obj) {
  writeFileSync(ACT_FILE, JSON.stringify(obj, null, 2))
}

/* ------------------------------ user storage ------------------------------ */

const userBackend = useKV ? kvHash(H_USERS) : fileHash(USERS_FILE, 'id')
const emailIdx = useKV ? kvHash(H_EMAIL) : null
const apiKeyIdx = useKV ? kvHash(H_APIKEY) : null
const oauthIdx = useKV ? kvHash(H_OAUTH) : null
const stripeIdx = useKV ? kvHash(H_STRIPE) : null

const lc = (s) => String(s || '').trim().toLowerCase()

export const users = {
  async getById(id) {
    return userBackend.get(id)
  },

  async getByEmail(email) {
    if (useKV) {
      const id = await emailIdx.getRaw(lc(email))
      return id ? userBackend.get(id) : null
    }
    return fileRead(USERS_FILE).find((u) => lc(u.email) === lc(email)) || null
  },

  async getByApiKey(key) {
    if (!key) return null
    if (useKV) {
      const id = await apiKeyIdx.getRaw(key)
      return id ? userBackend.get(id) : null
    }
    return fileRead(USERS_FILE).find((u) => u.apiKey === key) || null
  },

  async getByOAuth(provider, sub) {
    const field = `${provider}:${sub}`
    if (useKV) {
      const id = await oauthIdx.getRaw(field)
      return id ? userBackend.get(id) : null
    }
    return fileRead(USERS_FILE).find((u) => (u.oauth || []).includes(field)) || null
  },

  async getByStripe(customerId) {
    if (!customerId) return null
    if (useKV) {
      const id = await stripeIdx.getRaw(customerId)
      return id ? userBackend.get(id) : null
    }
    return fileRead(USERS_FILE).find((u) => u.stripeCustomerId === customerId) || null
  },

  // Create a user record and update all secondary indexes.
  async create(user) {
    await userBackend.put(user.id, user)
    if (useKV) {
      if (user.email) await emailIdx.put(lc(user.email), user.id)
      if (user.apiKey) await apiKeyIdx.put(user.apiKey, user.id)
      if (user.stripeCustomerId) await stripeIdx.put(user.stripeCustomerId, user.id)
      for (const o of user.oauth || []) await oauthIdx.put(o, user.id)
    }
    return user
  },

  // Persist a changed user. Pass the previous apiKey when rotating so the old
  // index entry is removed.
  async update(user, { oldApiKey } = {}) {
    await userBackend.put(user.id, user)
    if (useKV) {
      if (oldApiKey && oldApiKey !== user.apiKey) await apiKeyIdx.del(oldApiKey)
      if (user.apiKey) await apiKeyIdx.put(user.apiKey, user.id)
      if (user.stripeCustomerId) await stripeIdx.put(user.stripeCustomerId, user.id)
      for (const o of user.oauth || []) await oauthIdx.put(o, user.id)
    }
    return user
  },
}
