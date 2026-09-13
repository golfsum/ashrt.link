import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeRules, resolveDestination, MAX_RULES } from '../lib/routing.js'

/**
 * Smart routing: one link, several destinations.
 *
 * The risks are specific. A rule set that matches nothing must not produce a
 * dead link. A rule destination must not be a way around URL validation. And a
 * rule must never send a visitor somewhere its owner did not choose.
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), 'ashrt-routing-'))
process.env.ASHRT_DATA_DIR = DATA_DIR
process.env.SESSION_SECRET = 'routing-test-secret-0123456789'
process.env.BASE_URL = 'http://localhost:4999'

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

let seq = 0
async function signup(plan = 'pro') {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: `r${++seq}@example.com`, password: 'a-good-password' })
  assert.equal(res.status, 200)
  const u = await users.getById(res.body.user.id)
  u.plan = plan
  await users.update(u)
  return { cookie: res.headers['set-cookie'], id: res.body.user.id }
}

const create = (cookie, url) => request(app).post('/api/links').set('Cookie', cookie).send({ url })
const setRules = (cookie, slug, rules) =>
  request(app).patch(`/api/links/${slug}`).set('Cookie', cookie).send({ rules })

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17 Mobile Safari/604'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64) AppleWebKit/537.36 Chrome/120 Safari/537.36'

const visit = (slug, { ua = DESKTOP, country = 'US' } = {}) =>
  request(app).get(`/${slug}`).set('User-Agent', ua).set('x-vercel-ip-country', country)

/* ------------------------------ the resolver ------------------------------ */

test('with no rules, the link goes where it always did', () => {
  const link = { url: 'https://example.com/home' }
  assert.equal(resolveDestination(link, { country: 'US' }).url, 'https://example.com/home')
})

test('a rule set that matches nothing falls back to the default', () => {
  // The most important property here: configuring a link can never make it a
  // dead end.
  const link = {
    url: 'https://example.com/global',
    rules: [{ id: 'a', type: 'country', values: ['US'], url: 'https://example.com/us' }],
  }
  assert.equal(resolveDestination(link, { country: 'JP' }).url, 'https://example.com/global')
  assert.equal(resolveDestination(link, {}).url, 'https://example.com/global')
})

test('first match wins, in the order the owner arranged them', () => {
  const link = {
    url: 'https://example.com/default',
    rules: [
      { id: 'a', type: 'device', values: ['mobile'], url: 'https://example.com/mobile' },
      { id: 'b', type: 'country', values: ['US'], url: 'https://example.com/us' },
    ],
  }
  const hit = resolveDestination(link, { device: 'mobile', country: 'US' })
  assert.equal(hit.url, 'https://example.com/mobile', 'no scoring, no specificity ranking')
  assert.equal(hit.rule.id, 'a')
})

test('rules are cleaned rather than trusted', () => {
  const { rules, errors } = sanitizeRules([
    { type: 'country', values: ['us', ' gb ', 'us'], url: 'https://example.com/1' },
    { type: 'nonsense', values: ['x'], url: 'https://example.com/2' },
    { type: 'country', values: ['UNITED STATES'], url: 'https://example.com/3' },
    { type: 'device', values: ['mobile'] },
  ])
  assert.equal(rules.length, 1)
  assert.deepEqual(rules[0].values, ['US', 'GB'], 'normalised and de-duplicated')
  assert.equal(errors.length, 3, 'and every rejection is reported, not swallowed')
})

test('the number of rules per link is capped', () => {
  const many = Array.from({ length: MAX_RULES + 5 }, () => ({
    type: 'country',
    values: ['US'],
    url: 'https://example.com/x',
  }))
  const { rules, errors } = sanitizeRules(many)
  assert.equal(rules.length, MAX_RULES)
  assert.ok(errors.some((e) => e.includes('at most')))
})

/* -------------------------------- in the app ------------------------------ */

test('routing is a paid feature, refused server-side', async () => {
  const free = await signup('free')
  const made = await create(free.cookie, 'example.com/home')
  const res = await setRules(free.cookie, made.body.slug, [
    { type: 'country', values: ['US'], url: 'https://example.com/us' },
  ])
  assert.equal(res.status, 402)
  assert.deepEqual((await store.get(made.body.slug)).rules, [])
})

