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

  /**
   * Redis index ranges, including the negative ones.
   *
   * -1 means the last element, not "before the start", so `0 -1` is the whole
   * range rather than the empty one a naive slice would produce.
   */
  const sliceRange = (arr, rawStart, rawStop) => {
    const n = arr.length
    let start = Number(rawStart)
    let stop = Number(rawStop)
    if (start < 0) start = Math.max(n + start, 0)
    if (stop < 0) stop = n + stop
    if (stop >= n) stop = n - 1
    if (start > stop || start >= n) return []
    return arr.slice(start, stop + 1)
  }

  /**
   * Failure injection.
   *
   * Real KV goes down mid-write, and the store is supposed to notice instead of
   * swallowing it, so a test needs a way to make chosen commands fail.
   */
  let failCheck = null

  function run(cmd) {
    const [rawOp, ...args] = cmd
    const op = String(rawOp).toUpperCase()

    if (failCheck && failCheck(cmd)) throw new Error(`fake-kv: injected failure on ${op}`)

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
      case 'HEXISTS':
        return asHash(args[0]).has(String(args[1])) ? 1 : 0
      case 'HKEYS':
        return [...asHash(args[0]).keys()]
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
      case 'ZRANGE':
      case 'ZREVRANGE': {
        const z = asZset(args[0])
        // Redis orders ties by member, not by insertion, and ZRANGE REV is the
        // modern spelling of ZREVRANGE. Both matter here: the doctor reads the
        // whole recency index with ZRANGE key 0 -1, and a stand-in that only
        // knew ZREVRANGE would fail the repair path for a reason production
        // would never hit.
        const rev = op === 'ZREVRANGE' || args.slice(3).some((a) => String(a).toUpperCase() === 'REV')
        const withScores = args
          .slice(3)
          .some((a) => String(a).toUpperCase() === 'WITHSCORES')
        const entries = [...z.entries()].sort((a, b) =>
          a[1] === b[1] ? (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) : a[1] - b[1],
        )
        if (rev) entries.reverse()
        const picked = sliceRange(entries, args[1], args[2])
        return withScores ? picked.flatMap(([m, sc]) => [m, String(sc)]) : picked.map(([m]) => m)
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
    /** Make every command matching `fn` fail. Pass null to stop. */
    failWhen: (fn) => {
      failCheck = fn
    },
    /** Commands the real store issued, useful for asserting round-trip counts. */
    keys: () => [...db.keys()],
  }
}
