import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Integration tests for the paths where a bug is expensive: who can read whose
 * links, who can reach the admin surface, what a guest token does and does not
 * unlock, and whether a disabled or blocked link still redirects.
 *
 * Env has to be set before server.js is imported, so everything loads inside
 * before().
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), 'ashrt-test-'))
process.env.ASHRT_DATA_DIR = DATA_DIR
process.env.SESSION_SECRET = 'test-secret-for-suite-only-0123456789'
process.env.BASE_URL = 'http://localhost:4999'
process.env.ADMIN_EMAILS = 'boss@ashrt.link'

let request, app, store, users, ratelimit, abuse

before(async () => {
  request = (await import('supertest')).default
  app = (await import('../server.js')).default
  ;({ store, users } = await import('../store.js'))
  ratelimit = await import('../lib/ratelimit.js')
  abuse = await import('../lib/abuse.js')
})

after(() => rmSync(DATA_DIR, { recursive: true, force: true }))

// Rate-limit counters live in module memory; clear them so one test's spend
// does not fail the next.
beforeEach(() => {
  ratelimit._resetMemory()
  abuse._clearCache()
})

/* -------------------------------- helpers -------------------------------- */

let seq = 0
async function signup(overrides = {}) {
  const email = overrides.email || `user${++seq}@example.com`
  const res = await request(app)
    .post('/auth/register')
    .send({ email, password: 'a-good-password', name: 'Test', ...overrides })
  assert.equal(res.status, 200, `signup failed: ${JSON.stringify(res.body)}`)
  return { email, cookie: res.headers['set-cookie'], user: res.body.user }
}

const createAs = (cookie, body) =>
  request(app).post('/api/links').set('Cookie', cookie).send(body)

/**
 * The bootstrap admin, created once and logged in thereafter. ADMIN_EMAILS
 * grants the role server-side on first sign-in.
 */
let bossMade = false
async function asBoss() {
  const creds = { email: 'boss@ashrt.link', password: 'a-good-password' }
  if (!bossMade) {
    bossMade = true
    return signup(creds)
  }
  const res = await request(app).post('/auth/login').send(creds)
  assert.equal(res.status, 200, `boss login failed: ${JSON.stringify(res.body)}`)
  return { email: creds.email, cookie: res.headers['set-cookie'], user: res.body.user }
}

/* -------------------------------- guests ---------------------------------- */

test('a guest can create a trackable link without an account', async () => {
  const res = await request(app).post('/api/links').send({ url: 'example.com/guest' })
  assert.equal(res.status, 200)
  assert.match(res.body.slug, /^[A-Za-z0-9_-]+$/)
  assert.ok(res.body.manageToken, 'guest gets a management token')
  assert.ok(res.body.expiresAt, 'guest links expire')
  assert.equal(res.body.guest, true)
})

test('guest analytics need the token, not the short code', async () => {
  const made = await request(app).post('/api/links').send({ url: 'example.com/secret' })
  const { slug, manageToken } = made.body

  const withToken = await request(app).get('/api/guest/stats').query({ t: manageToken })
  assert.equal(withToken.status, 200)
  assert.equal(withToken.body.slug, slug)

  // Knowing the public short code must not unlock its analytics.
  const withSlug = await request(app).get('/api/guest/stats').query({ t: slug })
  assert.equal(withSlug.status, 404)
})

test('guests cannot claim a custom alias', async () => {
  const res = await request(app).post('/api/links').send({ url: 'example.com/x', alias: 'mybrand' })
  assert.equal(res.status, 401)
  assert.equal(res.body.needsAccount, true)
})

test('signing up claims the guest links you made first', async () => {
  const made = await request(app).post('/api/links').send({ url: 'example.com/claimme' })
  const { cookie } = await signup({ claimTokens: [made.body.manageToken] })

  const mine = await request(app).get('/api/links').set('Cookie', cookie)
  assert.equal(mine.body.links.length, 1)
  assert.equal(mine.body.links[0].slug, made.body.slug)
  assert.equal(mine.body.links[0].guest, false)
  assert.equal(mine.body.links[0].expiresAt, null, 'claimed links stop expiring')
})