test('a link sends each visitor where its rules say', async () => {
  const me = await signup()
  const made = await create(me.cookie, 'example.com/global')
  const slug = made.body.slug

  const saved = await setRules(me.cookie, slug, [
    { type: 'os', values: ['ios'], url: 'https://apps.example.com/app' },
    { type: 'os', values: ['android'], url: 'https://play.example.com/app' },
    { type: 'country', values: ['GB', 'IE'], url: 'https://example.co.uk/' },
  ])
  assert.equal(saved.status, 200)
  assert.equal(saved.body.rules.length, 3)

  assert.equal((await visit(slug, { ua: IPHONE })).headers.location, 'https://apps.example.com/app')
  assert.equal((await visit(slug, { ua: ANDROID })).headers.location, 'https://play.example.com/app')
  assert.equal((await visit(slug, { ua: DESKTOP, country: 'GB' })).headers.location, 'https://example.co.uk/')
  assert.equal(
    (await visit(slug, { ua: DESKTOP, country: 'FR' })).headers.location,
    'https://example.com/global',
    'anyone the rules do not cover still gets the default',
  )
})

test('each rule is credited with the clicks it served', async () => {
  const me = await signup()
  const made = await create(me.cookie, 'example.com/default')
  const slug = made.body.slug
  const saved = await setRules(me.cookie, slug, [
    { type: 'os', values: ['ios'], url: 'https://example.com/ios' },
  ])
  const ruleId = saved.body.rules[0].id

  await visit(slug, { ua: IPHONE })
  await visit(slug, { ua: IPHONE })
  await visit(slug, { ua: DESKTOP })

  const summary = await store.linkSummary(slug)
  assert.equal(summary.routed[ruleId], 2)
  assert.equal(summary.routed.default, 1)
  assert.equal(summary.clicks, 3)
})

test('a rule destination cannot reach somewhere a link could not', async () => {
  const me = await signup()
  const made = await create(me.cookie, 'example.com/safe')

  for (const bad of ['http://127.0.0.1/admin', 'javascript:alert(1)', 'http://169.254.169.254/latest/']) {
    const res = await setRules(me.cookie, made.body.slug, [
      { type: 'country', values: ['US'], url: bad },
    ])
    assert.equal(res.status, 400, `${bad} must be refused`)
  }
  assert.deepEqual((await store.get(made.body.slug)).rules, [], 'and nothing was saved')
})

test('blocking a domain later kills the rule, not the link', async () => {
  const me = await signup()
  const made = await create(me.cookie, 'example.com/still-fine')
  const slug = made.body.slug
  await setRules(me.cookie, slug, [
    { type: 'country', values: ['US'], url: 'https://later-blocked.example/us' },
  ])
  assert.equal((await visit(slug, { country: 'US' })).headers.location, 'https://later-blocked.example/us')

  const { blockDomain, _clearCache } = await import('../lib/abuse.js')
  await blockDomain('later-blocked.example', { by: 'test', reason: 'phishing' })
  _clearCache()

  // The rule stops being served, and the visitor gets the link's own
  // destination rather than an error page.
  const after = await visit(slug, { country: 'US' })
  assert.equal(after.status, 302)
  assert.equal(after.headers.location, 'https://example.com/still-fine')

  const summary = await store.linkSummary(slug)
  assert.equal(summary.routed.default, 1, 'and the click is credited to the default, not the dead rule')
})

test('rules can be cleared', async () => {
  const me = await signup()
  const made = await create(me.cookie, 'example.com/plain')
  await setRules(me.cookie, made.body.slug, [
    { type: 'device', values: ['mobile'], url: 'https://example.com/m' },
  ])
  const cleared = await setRules(me.cookie, made.body.slug, [])
  assert.equal(cleared.status, 200)
  assert.deepEqual(cleared.body.rules, [])
  assert.equal((await visit(made.body.slug, { ua: IPHONE })).headers.location, 'https://example.com/plain')
})

test('another account cannot route your link', async () => {
  const me = await signup()
  const stranger = await signup()
  const made = await create(me.cookie, 'example.com/mine')
  const res = await setRules(stranger.cookie, made.body.slug, [
    { type: 'country', values: ['US'], url: 'https://evil.example/' },
  ])
  assert.equal(res.status, 403)
})
