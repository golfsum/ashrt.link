/**
 * Destination URL validation: the one place that decides whether a URL is safe
 * to store and safe to redirect to.
 *
 * Two entry points, and both matter:
 *   - validateUrl()  at creation time, so bad destinations never get stored
 *   - checkStored()  at redirect time, so a domain blocked *after* a link was
 *                    created stops working immediately
 *
 * We lean on the WHATWG URL parser, which canonicalizes the obfuscation tricks
 * for us: http://2130706433/, http://0x7f000001/ and http://127.1/ all parse to
 * hostname 127.0.0.1 before we ever look at them.
 */

const MAX_URL_LENGTH = 2048

/** Only these schemes ever reach a redirect. Everything else is refused. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * Ports that belong to infrastructure, not websites. Blocked so a short link
 * can't be used to probe or pivot into internal services.
 */
const BLOCKED_PORTS = new Set([
  22, 23, 25, 110, 143, 445, 465, 587, 993, 995,
  1433, 2375, 2376, 3306, 3389, 5432, 5900, 6379,
  9200, 9300, 11211, 27017, 27018,
])

/** Hostnames and suffixes that only ever resolve inside a private network. */
const INTERNAL_SUFFIXES = [
  'localhost', '.localhost',
  '.local', '.internal', '.intranet', '.lan', '.home', '.home.arpa',
  '.corp', '.private', '.localdomain',
]

/**
 * A small, deliberately incomplete public-suffix table. Enough to group
 * destinations by registrable domain for reporting and blocklist matching.
 * Not a security boundary: blocklist matching is suffix-based on the full host.
 */
const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'co.jp', 'or.jp', 'ne.jp',
  'com.au', 'net.au', 'org.au', 'com.br', 'com.cn', 'com.mx', 'com.tr',
  'co.nz', 'co.za', 'co.in', 'co.kr', 'com.sg', 'com.hk', 'com.tw',
])

/* ------------------------------- IP checks -------------------------------- */

function parseIpv4(host) {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const nums = []
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    nums.push(n)
  }
  return nums
}

/** True for loopback, private, link-local, CGNAT, multicast and reserved space. */
function isPrivateIpv4(nums) {
  const [a, b] = nums
  if (a === 0) return true                              // 0.0.0.0/8
  if (a === 10) return true                             // private
  if (a === 127) return true                            // loopback
  if (a === 169 && b === 254) return true               // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true      // private
  if (a === 192 && b === 168) return true               // private
  if (a === 100 && b >= 64 && b <= 127) return true     // CGNAT
  if (a === 192 && b === 0) return true                 // 192.0.0/24 + TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true  // benchmarking
  if (a === 198 && b === 51) return true                // TEST-NET-2
  if (a === 203 && b === 0) return true                 // TEST-NET-3
  if (a >= 224) return true                             // multicast + reserved + broadcast
  return false
}

/**
 * Expand an IPv6 address to its 8 numeric hextets, or null if it isn't one.
 * Handles "::" compression and a trailing dotted-quad (::ffff:127.0.0.1).
 */
function expandIpv6(raw) {
  let text = raw
  const tail = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (tail) {
    const quad = parseIpv4(tail[1])
    if (!quad) return null
    const hi = ((quad[0] << 8) | quad[1]).toString(16)
    const lo = ((quad[2] << 8) | quad[3]).toString(16)
    text = text.slice(0, -tail[1].length) + hi + ':' + lo
  }

  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const back = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null

  let groups
  if (back === null) {
    groups = head
    if (groups.length !== 8) return null
  } else {
    const gap = 8 - head.length - back.length
    if (gap < 0) return null
    groups = [...head, ...Array(gap).fill('0'), ...back]
  }

  const out = []
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    out.push(parseInt(g, 16))
  }
  return out.length === 8 ? out : null
}

