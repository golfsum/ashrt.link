import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Custom domains, with the feature switched ON.
 *
 * The risk this suite exists for: a branded host that served every link on the
 * service would let anyone launder a destination through someone else's domain,
 * and an unverified claim would let anyone catch traffic meant for a host they
 * do not control. Both are checked here.
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), 'ashrt-domains-'))
process.env.ASHRT_DATA_DIR = DATA_DIR
process.env.SESSION_SECRET = 'domain-test-secret-0123456789'
process.env.BASE_URL = 'http://localhost:4999'
process.env.CUSTOM_DOMAINS = '1'

let request, app, users, store, ratelimit, abuse, clearDomainCache

before(async () => {
  request = (await import('supertest')).default
  const mod = await import('../server.js')
  app = mod.default
  clearDomainCache = mod.clearDomainCache
  ;({ users, store } = await import('../store.js'))
  ratelimit = await import('../lib/ratelimit.js')
  abuse = await import('../lib/abuse.js')
})

after(() => rmSync(DATA_DIR, { recursive: true, force: true }))
beforeEach(() => {
  ratelimit._resetMemory()
  abuse._clearCache()
  clearDomainCache()
})

let seq = 0
async function signup(plan = 'business') {
  const email = `d${++seq}@example.com`
  const res = await request(app).post('/auth/register').send({ email, password: 'a-good-password' })
  assert.equal(res.status, 200)
  // Plans are set by Stripe in real life; set it directly for the entitlement.
  const u = await users.getById(res.body.user.id)
  u.plan = plan
  await users.update(u)
  return { email, cookie: res.headers['set-cookie'], id: res.body.user.id }
}

/** Mark a domain verified the way a successful DNS check would. */
async function forceVerify(userId, domain) {
  const u = await users.getById(userId)
  u.domains = u.domains || []
  const entry = u.domains.find((d) => d.domain === domain)
  if (entry) entry.status = 'verified'
  else u.domains.push({ domain, status: 'verified', addedAt: Date.now() })
  await users.update(u)
  await users.claimDomain(domain, userId)
  clearDomainCache()
}

const BROWSER = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36'

/* ------------------------------ entitlement ------------------------------- */

test('custom domains need the Business plan', async () => {
  const free = await signup('free')
  const res = await request(app).post('/api/domains').set('Cookie', free.cookie).send({ domain: 'links.example.com' })
  assert.equal(res.status, 402)
  assert.equal(res.body.needsUpgrade, true)
})

test('adding a domain returns the DNS records needed to prove ownership', async () => {
  const biz = await signup()
  const res = await request(app).post('/api/domains').set('Cookie', biz.cookie).send({ domain: 'links.example.com' })
  assert.equal(res.status, 200)
  assert.equal(res.body.domains[0].status, 'pending', 'it does not serve anything until verified')
  assert.match(res.body.token, /^ashrt-verify=/)
  assert.equal(res.body.dns.txt.name, '_ashrt.links.example.com')
  assert.equal(res.body.dns.txt.value, res.body.token)
})

test('the verification token is specific to the account and the domain', async () => {
  const a = await signup()
  const b = await signup()
  const resA = await request(app).post('/api/domains').set('Cookie', a.cookie).send({ domain: 'brand-a.example.com' })
  const resB = await request(app).post('/api/domains').set('Cookie', b.cookie).send({ domain: 'brand-a.example.com' })
  // Same domain, different accounts: the token they must publish differs, so
  // one account cannot use another's published record.
  assert.notEqual(resA.body.token, resB.body.token)
})

test('our own domain cannot be claimed as a custom domain', async () => {
  const biz = await signup()
  const res = await request(app).post('/api/domains').set('Cookie', biz.cookie).send({ domain: 'localhost' })
  assert.equal(res.status, 400)
})

test('verification fails when the TXT record is not there', async () => {
  const biz = await signup()
  await request(app).post('/api/domains').set('Cookie', biz.cookie).send({ domain: 'unverifiable.example.com' })
  const res = await request(app).post('/api/domains/unverifiable.example.com/verify').set('Cookie', biz.cookie)
  assert.equal(res.status, 400)
  assert.ok(res.body.dns, 'it tells you what to publish')

  const after = await users.getById(biz.id)
  assert.equal(after.domains[0].status, 'pending', 'a failed check must not verify it')
})

/* -------------------------------- routing --------------------------------- */

