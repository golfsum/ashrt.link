import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Funnel instrumentation.
 *
 * Two things are being checked: that the counters actually move when a real
 * thing happens, and that they stay counters — no identifier, no referrer
 * history, nothing that turns an aggregate into a log.
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), 'ashrt-events-'))
process.env.ASHRT_DATA_DIR = DATA_DIR
process.env.SESSION_SECRET = 'events-test-secret-0123456789'
process.env.BASE_URL = 'http://localhost:4999'
process.env.ADMIN_EMAILS = 'chief@ashrt.link'

let request, app, events, ratelimit, abuse

before(async () => {
  request = (await import('supertest')).default
  app = (await import('../server.js')).default
  events = await import('../lib/events.js')
  ratelimit = await import('../lib/ratelimit.js')
  abuse = await import('../lib/abuse.js')
})

after(() => rmSync(DATA_DIR, { recursive: true, force: true }))
beforeEach(() => {
  ratelimit._resetMemory()
  abuse._clearCache()
})

const BROWSER = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36'
const today = () => new Date().toISOString().slice(0, 10)

async function totals() {
  return (await events.eventSeries(1)).totals
}

let seq = 0
async function signup(overrides = {}, headers = {}) {
  const req = request(app).post('/auth/register').set('User-Agent', BROWSER)
  for (const [k, v] of Object.entries(headers)) req.set(k, v)
  const res = await req.send({
    email: overrides.email || `f${++seq}@example.com`,
    password: 'a-good-password',
    ...overrides,
  })
  return { res, cookie: res.headers['set-cookie'] }
}

/* ------------------------------- the module ------------------------------- */

test('unknown event names are dropped, not stored', async () => {
  assert.equal(await events.track('definitely_not_an_event'), false)
  assert.equal(await events.track('page_view_home'), true)
})

test('referrers collapse to coarse source buckets', () => {
  const cases = {
    'https://www.google.com/search?q=free+link+tracker': 'google',
    'https://google.co.uk/': 'google',
    'https://www.bing.com/search?q=x': 'bing',
    'https://duckduckgo.com/': 'duckduckgo',
    'https://news.ycombinator.com/item?id=1': 'social',
    'https://x.com/someone/status/1': 'social',
    'https://t.co/abc': 'social',
    'https://someblog.example.com/post': 'referral',
    '': 'direct',
    'not a url': 'direct',
  }
  for (const [referer, expected] of Object.entries(cases)) {
    assert.equal(events.sourceOf(referer), expected, `${referer || '(none)'} should bucket as ${expected}`)
  }
})

test('a source bucket never contains the raw referrer', () => {
  // The point of bucketing is that a counter cannot become a browsing history.
  const source = events.sourceOf('https://intranet.acme-corp.example/private/page?token=secret')
  assert.equal(source, 'referral')
  assert.ok(!source.includes('acme'))
  assert.ok(!source.includes('secret'))
})

test('a funnel step reports no rate until the stage above it has volume', () => {
  const thin = events.buildFunnel({ page_view_home: 4, tracker_started: 2, signup_completed: 1 })
  const started = thin.find((s) => s.key === 'tracker_started')
  assert.equal(started.rate, null, '2 of 4 visits is not a 50% conversion rate')
  assert.equal(started.enoughData, false)

  const thick = events.buildFunnel({ page_view_home: 1000, tracker_started: 250 })
  const started2 = thick.find((s) => s.key === 'tracker_started')
  assert.equal(started2.rate, 25)
  assert.equal(started2.enoughData, true)
})

/* ---------------------------- server-side events -------------------------- */

test('a homepage visit is counted, attributed to its search source', async () => {
  const before = (await totals()).page_view_home || 0
  await request(app)
    .get('/')
    .set('User-Agent', BROWSER)
    .set('Referer', 'https://www.google.com/search?q=free+link+tracker')
  const after = (await totals()).page_view_home || 0
  assert.equal(after, before + 1)

  const sources = await events.acquisition(1, 'page_view_home')
  assert.ok(sources.google >= 1, 'the visit should be attributed to google')
})

test('a crawler visiting the homepage is not counted as a visitor', async () => {
  const before = (await totals()).page_view_home || 0
  for (const ua of ['Mozilla/5.0 (compatible; Googlebot/2.1)', 'Slackbot-LinkExpanding 1.0', 'curl/8.4.0']) {
    await request(app).get('/').set('User-Agent', ua)
  }
  const after = (await totals()).page_view_home || 0
  assert.equal(after, before, 'bot traffic must not inflate the top of the funnel')
})

test('landing pages count separately from the homepage', async () => {
  const before = (await totals()).page_view_landing || 0
  await request(app).get('/utm-link-tracker').set('User-Agent', BROWSER)
  await request(app).get('/qr-code-tracking').set('User-Agent', BROWSER)
  const after = (await totals()).page_view_landing || 0
  assert.equal(after, before + 2)
})

test('creating a link counts against the right bucket', async () => {
  const before = await totals()
  await request(app).post('/api/links').set('User-Agent', BROWSER).send({ url: 'example.com/guest-ev' })
  const mid = await totals()
  assert.equal((mid.guest_link_created || 0), (before.guest_link_created || 0) + 1)

  const { cookie } = await signup()
  await request(app).post('/api/links').set('Cookie', cookie).set('User-Agent', BROWSER).send({ url: 'example.com/user-ev' })
  const after = await totals()
  assert.equal((after.user_link_created || 0), (mid.user_link_created || 0) + 1)
  assert.equal(after.guest_link_created, mid.guest_link_created, 'a signed-in link is not a guest link')
})

