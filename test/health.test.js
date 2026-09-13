import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkUrl, applyResult, isDue, dueLinks, intervalFor, INTERVALS, FAILURES_BEFORE_ALERT } from '../lib/health.js'

/**
 * Destination health.
 *
 * Two risks worth more than the feature itself. Making outbound requests to
 * user-supplied URLs from our own server is an SSRF primitive, so every hop of
 * every redirect is re-validated rather than trusted because the original
 * passed months ago. And an endpoint that makes those requests on demand is a
 * free proxy for whoever finds it, so it is not open.
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), 'ashrt-health-'))
process.env.ASHRT_DATA_DIR = DATA_DIR
process.env.SESSION_SECRET = 'health-test-secret-0123456789'
process.env.BASE_URL = 'http://localhost:4999'
process.env.CRON_SECRET = 'a-cron-secret-value'

let request, app, store, users, ratelimit, abuse

before(async () => {
  request = (await import('supertest')).default
  app = (await import('../server.js')).default
  ;({ store, users } = await import('../store.js'))
  ratelimit = await import('../lib/ratelimit.js')
  abuse = await import('../lib/abuse.js')
})

after(() => rmSync(DATA_DIR, { recursive: true, force: true }))
beforeEach(() => {
  ratelimit._resetMemory()
  abuse._clearCache()
})

/** A fetch stand-in: one scripted response per URL. */
function fakeFetch(routes) {
  const seen = []
  const impl = async (url) => {
    seen.push(url)
    const route = routes[url]
    if (!route) throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { cause: { code: 'ENOTFOUND' } })
    if (route.throw) throw route.throw
    return {
      status: route.status,
      headers: { get: (h) => (h.toLowerCase() === 'location' ? route.location || null : null) },
    }
  }
  impl.seen = seen
  return impl
}

/* -------------------------------- checking -------------------------------- */

test('a working destination reads as reachable', async () => {
  const fetchImpl = fakeFetch({ 'https://example.com/ok': { status: 200 } })
  const res = await checkUrl('https://example.com/ok', { fetchImpl })
  assert.equal(res.status, 'ok')
  assert.equal(res.code, 200)
})

test('404 and 500 are told apart, because the fix differs', async () => {
  const gone = await checkUrl('https://example.com/gone', {
    fetchImpl: fakeFetch({ 'https://example.com/gone': { status: 404 } }),
  })
  assert.equal(gone.status, 'not_found')

  const broken = await checkUrl('https://example.com/down', {
    fetchImpl: fakeFetch({ 'https://example.com/down': { status: 503 } }),
  })
  assert.equal(broken.status, 'server_error')
})

test('a page that refuses robots is not a broken page', async () => {
  // A members-only page answering 403 is working exactly as intended.
  const res = await checkUrl('https://example.com/members', {
    fetchImpl: fakeFetch({ 'https://example.com/members': { status: 403 } }),
  })
  assert.equal(res.status, 'ok')
  assert.equal(res.code, 403)
})

test('a server that refuses HEAD is retried with GET', async () => {
  const fetchImpl = fakeFetch({ 'https://example.com/head-hater': { status: 405 } })
  let call = 0
  const wrapped = async (url, opts) => {
    call++
    if (call === 1) return { status: 405, headers: { get: () => null } }
    assert.equal(opts.method, 'GET', 'the retry is a GET')
    return { status: 200, headers: { get: () => null } }
  }
  const res = await checkUrl('https://example.com/head-hater', { fetchImpl: wrapped })
  assert.equal(res.status, 'ok')
  void fetchImpl
})

test('a redirect loop is reported rather than followed forever', async () => {
  const fetchImpl = fakeFetch({
    'https://example.com/a': { status: 302, location: 'https://example.com/b' },
    'https://example.com/b': { status: 302, location: 'https://example.com/a' },
  })
  const res = await checkUrl('https://example.com/a', { fetchImpl })
  assert.equal(res.status, 'loop')
})

test('a redirect into a private address is refused, not followed', async () => {
  // The SSRF case. The destination passed validation when it was saved; a
  // redirect at check time must not become a way to reach our own network.
  const fetchImpl = fakeFetch({
    'https://example.com/start': { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
  })
  const res = await checkUrl('https://example.com/start', { fetchImpl })
  assert.equal(res.status, 'blocked')
  assert.ok(!fetchImpl.seen.some((u) => u.includes('169.254')), 'the private address is never requested')
})

test('a destination whose domain was blocked since is reported as blocked', async () => {
  const res = await checkUrl('https://bad.example/page', {
    blocked: ['bad.example'],
    fetchImpl: fakeFetch({ 'https://bad.example/page': { status: 200 } }),
  })
  assert.equal(res.status, 'blocked')
})

test('a name that does not resolve is a DNS problem, not a mystery', async () => {
  const res = await checkUrl('https://no-such-host.example/', { fetchImpl: fakeFetch({}) })
  assert.equal(res.status, 'dns')
})

test('a timeout is named as one', async () => {
  const res = await checkUrl('https://slow.example/', {
    fetchImpl: fakeFetch({
      'https://slow.example/': { throw: Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }) },
    }),
  })
  assert.equal(res.status, 'timeout')
})

/* ------------------------------- the schedule ----------------------------- */

test('one failure is not an alarm; two in a row is', () => {
  // A checker that cries wolf gets ignored, which is worse than not having one.
  let link = { url: 'https://example.com/x' }
  link.health = applyResult(link, { status: 'not_found', code: 404 })
  assert.equal(link.health.alerting, false)
  assert.equal(FAILURES_BEFORE_ALERT, 2)

  link.health = applyResult(link, { status: 'not_found', code: 404 })
  assert.equal(link.health.alerting, true)
  assert.ok(link.health.failingSince, 'and it remembers when it started')
})