/* ------------------------------- validation ------------------------------- */

test('dangerous destinations are refused at the API', async () => {
  for (const url of ['javascript:alert(1)', 'http://127.0.0.1/', 'http://169.254.169.254/']) {
    const res = await request(app).post('/api/links').send({ url })
    assert.equal(res.status, 400, `${url} should be refused`)
  }
})

test('a rejected URL does not spend a guest link', async () => {
  const agent = request.agent(app)
  for (let i = 0; i < 8; i++) await agent.post('/api/links').send({ url: 'javascript:alert(1)' })
  const good = await agent.post('/api/links').send({ url: 'example.com/still-works' })
  assert.equal(good.status, 200)
})

test('reserved names cannot be taken as aliases', async () => {
  const { cookie } = await signup()
  for (const alias of ['admin', 'api', 'dashboard', 'login', 'report']) {
    const res = await createAs(cookie, { url: 'example.com', alias })
    assert.equal(res.status, 409, `${alias} should be reserved`)
  }
})

/* -------------------------------- ownership ------------------------------- */

test('one user cannot read, edit or delete another user\'s link', async () => {
  const alice = await signup()
  const bob = await signup()
  const made = await createAs(alice.cookie, { url: 'example.com/alice' })
  const slug = made.body.slug

  const read = await request(app).get(`/api/links/${slug}/stats`).set('Cookie', bob.cookie)
  assert.equal(read.status, 403)

  const edit = await request(app)
    .patch(`/api/links/${slug}`)
    .set('Cookie', bob.cookie)
    .send({ url: 'https://bob-took-over.com' })
  assert.equal(edit.status, 403)

  const del = await request(app).delete(`/api/links/${slug}`).set('Cookie', bob.cookie)
  assert.equal(del.status, 403)

  // And it is untouched.
  const still = await request(app).get(`/api/links/${slug}/stats`).set('Cookie', alice.cookie)
  assert.equal(still.body.url, 'https://example.com/alice')
})

test('link analytics require a session', async () => {
  const alice = await signup()
  const made = await createAs(alice.cookie, { url: 'example.com/private' })
  const res = await request(app).get(`/api/links/${made.body.slug}/stats`)
  assert.equal(res.status, 401)
})

/* ------------------------------- API keys --------------------------------- */

test('an API key authenticates, and a revoked key stops working', async () => {
  const { cookie } = await signup()
  const made = await request(app).post('/api/keys').set('Cookie', cookie).send({ name: 'Test' })
  const key = made.body.key
  assert.ok(key)

  const ok = await request(app).post('/api/links').set('x-api-key', key).send({ url: 'example.com/api' })
  assert.equal(ok.status, 200)

  await request(app).delete(`/api/keys/${made.body.created.id}`).set('Cookie', cookie)

  const stale = await request(app).post('/api/links').set('x-api-key', key).send({ url: 'example.com/nope' })
  assert.equal(stale.status, 401, 'the old key must stop working, not fall back to anonymous')

  const replacement = (await request(app).post('/api/keys').set('Cookie', cookie).send({ name: 'New' })).body.key
  const fresh = await request(app).post('/api/links').set('x-api-key', replacement).send({ url: 'example.com/yes' })
  assert.equal(fresh.status, 200)
})

test('a bad API key is not authenticated', async () => {
  const res = await request(app).get('/api/account').set('x-api-key', 'ak_not-a-real-key')
  assert.equal(res.status, 401)
})

/* --------------------------------- admin ---------------------------------- */

test('admin routes are invisible to normal users and to anonymous callers', async () => {
  const { cookie } = await signup()
  assert.equal((await request(app).get('/api/admin/overview')).status, 401)
  assert.equal((await request(app).get('/api/admin/overview').set('Cookie', cookie)).status, 404)
  assert.equal((await request(app).get('/api/admin/links').set('Cookie', cookie)).status, 404)
})