/** Hostname arrives bracketed from the URL parser: [::1] */
function isPrivateIpv6(host) {
  const raw = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (!raw.includes(':')) return false

  const h = expandIpv6(raw)
  if (!h) return true // unparseable but colon-bearing: refuse rather than guess

  const allZeroHigh = h.slice(0, 5).every((x) => x === 0)
  if (allZeroHigh && h[5] === 0 && h[6] === 0 && (h[7] === 0 || h[7] === 1)) return true // :: and ::1

  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) carry a v4 address in
  // the last two hextets. Judge those by the IPv4 rules.
  const mapped = (allZeroHigh && h[5] === 0xffff) || (h[0] === 0x64 && h[1] === 0xff9b)
  if (mapped) {
    const quad = [h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff]
    if (isPrivateIpv4(quad)) return true
  }

  if ((h[0] & 0xfe00) === 0xfc00) return true // fc00::/7  unique-local
  if ((h[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((h[0] & 0xff00) === 0xff00) return true // ff00::/8  multicast
  return false
}

/* ------------------------------ host helpers ------------------------------ */

/** Registrable domain, e.g. a.b.example.co.uk -> example.co.uk. Approximate. */
export function registrableDomain(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h || parseIpv4(h) || h.includes(':')) return h
  const parts = h.split('.')
  if (parts.length <= 2) return h
  const lastTwo = parts.slice(-2).join('.')
  if (MULTI_PART_TLDS.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.')
  return lastTwo
}

/**
 * Does `host` fall under `blocked`? Matches the domain itself and any
 * subdomain, and never matches a domain that merely ends with the same text
 * (evil.com must not match notevil.com).
 */
export function hostMatches(host, blocked) {
  const h = String(host || '').toLowerCase()
  const b = String(blocked || '').toLowerCase().replace(/^\*?\./, '')
  if (!h || !b) return false
  return h === b || h.endsWith('.' + b)
}

export function isBlockedHost(host, blockedList = []) {
  return blockedList.some((b) => hostMatches(host, b))
}

/* ------------------------------- validation ------------------------------- */

const fail = (reason, message) => ({ ok: false, reason, error: message })

/**
 * Validate and canonicalize a destination URL.
 *
 * @param {string} input           raw user input
 * @param {object} [opts]
 * @param {string[]} [opts.blocked]  blocked domains (from the abuse store)
 * @param {string}  [opts.selfHost]  our own hostname, to refuse redirect loops
 * @returns {{ok:true,url:string,host:string,domain:string}|{ok:false,reason:string,error:string}}
 */
export function validateUrl(input, { blocked = [], selfHost = '' } = {}) {
  let text = String(input == null ? '' : input).trim()
  if (!text) return fail('empty', 'Give me a URL to track')

  // Control characters (including CR/LF) have no business in a URL and are the
  // raw material for response-splitting, so refuse rather than strip.
  if (/[\u0000-\u0020\u007F]/.test(text)) {
    return fail('control_chars', 'That URL contains invalid characters')
  }
  if (text.length > MAX_URL_LENGTH) {
    return fail('too_long', `URLs are limited to ${MAX_URL_LENGTH} characters`)
  }

  // A bare "example.com/path" is the common case, so assume https. We only do
  // this when there is no scheme at all; a present-but-disallowed scheme like
  // javascript: must be refused, never rewritten into something that parses.
  //
  // "example.com:8080/x" is the trap here: it matches a naive scheme regex.
  // A real scheme is either followed by "//" or has no dot in it, which is what
  // separates "javascript:" and "data:" from a bare host:port.
  const scheme = text.match(/^([a-z][a-z0-9+.-]*):/i)
  const hasScheme =
    Boolean(scheme) && (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || !scheme[1].includes('.'))
  if (!hasScheme) text = 'https://' + text

  let u
  try {
    u = new URL(text)
  } catch {
    return fail('unparseable', 'That does not look like a URL')
  }

  if (!ALLOWED_PROTOCOLS.has(u.protocol)) {
    return fail('bad_scheme', 'Only http and https links can be tracked')
  }
  if (u.username || u.password) {
    return fail('credentials', 'URLs with an embedded username or password are not allowed')
  }

  const host = u.hostname.toLowerCase()
  if (!host) return fail('no_host', 'That URL is missing a domain')

  // Host checks come before the port check: where a URL points is a more
  // fundamental problem than which port it names, and the reason we report
  // should name the real one.
  for (const suffix of INTERNAL_SUFFIXES) {
    if (host === suffix.replace(/^\./, '') || host.endsWith(suffix)) {
      return fail('internal_host', 'Links to internal or local addresses are not allowed')
    }
  }

  const v4 = parseIpv4(host)
  if (v4 && isPrivateIpv4(v4)) {
    return fail('private_ip', 'Links to private or local network addresses are not allowed')
  }
  if (isPrivateIpv6(host)) {
    return fail('private_ip', 'Links to private or local network addresses are not allowed')
  }

  // A hostname with no dot and no IP form is an intranet name (http://router/).
  if (!v4 && !host.includes(':') && !host.includes('.')) {
    return fail('internal_host', 'Enter a full domain, like example.com')
  }

  if (u.port && BLOCKED_PORTS.has(Number(u.port))) {
    return fail('bad_port', 'That port is not allowed')
  }

  if (selfHost && hostMatches(host, selfHost)) {
    return fail('self_link', 'That is already an ashrt.link URL')
  }

  if (isBlockedHost(host, blocked)) {
    return fail('blocked_domain', 'That destination is not allowed on ashrt.link')
  }

  return { ok: true, url: u.href, host, domain: registrableDomain(host) }
}

/**
 * Re-check a URL that is already stored, at redirect time. Cheaper than full
 * validation and its real job is enforcing blocks applied after creation.
 */
export function checkStored(url, { blocked = [] } = {}) {
  let u
  try {
    u = new URL(String(url || ''))
  } catch {
    return fail('unparseable', 'This link points somewhere invalid')
  }
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) {
    return fail('bad_scheme', 'This link points somewhere invalid')
  }
  if (isBlockedHost(u.hostname.toLowerCase(), blocked)) {
    return fail('blocked_domain', 'This link has been disabled')
  }
  return { ok: true, url: u.href, host: u.hostname.toLowerCase() }
}

/**
 * Apply UTM parameters to a destination, preserving anything already there.
 * Only keys the caller passes are written, and blank values are ignored.
 */
export function applyUtm(url, utm = {}) {
  const KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']
  let u
  try {
    u = new URL(url)
  } catch {
    return url
  }
  for (const key of KEYS) {
    const short = key.slice(4)
    const value = String(utm[key] ?? utm[short] ?? '').trim()
    if (value) u.searchParams.set(key, value)
  }
  return u.href
}

export { MAX_URL_LENGTH, BLOCKED_PORTS }