test('recovering clears the alarm and records when it last worked', () => {
  let link = { url: 'https://example.com/x' }
  link.health = applyResult(link, { status: 'not_found' })
  link.health = applyResult(link, { status: 'not_found' })
  assert.equal(link.health.alerting, true)

  link.health = applyResult(link, { status: 'ok', code: 200 })
  assert.equal(link.health.alerting, false)
  assert.equal(link.health.failingSince, null)
  assert.ok(link.health.lastOkAt)
})

test('links nobody clicks are checked far less often', () => {
  const today = new Date().toISOString().slice(0, 10)
  const busy = { url: 'https://example.com/a', daily: { [today]: 12 } }
  const quiet = { url: 'https://example.com/b', daily: {} }
  assert.equal(intervalFor(busy), INTERVALS.active)
  assert.equal(intervalFor(quiet), INTERVALS.cold)
  assert.ok(intervalFor(quiet) > intervalFor(busy), 'politeness to other people\'s servers')
})

test('a currently broken link is rechecked sooner, so recovery is noticed', () => {
  const broken = { url: 'https://example.com/c', daily: {}, health: { status: 'not_found' } }
  assert.equal(intervalFor(broken), INTERVALS.broken)
})

test('only overdue links are picked, most overdue first, and the run is bounded', () => {
  const now = Date.now()
  const old = (hours) => ({ url: 'https://example.com/x', daily: {}, health: { checkedAt: now - hours * 3600e3 } })
  const links = [old(1), old(400), old(200), { url: 'https://example.com/new' }]

  assert.equal(isDue(links[0], now), false, 'checked an hour ago is not due')

  const due = dueLinks(links, { limit: 2, now })
  assert.equal(due.length, 2, 'the run is bounded')
  // A link never checked is the most overdue thing there is.
  assert.equal(due[0].url, 'https://example.com/new')
  assert.equal(due[1].health.checkedAt, now - 400 * 3600e3, 'then the oldest check')
})

test('a disabled link is not checked', () => {
  assert.equal(isDue({ url: 'https://example.com/x', status: 'disabled' }), false)
})

/* ------------------------------- the endpoint ----------------------------- */

test('the check endpoint is not open to whoever finds it', async () => {
  // It makes outbound requests on demand, which is a free proxy if unguarded.
  assert.equal((await request(app).get('/api/cron/health-check')).status, 404)
  assert.equal(
    (await request(app).get('/api/cron/health-check').set('Authorization', 'Bearer wrong-value-here')).status,
    404,
  )
})


/**
 * Monitoring is a paid feature, so these tests run as a paying account. The
 * free-plan refusal has its own test at the bottom.
 */
async function paidCookie(email, plan = 'pro') {
  const reg = await request(app).post('/auth/register').send({ email, password: 'a-good-password' })
  const user = await users.getByEmail(email)
  user.plan = plan
  await users.update(user)
  return reg.headers['set-cookie']
}

test('the report separates "nothing broken" from "nothing checked yet"', async () => {
  const cookie = await paidCookie('health1@example.com')
  await request(app).post('/api/links').set('Cookie', cookie).send({ url: 'example.com/unchecked' })

  const res = await request(app).get('/api/links/health').set('Cookie', cookie)
  assert.equal(res.status, 200)
  assert.equal(res.body.checking, false, 'nothing has been checked yet')
  assert.deepEqual(res.body.broken, [])
})

test('a broken destination reaches its owner with what they need to fix it', async () => {
  const cookie = await paidCookie('health2@example.com')
  const made = await request(app).post('/api/links').set('Cookie', cookie).send({ url: 'example.com/will-break' })

  // Two failed checks, the way the scheduler would record them.
  const link = await store.get(made.body.slug)
  link.health = applyResult(link, { status: 'not_found', code: 404 })
  link.health = applyResult(link, { status: 'not_found', code: 404 })
  await store.add(link)

  const res = await request(app).get('/api/links/health').set('Cookie', cookie)
  assert.equal(res.body.checking, true)
  assert.equal(res.body.broken.length, 1)
  const row = res.body.broken[0]
  assert.equal(row.slug, made.body.slug)
  assert.equal(row.label, 'Page not found')
  assert.equal(row.code, 404)
  assert.ok(row.failingSince)
})

test('health is reported to the owner and to nobody else', async () => {
  const mineCookie = await paidCookie('health3@example.com')
  const theirsCookie = await paidCookie('health4@example.com')

  const made = await request(app)
    .post('/api/links')
    .set('Cookie', mineCookie)
    .send({ url: 'example.com/private-break' })
  const link = await store.get(made.body.slug)
  link.health = applyResult(link, { status: 'server_error', code: 500 })
  link.health = applyResult(link, { status: 'server_error', code: 500 })
  await store.add(link)

  const other = await request(app).get('/api/links/health').set('Cookie', theirsCookie)
  assert.deepEqual(other.body.broken, [])
  assert.equal((await request(app).get('/api/links/health')).status, 401)
})

test('monitoring is refused on the free plan, and refused server-side', async () => {
  const reg = await request(app)
    .post('/auth/register')
    .send({ email: 'health-free@example.com', password: 'a-good-password' })
  const cookie = reg.headers['set-cookie']
  const res = await request(app).get('/api/links/health').set('Cookie', cookie)
  assert.equal(res.status, 402)
  assert.equal(res.body.needsUpgrade, true)
  assert.equal(res.body.upgradeTo, 'pro')
})
