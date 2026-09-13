/**
 * A tiny in-memory stand-in for Upstash / Vercel KV, speaking the same REST
 * shape the real thing does.
 *
 * The KV path is what actually runs in production, so testing only the file
 * backend would leave the important code untested. This implements just the
 * commands store.js, abuse.js, ratelimit.js and the migration use.
 *
 * Sets stand in for HyperLogLog: exact instead of approximate, which is what a
 * test wants anyway.
 */

import http from 'node:http'

export function createFakeKV() {
  /** @type {Map<string, any>} */
  const db = new Map()

  const asHash = (key) => {
    if (!db.has(key)) db.set(key, new Map())
    return db.get(key)
  }
  const asSet = (key) => {
    if (!db.has(key)) db.set(key, new Set())
    return db.get(key)
  }
  const asList = (key) => {
    if (!db.has(key)) db.set(key, [])
    return db.get(key)
  }
  /** zset as Map<member, score> */
  const asZset = asHash

  function run(cmd) {
    const [rawOp, ...args] = cmd
    const op = String(rawOp).toUpperCase()

    switch (op) {
      case 'HSET': {
        const h = asHash(args[0])
        for (let i = 1; i < args.length; i += 2) h.set(String(args[i]), String(args[i + 1]))
        return 1
      }
      case 'HGET':
        return asHash(args[0]).get(String(args[1])) ?? null
      case 'HMGET': {
        const h = asHash(args[0])
        return args.slice(1).map((f) => h.get(String(f)) ?? null)
      }
      case 'HGETALL': {
        const out = []
        for (const [k, v] of asHash(args[0])) out.push(k, v)
        return out
      }
      case 'HDEL': {
        const h = asHash(args[0])
        let n = 0
        for (const f of args.slice(1)) if (h.delete(String(f))) n++
        return n
      }
      case 'HLEN':
        return asHash(args[0]).size
      case 'HINCRBY': {
        const h = asHash(args[0])
        const next = Number(h.get(String(args[1])) || 0) + Number(args[2])
        h.set(String(args[1]), String(next))
        return next
      }

      case 'SADD': {
        const s = asSet(args[0])
        let n = 0
        for (const m of args.slice(1)) if (!s.has(String(m))) { s.add(String(m)); n++ }
        return n
      }
      case 'SREM': {
        const s = asSet(args[0])
        let n = 0
        for (const m of args.slice(1)) if (s.delete(String(m))) n++
        return n
      }
      case 'SMEMBERS':
        return [...asSet(args[0])]
      case 'SCARD':
        return asSet(args[0]).size

      case 'ZADD': {
        const z = asZset(args[0])
        for (let i = 1; i < args.length; i += 2) z.set(String(args[i + 1]), Number(args[i]))
        return 1
      }
      case 'ZREM': {
        const z = asZset(args[0])
        let n = 0
        for (const m of args.slice(1)) if (z.delete(String(m))) n++
        return n
      }
      case 'ZCARD':
        return asZset(args[0]).size
      case 'ZCOUNT': {
        const z = asZset(args[0])
        const lo = args[1] === '-inf' ? -Infinity : Number(args[1])
        const hi = args[2] === '+inf' ? Infinity : Number(args[2])
        let n = 0
        for (const score of z.values()) if (score >= lo && score <= hi) n++
        return n
      }
      case 'ZREVRANGE': {
        const z = asZset(args[0])
        const sorted = [...z.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m)
        const start = Number(args[1])
        const stop = Number(args[2])
        return sorted.slice(start, stop < 0 ? undefined : stop + 1)
      }

      case 'LPUSH': {
        const l = asList(args[0])
        for (const v of args.slice(1)) l.unshift(String(v))
        return l.length
      }
      case 'LTRIM': {
        const l = asList(args[0])
        db.set(args[0], l.slice(Number(args[1]), Number(args[2]) + 1))
        return 'OK'
      }
      case 'LRANGE': {
        const l = asList(args[0])
        const stop = Number(args[2])
        return l.slice(Number(args[1]), stop < 0 ? undefined : stop + 1)
      }

      // Exact stand-in for HyperLogLog.
      case 'PFADD': {
        const s = asSet(args[0])
        let added = 0
        for (const m of args.slice(1)) if (!s.has(String(m))) { s.add(String(m)); added = 1 }
        return added
      }
      case 'PFCOUNT':
        return asSet(args[0]).size

      case 'INCRBY': {
        const next = Number(db.get(args[0]) || 0) + Number(args[1])
        db.set(args[0], next)
        return next
      }
      case 'GET':
        return db.get(args[0]) ?? null
      case 'SET':
        db.set(args[0], String(args[1]))
        return 'OK'
      case 'EXPIRE':
        return 1
      case 'DEL': {
        let n = 0
        for (const k of args) if (db.delete(k)) n++
        return n
      }
      default:
        throw new Error(`fake-kv: unsupported command ${op}`)
    }
  }

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      let parsed
      try {
        parsed = JSON.parse(body || '[]')
      } catch {
        res.statusCode = 400
        return res.end(JSON.stringify({ error: 'bad json' }))
      }
      try {
        if (req.url.endsWith('/pipeline')) {
          const results = parsed.map((cmd) => {
            try {
              return { result: run(cmd) }
            } catch (e) {
              return { error: e.message }
            }
          })
          return res.end(JSON.stringify(results))
        }
        return res.end(JSON.stringify({ result: run(parsed) }))
      } catch (e) {
        return res.end(JSON.stringify({ error: e.message }))
      }
    })
  })

  return {
    db,
    async listen() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r))
      return `http://127.0.0.1:${server.address().port}`
    },
    close: () => new Promise((r) => server.close(r)),
    /** Commands the real store issued, useful for asserting round-trip counts. */
    keys: () => [...db.keys()],
  }
}