test('a signup is counted and attributed to where the person came from', async () => {
  const before = (await totals()).signup_completed || 0
  await signup({}, { Referer: 'https://www.google.com/search?q=link+tracker' })
  const after = (await totals()).signup_completed || 0
  assert.equal(after, before + 1)

  const sources = await events.acquisition(1, 'signup_completed')
  assert.ok(sources.google >= 1)
})

test('claiming guest links at signup is counted', async () => {
  const made = await request(app).post('/api/links').set('User-Agent', BROWSER).send({ url: 'example.com/claim-ev' })
  const before = (await totals()).guest_link_claimed || 0
  await signup({ claimTokens: [made.body.manageToken] })
  const after = (await totals()).guest_link_claimed || 0
  assert.equal(after, before + 1)
})

test('an API-key link is distinguished from a dashboard link', async () => {
  const { cookie } = await signup()
  const key = (await request(app).get('/api/account').set('Cookie', cookie)).body.user.apiKey
  const before = (await totals()).api_link_created || 0
  await request(app).post('/api/links').set('x-api-key', key).send({ url: 'example.com/api-ev' })
  const after = (await totals()).api_link_created || 0
  assert.equal(after, before + 1)
})

/* ---------------------------- the client endpoint ------------------------- */

test('the client endpoint accepts only the events a browser can see', async () => {
  const before = await totals()

  const ok = await request(app).post('/api/events').set('User-Agent', BROWSER).send({ event: 'tracker_started' })
  assert.equal(ok.status, 204)

  // A server-observed event must not be forgeable from the browser: otherwise
  // anyone could inflate signups or subscriptions.
  for (const forged of ['signup_completed', 'subscription_started', 'guest_link_created']) {
    const res = await request(app).post('/api/events').set('User-Agent', BROWSER).send({ event: forged })
    assert.equal(res.status, 204, 'still answers quietly')
  }

  const after = await totals()
  assert.equal((after.tracker_started || 0), (before.tracker_started || 0) + 1)
  assert.equal(after.signup_completed, before.signup_completed, 'signups cannot be forged from the client')
  assert.equal(after.subscription_started, before.subscription_started, 'subscriptions cannot be forged')
})

test('a bot posting client events is ignored', async () => {
  const before = (await totals()).tracker_started || 0
  await request(app).post('/api/events').set('User-Agent', 'python-requests/2.31.0').send({ event: 'tracker_started' })
  const after = (await totals()).tracker_started || 0
  assert.equal(after, before)
})

/* -------------------------------- privacy --------------------------------- */

test('nothing identifying is written to the event store', async () => {
  await request(app)
    .get('/')
    .set('User-Agent', BROWSER)
    .set('Referer', 'https://intranet.acme-corp.example/secret-page?token=abc123')
    .set('X-Forwarded-For', '203.0.113.77')

  const path = join(DATA_DIR, '.events.json')
  assert.ok(existsSync(path), 'the file backend should have written the counters')
  const raw = readFileSync(path, 'utf8')

  for (const leak of ['203.0.113.77', 'acme-corp', 'secret-page', 'abc123', '@example.com']) {
    assert.ok(!raw.includes(leak), `the event store must not contain ${leak}`)
  }

  // What it should contain: day buckets, event names and coarse sources.
  const parsed = JSON.parse(raw)
  assert.ok(parsed[today()], 'counters are keyed by day')
  assert.equal(typeof parsed[today()].events.page_view_home, 'number')
})

/* ------------------------------- admin view ------------------------------- */

test('the funnel report is admin-only', async () => {
  const { cookie } = await signup()
  assert.equal((await request(app).get('/api/admin/funnel')).status, 401)
  assert.equal((await request(app).get('/api/admin/funnel').set('Cookie', cookie)).status, 404)
})

test('the funnel report assembles stages, sources and a series', async () => {
  const chief = await signup({ email: 'chief@ashrt.link' })
  const res = await request(app).get('/api/admin/funnel?days=7').set('Cookie', chief.cookie)
  assert.equal(res.status, 200)

  assert.equal(res.body.days, 7)
  assert.equal(res.body.dayKeys.length, 7)
  assert.ok(Array.isArray(res.body.funnel))
  assert.equal(res.body.funnel[0].key, 'visitors')
  assert.equal(res.body.funnel.at(-1).key, 'subscription_started')
  assert.ok(res.body.acquisition.arrivals)
  assert.ok(res.body.acquisition.signups)
  assert.equal(typeof res.body.totals, 'object')
})

test('the admin funnel page exists and is gated like the rest of admin', async () => {
  const { cookie } = await signup()
  assert.equal((await request(app).get('/admin/funnel').set('Cookie', cookie)).status, 404)

  const chief = await signup({ email: 'chief2@ashrt.link' })
  // Not an admin either, so still hidden.
  assert.equal((await request(app).get('/admin/funnel').set('Cookie', chief.cookie)).status, 404)
})
