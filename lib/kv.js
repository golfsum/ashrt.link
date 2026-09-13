/**
 * The storage backend, in one place.
 *
 * Two drivers, chosen automatically:
 *   - Upstash / Vercel KV (Redis over REST) when the env vars are present
 *   - local JSON files for `npm start` on a laptop
 *
 * store.js, ratelimit.js and abuse.js all go through here so there is exactly
 * one Redis client and one place that knows which driver is active.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN

export const useKV = Boolean(KV_URL && KV_TOKEN)
export const driver = useKV ? 'kv' : 'file'

/**
 * Where file-backed data lives. Defaults to the repo root, as it always has.
 * ASHRT_DATA_DIR points it elsewhere so the test suite gets its own scratch
 * directory instead of trampling a developer's local links.
 */
export const ROOT = process.env.ASHRT_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..')

export const today = () => new Date().toISOString().slice(0, 10)

/* -------------------------------- redis ---------------------------------- */

export async function redis(command) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  })
  const json = await res.json()
  if (json.error) throw new Error(json.error)
  return json.result
}

/**
 * Run several commands in one HTTP round-trip. This is what keeps the redirect
 * path fast: recording a click is a dozen writes that must not become a dozen
 * network hops. Returns results in order; individual errors surface as null.
 */
export async function pipeline(commands) {
  if (!commands.length) return []
  const res = await fetch(`${KV_URL.replace(/\/$/, '')}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  })
  const json = await res.json()
  if (!Array.isArray(json)) throw new Error(json?.error || 'pipeline failed')
  return json.map((r) => (r && r.error ? null : r?.result))
}

/* ------------------------------ file backend ------------------------------ */

export function fileRead(path, fallback = []) {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

export function fileWrite(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2))
}

/* ------------------------------ hash helpers ------------------------------ */

/** A Redis hash, exposed as a tiny document store. */
export const kvHash = (name) => ({
  async all() {
    const flat = (await redis(['HGETALL', name])) || []
    const out = []
    for (let i = 1; i < flat.length; i += 2) {
      try {
        out.push(JSON.parse(flat[i]))
      } catch {
        /* skip malformed entries rather than failing the whole read */
      }
    }
    return out
  },
  async get(field) {
    const v = await redis(['HGET', name, field])
    if (!v) return null
    try {
      return JSON.parse(v)
    } catch {
      return null
    }
  },
  /** For index hashes that map a key to a plain string id. */
  async getRaw(field) {
    return (await redis(['HGET', name, field])) || null
  },
  async put(field, value) {
    await redis(['HSET', name, field, typeof value === 'string' ? value : JSON.stringify(value)])
  },
  async del(field) {
    await redis(['HDEL', name, field])
  },
  async count() {
    return Number(await redis(['HLEN', name])) || 0
  },
  /** Fetch many fields at once instead of one HGET per id. */
  async many(fields) {
    if (!fields.length) return []
    const vals = (await redis(['HMGET', name, ...fields])) || []
    const out = []
    for (const v of vals) {
      if (!v) continue
      try {
        out.push(JSON.parse(v))
      } catch {
        /* skip */
      }
    }
    return out
  },
})

/** The same shape, backed by a JSON file: an array of records keyed by `key`. */
export const fileHash = (path, key) => ({
  async all() {
    return fileRead(path)
  },
  async get(field) {
    return fileRead(path).find((r) => r[key] === field) || null
  },
  async getRaw(field) {
    const r = fileRead(path).find((x) => x[key] === field)
    return r ? r.value ?? null : null
  },
  async put(field, value) {
    const all = fileRead(path).filter((r) => r[key] !== field)
    all.push(typeof value === 'string' ? { [key]: field, value } : value)
    fileWrite(path, all)
  },
  async del(field) {
    fileWrite(path, fileRead(path).filter((r) => r[key] !== field))
  },
  async count() {
    return fileRead(path).length
  },
  async many(fields) {
    const want = new Set(fields)
    return fileRead(path).filter((r) => want.has(r[key]))
  },
})

/** Pick the right backend for a collection. */
export const collection = (hashName, filePath, fileKey) =>
  useKV ? kvHash(hashName) : fileHash(join(ROOT, filePath), fileKey)

/* --------------------------- keyed JSON objects --------------------------- */

/**
 * A plain `{ key: value }` map (activity feeds, counters, per-day rollups).
 * In KV each map is its own Redis hash; in file mode they share one JSON file.
 */
export function jsonMapFile(filePath) {
  const path = join(ROOT, filePath)
  return {
    read: () => fileRead(path, {}),
    write: (obj) => fileWrite(path, obj),
  }
}