test('a user cannot promote themselves to admin', async () => {
  const { cookie } = await signup()
  await request(app).patch('/api/account').set('Cookie', cookie).send({ role: 'admin', name: 'x' })
  const me = await request(app).get('/auth/me').set('Cookie', cookie)
  assert.equal(me.body.user.role, 'user')
  assert.equal((await request(app).get('/api/admin/overview').set('Cookie', cookie)).status, 404)
})

test('the bootstrap admin can reach the admin API and disable a link', async () => {
  const boss = await asBoss()
  assert.equal(boss.user.role, 'admin')

  const victim = await signup()
  const made = await createAs(victim.cookie, { url: 'example.com/spammy' })
  const slug = made.body.slug

  const overview = await request(app).get('/api/admin/overview').set('Cookie', boss.cookie)
  assert.equal(overview.status, 200)
  assert.ok(overview.body.users.total >= 2)

  const disabled = await request(app)
    .patch(`/api/admin/links/${slug}`)
    .set('Cookie', boss.cookie)
    .send({ action: 'disable', reason: 'phishing' })
  assert.equal(disabled.status, 200)
  assert.equal(disabled.body.status, 'disabled')

  // The redirect must stop working immediately.
  const hit = await request(app).get(`/${slug}`).set('User-Agent', 'Mozilla/5.0 Chrome/120')
  assert.equal(hit.status, 410)

  // And the owner cannot simply switch it back on.
  const reenable = await request(app)
    .patch(`/api/links/${slug}`)
    .set('Cookie', victim.cookie)
    .send({ status: 'active' })
  assert.equal(reenable.status, 200)
  const after = await request(app).get(`/${slug}`).set('User-Agent', 'Mozilla/5.0 Chrome/120')
  assert.equal(after.status, 410, 'an admin disable outranks the owner')
})

test('admin actions are written to the audit log', async () => {
  const boss = await asBoss()
  const owner = await signup()
  const made = await createAs(owner.cookie, { url: 'example.com/audited' })
  await request(app)
    .patch(`/api/admin/links/${made.body.slug}`)
    .set('Cookie', boss.cookie)
    .send({ action: 'disable', reason: 'test' })

  const log = await abuse.auditLog({ limit: 50 })
  const entry = log.entries.find((e) => e.targetId === made.body.slug && e.action === 'link.disable')
  assert.ok(entry, 'the disable should be recorded')
  assert.equal(entry.actorEmail, 'boss@ashrt.link')
})

/* --------------------------------- redirect ------------------------------- */

test('a redirect records a human click and forwards', async () => {
  const made = await request(app).post('/api/links').send({ url: 'example.com/go' })
  const res = await request(app).get(`/${made.body.slug}`).set('User-Agent', 'Mozilla/5.0 Chrome/120 Safari/537.36')
  assert.equal(res.status, 302)
  assert.equal(res.headers.location, 'https://example.com/go')

  const stats = await request(app).get('/api/guest/stats').query({ t: made.body.manageToken })
  assert.equal(stats.body.clicks, 1)
  assert.equal(stats.body.botClicks, 0)
})

test('link-preview bots are counted separately from people', async () => {
  const made = await request(app).post('/api/links').send({ url: 'example.com/shared' })
  const slug = made.body.slug
  for (const ua of ['Slackbot-LinkExpanding 1.0', 'Twitterbot/1.0', 'facebookexternalhit/1.1', 'Discordbot/2.0']) {
    await request(app).get(`/${slug}`).set('User-Agent', ua)
  }
  await request(app).get(`/${slug}`).set('User-Agent', 'Mozilla/5.0 Chrome/120 Safari/537.36')

  const stats = await request(app).get('/api/guest/stats').query({ t: made.body.manageToken })
  assert.equal(stats.body.clicks, 1, 'one real person')
  assert.equal(stats.body.botClicks, 4, 'four preview fetches')
})