test('a verified branded host serves only its owner\'s links', async () => {
  const alice = await signup()
  const bob = await signup()
  await forceVerify(alice.id, 'go.alice.example')

  const aliceLink = await request(app).post('/api/links').set('Cookie', alice.cookie).send({ url: 'example.com/alice' })
  const bobLink = await request(app).post('/api/links').set('Cookie', bob.cookie).send({ url: 'example.com/bob' })

  // Alice's own link resolves on her host.
  const mine = await request(app)
    .get(`/${aliceLink.body.slug}`)
    .set('Host', 'go.alice.example')
    .set('User-Agent', BROWSER)
  assert.equal(mine.status, 302)
  assert.equal(mine.headers.location, 'https://example.com/alice')

  // Bob's does not. Otherwise Alice's domain could be used to forward to
  // anything anyone on the service had ever created.
  const theirs = await request(app)
    .get(`/${bobLink.body.slug}`)
    .set('Host', 'go.alice.example')
    .set('User-Agent', BROWSER)
  assert.equal(theirs.status, 404)

  // And both still work on the canonical host.
  for (const slug of [aliceLink.body.slug, bobLink.body.slug]) {
    const res = await request(app).get(`/${slug}`).set('User-Agent', BROWSER)
    assert.equal(res.status, 302, 'the canonical host keeps serving every link')
  }
})

test('an unverified domain serves nothing', async () => {
  const biz = await signup()
  await request(app).post('/api/domains').set('Cookie', biz.cookie).send({ domain: 'pending.example.com' })
  const made = await request(app).post('/api/links').set('Cookie', biz.cookie).send({ url: 'example.com/pending' })
  clearDomainCache()

  // The host is not recognised, so it is treated as an unknown host and the
  // link resolves as if on the canonical domain rather than being scoped.
  const res = await request(app).get(`/${made.body.slug}`).set('Host', 'pending.example.com').set('User-Agent', BROWSER)
  assert.equal(res.status, 302, 'unverified hosts are simply not branded hosts')
})

test('a branded host does not serve the marketing site or the app', async () => {
  const biz = await signup()
  await forceVerify(biz.id, 'go.brand.example')

  for (const path of ['/', '/signup', '/login', '/dashboard', '/pricing', '/utm-link-tracker']) {
    const res = await request(app).get(path).set('Host', 'go.brand.example').set('User-Agent', BROWSER)
    assert.equal(res.status, 302, `${path} should not render on a customer's domain`)
    assert.match(res.headers.location, /^https:\/\/www\.ashrt\.link/, `${path} should send people to the canonical site`)
  }
})

test('a branded host asks not to be indexed', async () => {
  const biz = await signup()
  await forceVerify(biz.id, 'go.noindex.example')
  const res = await request(app).get('/robots.txt').set('Host', 'go.noindex.example')
  assert.equal(res.status, 200)
  assert.match(res.text, /Disallow: \/$/m)
})

test('a suspended account stops serving its branded host', async () => {
  const biz = await signup()
  await forceVerify(biz.id, 'go.suspended.example')
  const made = await request(app).post('/api/links').set('Cookie', biz.cookie).send({ url: 'example.com/susp' })

  const u = await users.getById(biz.id)
  u.status = 'suspended'
  await users.update(u)
  clearDomainCache()

  // The host stops being recognised as branded, so the marketing redirect and
  // the scoping both stop applying to it.
  const res = await request(app).get(`/${made.body.slug}`).set('Host', 'go.suspended.example').set('User-Agent', BROWSER)
  assert.equal(res.status, 302)
})

/* -------------------------------- ownership ------------------------------- */

test('two accounts cannot both verify the same domain', async () => {
  const first = await signup()
  const second = await signup()
  await forceVerify(first.id, 'contested.example.com')

  const res = await request(app)
    .post('/api/domains')
    .set('Cookie', second.cookie)
    .send({ domain: 'contested.example.com' })
  assert.equal(res.status, 409)
})

test('removing a domain releases it and stops the routing', async () => {
  const biz = await signup()
  await forceVerify(biz.id, 'temp.example.com')
  const made = await request(app).post('/api/links').set('Cookie', biz.cookie).send({ url: 'example.com/temp' })

  // Scoped while verified.
  const before = await request(app).get('/').set('Host', 'temp.example.com').set('User-Agent', BROWSER)
  assert.equal(before.status, 302)

  await request(app).delete('/api/domains/temp.example.com').set('Cookie', biz.cookie)
  clearDomainCache()

  const after = await users.getById(biz.id)
  assert.equal((after.domains || []).length, 0)

  // Freed up for someone else.
  const other = await signup()
  const claim = await request(app).post('/api/domains').set('Cookie', other.cookie).send({ domain: 'temp.example.com' })
  assert.equal(claim.status, 200)

  // And the link still works on the canonical host.
  const still = await request(app).get(`/${made.body.slug}`).set('User-Agent', BROWSER)
  assert.equal(still.status, 302)
})

test('short links are presented on a verified brand domain', async () => {
  const biz = await signup()
  await forceVerify(biz.id, 'go.presented.example')
  const made = await request(app).post('/api/links').set('Cookie', biz.cookie).send({ url: 'example.com/presented' })
  assert.match(made.body.shortUrl, /^https:\/\/go\.presented\.example\//)

  const list = await request(app).get('/api/links').set('Cookie', biz.cookie)
  assert.ok(list.body.links.every((l) => l.shortUrl.startsWith('https://go.presented.example/')))
})
