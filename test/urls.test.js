import test from 'node:test'
import assert from 'node:assert/strict'
import { validateUrl, checkStored, applyUtm, hostMatches, registrableDomain } from '../lib/urls.js'

const opts = { blocked: ['evil.com', 'spam.example.org'], selfHost: 'ashrt.link' }

/**
 * These are the cases that matter: everything a shortener gets pointed at by
 * someone who is not a customer.
 */
const ACCEPTED = [
  'example.com',
  'https://example.com/a/b?c=1#frag',
  'HTTP://ExAmPlE.com/Path',
  'example.com:8080/x',
  'https://example.com:8443/x',
  'http://xn--r8jz45g.jp/',
  'sub.example.co.uk/p',
  'notevil.com/x',
  'http://8.8.8.8/',
  'http://[2606:4700:4700::1111]/',
  'https://example.com/' + 'a'.repeat(1000),
]

const REFUSED = {
  bad_scheme: ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'file:///etc/passwd', 'ftp://example.com', 'mailto:a@b.com', 'vbscript:msgbox(1)'],
  private_ip: [
    'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://127.1/',
    'http://169.254.169.254/latest/meta-data/', 'http://192.168.1.1', 'http://10.0.0.5/admin',
    'http://172.16.4.1', 'http://100.64.0.1', 'http://0.0.0.0',
    'http://[::1]/', 'http://[fe80::1]/', 'http://[fc00::1]/', 'http://[fd12:3456::1]/',
    'http://[::ffff:127.0.0.1]/', 'http://[::ffff:192.168.0.1]/', 'http://[64:ff9b::127.0.0.1]/',
    'http://[::]/', 'http://[ff02::1]/', '192.168.1.1:8080/admin',
  ],
  internal_host: ['http://router/', 'http://printer.local/', 'http://db.internal/', 'http://box.lan/', 'http://localhost:6379'],
  bad_port: ['http://example.com:22/', 'http://example.com:3306/', 'http://example.com:6379/'],
  credentials: ['http://user:pass@elsewhere.com/'],
  blocked_domain: ['http://evil.com/x', 'http://www.evil.com/x', 'http://a.b.evil.com/x'],
  self_link: ['https://ashrt.link/abc', 'https://www.ashrt.link/abc'],
  control_chars: ['https://example.com/\r\nSet-Cookie: x=1', 'https://exa mple.com/'],
  too_long: ['https://' + 'a'.repeat(3000) + '.com'],
  empty: ['', '   '],
}

test('accepts ordinary destinations', () => {
  for (const url of ACCEPTED) {
    const r = validateUrl(url, opts)
    assert.equal(r.ok, true, `should accept ${url}: ${r.error}`)
  }
})

test('refuses dangerous destinations with the right reason', () => {
  for (const [reason, urls] of Object.entries(REFUSED)) {
    for (const url of urls) {
      const r = validateUrl(url, opts)
      assert.equal(r.ok, false, `should refuse ${url}`)
      assert.equal(r.reason, reason, `${url} should fail as ${reason}, got ${r.reason}`)
    }
  }
})

test('localhost:6379 is not mistaken for a scheme', () => {
  // The bug this guards: a naive scheme regex reads "example.com:" as a scheme.
  assert.equal(validateUrl('example.com:8080/x', opts).ok, true)
  assert.equal(validateUrl('example.com:443', opts).ok, true)
})

test('canonicalizes what it accepts', () => {
  assert.equal(validateUrl('EXAMPLE.com/Path', opts).url, 'https://example.com/Path')
  assert.equal(validateUrl('example.com', opts).url, 'https://example.com/')
})

test('blocklist matches subdomains but not lookalikes', () => {
  assert.equal(hostMatches('evil.com', 'evil.com'), true)
  assert.equal(hostMatches('a.b.evil.com', 'evil.com'), true)
  assert.equal(hostMatches('notevil.com', 'evil.com'), false)
  assert.equal(hostMatches('evil.com.co', 'evil.com'), false)
})

test('registrable domain handles multi-part TLDs', () => {
  assert.equal(registrableDomain('a.b.example.co.uk'), 'example.co.uk')
  assert.equal(registrableDomain('x.y.z.foo.com'), 'foo.com')
  assert.equal(registrableDomain('example.com'), 'example.com')
})

test('checkStored enforces blocks applied after creation', () => {
  const before = checkStored('https://evil.com/page', { blocked: [] })
  assert.equal(before.ok, true)
  const after = checkStored('https://evil.com/page', { blocked: ['evil.com'] })
  assert.equal(after.ok, false)
  assert.equal(after.reason, 'blocked_domain')
})

test('checkStored refuses a non-http destination even if stored', () => {
  // Defence in depth: if a bad row ever reaches the database, the redirect
  // still refuses to serve it.
  assert.equal(checkStored('javascript:alert(1)', {}).ok, false)
})

test('applyUtm adds params without dropping existing ones', () => {
  const out = applyUtm('https://example.com/p?existing=1', { source: 'newsletter', utm_medium: 'email' })
  const u = new URL(out)
  assert.equal(u.searchParams.get('existing'), '1')
  assert.equal(u.searchParams.get('utm_source'), 'newsletter')
  assert.equal(u.searchParams.get('utm_medium'), 'email')
  assert.equal(u.searchParams.get('utm_campaign'), null)
})