test('an unknown short code 404s', async () => {
  const res = await request(app).get('/definitelynotreal')
  assert.equal(res.status, 404)
})

test('blocking a domain kills links that already point at it', async () => {
  const made = await request(app).post('/api/links').send({ url: 'later-blocked.com/page' })
  const slug = made.body.slug

  const before = await request(app).get(`/${slug}`).set('User-Agent', 'Mozilla/5.0 Chrome/120')
  assert.equal(before.status, 302)

  await abuse.blockDomain('later-blocked.com', { reason: 'test' })
  abuse._clearCache()

  const after = await request(app).get(`/${slug}`).set('User-Agent', 'Mozilla/5.0 Chrome/120')
  assert.equal(after.status, 410, 'an existing link must stop redirecting once blocked')

  // And a new link to it cannot be created either.
  const blocked = await request(app).post('/api/links').send({ url: 'later-blocked.com/other' })
  assert.equal(blocked.status, 400)
})

test('an expired guest link stops redirecting', async () => {
  const made = await request(app).post('/api/links').send({ url: 'example.com/expiring' })
  const link = await store.get(made.body.slug)
  link.expiresAt = Date.now() - 1000
  await store.add(link)

  const res = await request(app).get(`/${made.body.slug}`).set('User-Agent', 'Mozilla/5.0 Chrome/120')
  assert.equal(res.status, 410)
})

/* --------------------------------- reports -------------------------------- */

test('reports flag a link once enough distinct people complain', async () => {
  const made = await request(app).post('/api/links').send({ url: 'example.com/reported' })
  const slug = made.body.slug

  for (const ip of ['203.0.113.10', '203.0.113.11', '203.0.113.12']) {
    const res = await request(app)
      .post('/api/report')
      .set('X-Forwarded-For', ip)
      .send({ link: slug, reason: 'phishing', detail: 'looks fake' })
    assert.equal(res.status, 200)
  }

  const link = await store.get(slug)
  assert.equal(link.status, 'flagged')

  // Flagged means a warning page, not a silent forward and not a takedown.
  const res = await request(app).get(`/${slug}`).set('User-Agent', 'Mozilla/5.0 Chrome/120')
  assert.equal(res.status, 200)
  assert.match(res.text, /Hold on/)
})

test('one person reporting repeatedly does not flag a link', async () => {
  const made = await request(app).post('/api/links').send({ url: 'example.com/singlereporter' })
  const slug = made.body.slug
  for (let i = 0; i < 4; i++) {
    await request(app).post('/api/report').set('X-Forwarded-For', '198.51.100.7').send({ link: slug, reason: 'spam' })
  }
  const link = await store.get(slug)
  assert.equal(link.status, 'active', 'a single reporter must not be able to flag a link')
})

test('reporting a link that does not exist is refused', async () => {
  const res = await request(app).post('/api/report').send({ link: 'nosuchcode', reason: 'spam' })
  assert.equal(res.status, 404)
})

/* ------------------------------ entitlements ------------------------------ */

test('suspicious destinations are auto-flagged but still resolvable', async () => {
  const res = await request(app)
    .post('/api/links')
    .send({ url: 'https://paypal-secure-login.verify-account.ngrok.io/signin' })
  assert.equal(res.status, 200)
  assert.equal(res.body.status, 'flagged')
})

test('a suspended account cannot authenticate', async () => {
  const { cookie, user } = await signup()
  const record = await users.getById(user.id)
  record.status = 'suspended'
  await users.update(record)

  assert.equal((await request(app).get('/auth/me').set('Cookie', cookie)).status, 401)
  assert.equal((await request(app).get('/api/links').set('Cookie', cookie)).status, 401)
})

/* ---------------------------------- CSRF ---------------------------------- */

