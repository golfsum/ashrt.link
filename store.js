import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Link store with two backends, chosen automatically:
 *   - Vercel KV / Upstash Redis  (when KV_REST_API_URL + KV_REST_API_TOKEN are set)
 *   - a local JSON file          (everything else, e.g. `npm start` on your machine)
 *
 * Vercel's filesystem is read-only, so production must use KV. Locally the file
 * keeps things zero-config. All methods are async so both backends look the same.
 */

const KV_URL = process.env.KV_REST_API_URL
const KV_TOKEN = process.env.KV_REST_API_TOKEN
const useKV = Boolean(KV_URL && KV_TOKEN)
const HASH = 'ashrt:links' // Redis hash: field = slug, value = JSON

const __dirname = dirname(fileURLToPath(import.meta.url))
const FILE = join(__dirname, '.links.json')

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

const kv = {
  async all() {
    const flat = (await redis(['HGETALL', HASH])) || []
    const out = []
    for (let i = 1; i < flat.length; i += 2) out.push(JSON.parse(flat[i]))
    return out
  },
  async get(slug) {
    const v = await redis(['HGET', HASH, slug])
    return v ? JSON.parse(v) : null
  },
  async put(link) {
    await redis(['HSET', HASH, link.slug, JSON.stringify(link)])
    return link
  },
  async del(slug) {
    await redis(['HDEL', HASH, slug])
  },
}

/* ------------------------------ file backend ------------------------------ */

function fileRead() {
  if (!existsSync(FILE)) return []
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'))
  } catch {
    return []
  }
}
function fileWrite(data) {
  writeFileSync(FILE, JSON.stringify(data, null, 2))
}

const file = {
  async all() {
    return fileRead()
  },
  async get(slug) {
    return fileRead().find((l) => l.slug === slug) || null
  },
  async put(link) {
    const all = fileRead().filter((l) => l.slug !== link.slug)
    all.push(link)
    fileWrite(all)
    return link
  },
  async del(slug) {
    fileWrite(fileRead().filter((l) => l.slug !== slug))
  },
}

const backend = useKV ? kv : file

/* ------------------------------ public API -------------------------------- */

export const store = {
  driver: useKV ? 'kv' : 'file',

  async all() {
    const links = await backend.all()
    return links.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  },
  async get(slug) {
    return backend.get(slug)
  },
  async exists(slug) {
    return Boolean(await backend.get(slug))
  },
  async add(link) {
    return backend.put({ clicks: 0, createdAt: Date.now(), daily: {}, ...link })
  },
  async remove(slug) {
    await backend.del(slug)
  },
  async recordClick(slug) {
    const link = await backend.get(slug)
    if (!link) return null
    link.clicks = (link.clicks || 0) + 1
    link.lastClickAt = Date.now()
    link.daily = link.daily || {}
    const d = today()
    link.daily[d] = (link.daily[d] || 0) + 1
    await backend.put(link)
    return link
  },
}