test('a cross-site write with a session cookie is refused', async () => {
  const { cookie } = await signup()
  const res = await request(app)
    .post('/api/links')
    .set('Cookie', cookie)
    .set('Origin', 'https://attacker.example')
    .send({ url: 'example.com/csrf' })
  assert.equal(res.status, 403)
})

test('a same-origin write is allowed', async () => {
  const { cookie } = await signup()
  const res = await request(app)
    .post('/api/links')
    .set('Cookie', cookie)
    .set('Origin', 'http://localhost:4999')
    .send({ url: 'example.com/same-origin' })
  assert.equal(res.status, 200)
})

/* ------------------------------ noindex + pages --------------------------- */

test('private surfaces are served noindex', async () => {
  for (const path of ['/dashboard', '/admin', '/track', '/api/health', '/login']) {
    const res = await request(app).get(path)
    assert.match(
      res.headers['x-robots-tag'] || '',
      /noindex/,
      `${path} must not be indexable`,
    )
  }
})

test('public pages stay indexable', async () => {
  for (const path of ['/', '/report', '/privacy', '/terms']) {
    const res = await request(app).get(path)
    assert.equal(res.headers['x-robots-tag'], undefined, `${path} should be indexable`)
  }
})

test('the guest tracking page does not leak its token in a referrer', async () => {
  const res = await request(app).get('/track')
  assert.equal(res.headers['referrer-policy'], 'no-referrer')
})

test('robots.txt keeps crawlers out of the app and the admin', async () => {
  const res = await request(app).get('/robots.txt')
  assert.equal(res.status, 200)
  for (const path of ['/dashboard', '/admin', '/api/', '/track']) {
    assert.match(res.text, new RegExp(`Disallow: ${path.replace('/', '\\/')}`), `${path} should be disallowed`)
  }
})

test('a guest can render a QR for our own short link but not for anything else', async () => {
  const made = await request(app).post('/api/links').send({ url: 'example.com/qr' })
  const ours = await request(app).get('/api/qr').query({ data: made.body.shortUrl, format: 'svg' })
  assert.equal(ours.status, 200)
  assert.match(ours.headers['content-type'], /svg/)

  const notOurs = await request(app).get('/api/qr').query({ data: 'https://someone-elses-site.com/page' })
  assert.equal(notOurs.status, 401, 'the QR endpoint is not a free QR API')
})

/* ---------------------------------- SEO ----------------------------------- */

test('the sitemap lists public pages and no private ones', async () => {
  const res = await request(app).get('/sitemap.xml')
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /xml/)
  assert.match(res.text, /<loc>http:\/\/localhost:4999\/<\/loc>/)

  for (const secret of ['/dashboard', '/admin', '/track', '/api', '/login', '/signup']) {
    assert.ok(!res.text.includes(`<loc>http://localhost:4999${secret}`), `${secret} must not be in the sitemap`)
  }
})

test('the sitemap does not advertise a page that does not exist', async () => {
  const res = await request(app).get('/sitemap.xml')
  // Take the whole <loc> and strip the origin; a naive regex captures from the
  // "//" in "http://" instead.
  const paths = [...res.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname)
  for (const p of paths) {
    if (p === '/') continue
    const page = await request(app).get(p)
    assert.equal(page.status, 200, `${p} is in the sitemap but returns ${page.status}`)
  }
})

/** Every page meant to be found in search. Add a page, add it here. */
const PUBLIC_PAGES = [
  '/',
  '/pricing',
  '/utm-link-tracker',
  '/qr-code-tracking',
  '/qr-code-generator',
  '/bitly-alternative',
]

test('public pages declare a canonical URL', async () => {
  for (const path of PUBLIC_PAGES) {
    const res = await request(app).get(path)
    assert.equal(res.status, 200, path)
    assert.match(res.text, /<link rel="canonical" href="https:\/\/www\.ashrt\.link/, `${path} needs a canonical`)
  }
})

test('the homepage is titled for the category it targets', async () => {
  const res = await request(app).get('/')
  assert.match(res.text, /<title>Free Link Tracker/i)
  assert.match(res.text, /<h1>Free Link Tracker<\/h1>/i)
  assert.match(res.text, /<meta name="description"/)
  assert.match(res.text, /og:title/)
})

test('structured data on every public page is valid JSON', async () => {
  for (const path of PUBLIC_PAGES) {
    const res = await request(app).get(path)
    const blocks = [...res.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    assert.ok(blocks.length > 0, `${path} should carry structured data`)
    for (const [, json] of blocks) {
      assert.doesNotThrow(() => JSON.parse(json), `${path} has invalid JSON-LD`)
    }
  }
})


test('every public page has a title and description of its own', async () => {
  const titles = new Set()
  const descriptions = new Set()
  for (const path of PUBLIC_PAGES) {
    const res = await request(app).get(path)
    assert.equal(res.status, 200, path)
    const title = res.text.match(/<title>([^<]+)<\/title>/)?.[1]
    const desc = res.text.match(/<meta name="description" content="([^"]+)"/)?.[1]
    assert.ok(title, `${path} needs a title`)
    assert.ok(desc && desc.length > 60, `${path} needs a real description`)
    // Duplicate titles are the signature of thin keyword-swapped pages.
    assert.ok(!titles.has(title), `${path} shares its title with another page`)
    assert.ok(!descriptions.has(desc), `${path} shares its description with another page`)
    titles.add(title)
    descriptions.add(desc)
  }
})

test('every public page links to at least two others', async () => {
  // A page nothing links to and that links nowhere is an orphan, and it is how
  // a set of landing pages ends up reading as a doorway farm.
  for (const path of PUBLIC_PAGES) {
    const res = await request(app).get(path)
    const internal = new Set(
      [...res.text.matchAll(/href="(\/[a-z0-9-]*)"/g)].map((m) => m[1]).filter((p) => p !== path),
    )
    assert.ok(internal.size >= 2, `${path} only links to ${internal.size} other page(s)`)
  }
})

test('the comparison page dates its competitor figures', async () => {
  // Competitor pricing changes. A comparison with no date on it becomes a false
  // claim on its own, without anybody editing it.
  const res = await request(app).get('/bitly-alternative')
  assert.match(res.text, /checked on\s*<b>\d{1,2} \w+ \d{4}<\/b>/)
})

test('landing pages embed the working tool, not a picture of one', async () => {
  // Pricing is the exception: it is a page about the product, not a tool page.
  for (const path of ['/utm-link-tracker', '/qr-code-tracking', '/qr-code-generator', '/bitly-alternative']) {
    const res = await request(app).get(path)
    assert.match(res.text, /id="create-form"/, `${path} should have the real form`)
    assert.match(res.text, /src="\/landing\.js"/, `${path} should load the tool script`)
  }
})

/* ---------------------------- custom domains ------------------------------ */

test('the plan allowance is spent by creating links, not by keeping them', async () => {
  const { PLANS } = await import('../lib/plans.js')
  const real = PLANS.free.limits.linksPerMonth
  PLANS.free.limits.linksPerMonth = 2
  try {
    const { cookie } = await signup()
    assert.equal((await createAs(cookie, { url: 'example.com/one' })).status, 200)
    assert.equal((await createAs(cookie, { url: 'example.com/two' })).status, 200)

    const third = await createAs(cookie, { url: 'example.com/three' })
    assert.equal(third.status, 402, 'out of allowance is an upgrade prompt, not a rate limit')
    assert.equal(third.body.needsUpgrade, true)
    assert.match(third.body.error, /last 30 days/)
    assert.ok(third.body.resetAt > Date.now(), 'and it says when it resets')

    // Deleting a link does not buy allowance back. The allowance is for
    // creating; what matters is that the two links already made still work.
    const mine = await request(app).get('/api/links').set('Cookie', cookie)
    assert.equal(mine.body.links.length, 2)
    await request(app).delete(`/api/links/${mine.body.links[0].slug}`).set('Cookie', cookie)
    assert.equal((await createAs(cookie, { url: 'example.com/four' })).status, 402)
  } finally {
    PLANS.free.limits.linksPerMonth = real
  }
})

test('a bad URL does not cost any allowance', async () => {
  const { PLANS } = await import('../lib/plans.js')
  const real = PLANS.free.limits.linksPerMonth
  PLANS.free.limits.linksPerMonth = 2
  try {
    const { cookie } = await signup()
    for (const bad of ['not a url', 'http://127.0.0.1/x', 'javascript:alert(1)']) {
      assert.equal((await createAs(cookie, { url: bad })).status, 400)
    }
    assert.equal((await createAs(cookie, { url: 'example.com/still-works' })).status, 200)
    assert.equal((await createAs(cookie, { url: 'example.com/second' })).status, 200)
  } finally {
    PLANS.free.limits.linksPerMonth = real
  }
})

test('a free account is told to upgrade, not that the feature is broken', async () => {
  const { cookie } = await signup()
  const status = await request(app).get('/api/domains').set('Cookie', cookie)
  assert.equal(status.body.available, true, 'the feature ships on')
  assert.equal(status.body.entitled, false, 'but not on this plan')

  const add = await request(app)
    .post('/api/domains')
    .set('Cookie', cookie)
    .send({ domain: 'links.example.com' })
  assert.equal(add.status, 402)
  assert.equal(add.body.needsUpgrade, true)
})

test('links are minted on the canonical host when an account has no domain', async () => {
  const { cookie } = await signup()
  const made = await createAs(cookie, { url: 'example.com/branded' })
  assert.match(made.body.shortUrl, /^http:\/\/localhost:4999\//)
})

/* -------------------------- dashboard data shape -------------------------- */

test('the dashboard summary carries what its KPIs need', async () => {
  const { cookie } = await signup()
  await createAs(cookie, { url: 'example.com/kpi' })

  const res = await request(app).get('/api/stats').set('Cookie', cookie)
  assert.equal(res.status, 200)
  assert.equal(typeof res.body.totalCampaigns, 'number', 'campaigns KPI was hardcoded to 0 before')
  assert.equal(typeof res.body.linksSeries, 'object', 'needed for an honest links delta')
  assert.equal(typeof res.body.totalBotClicks, 'number')

  const day = new Date().toISOString().slice(0, 10)
  assert.equal(res.body.linksSeries[day], 1, 'today should show one link created')
})

test('UTM parameters are applied to the destination', async () => {
  const { cookie } = await signup()
  const res = await createAs(cookie, {
    url: 'https://example.com/page?existing=1',
    utm: { utm_source: 'newsletter', utm_medium: 'email' },
  })
  assert.equal(res.status, 200)
  const u = new URL(res.body.url)
  assert.equal(u.searchParams.get('existing'), '1', 'existing query survives')
  assert.equal(u.searchParams.get('utm_source'), 'newsletter')
  assert.equal(u.searchParams.get('utm_medium'), 'email')
})

test('a new public page automatically reserves its own alias', async () => {
  // RESERVED is derived from the contents of public/, so adding a landing page
  // cannot leave a window where someone claims that alias and the page then
  // silently shadows their working link.
  const { cookie } = await signup()
  for (const alias of ['utm-link-tracker', 'qr-code-tracking']) {
    const res = await createAs(cookie, { url: 'example.com', alias })
    assert.equal(res.status, 409, `${alias} should be reserved`)
  }

  // Dotted names are refused earlier, by the alias format rule, so they can
  // never collide with a served file no matter what is in public/.
  for (const alias of ['sitemap.xml', 'robots.txt', 'favicon.svg']) {
    const res = await createAs(cookie, { url: 'example.com', alias })
    assert.equal(res.status, 400, `${alias} should be rejected as a malformed alias`)
  }
})
