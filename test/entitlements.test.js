import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * What each plan is actually allowed to do.
 *
 * The failure this file exists to catch is the expensive one: a feature that is
 * hidden in the interface but reachable from the API. Every check here goes
 * through HTTP with nothing hidden, because that is how somebody would reach it
 * — and the point of the pricing page is that what it says is what the server
 * does.
 *
 * The second failure it catches is the opposite one: a limit tightened in the
 * config that quietly breaks somebody's existing links. Published links keep
 * redirecting on every plan, including after a downgrade, and there are tests
 * for that too.
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), 'ashrt-ent-'))
process.env.ASHRT_DATA_DIR = DATA_DIR
process.env.SESSION_SECRET = 'entitlements-test-secret-0123456789'
process.env.BASE_URL = 'http://localhost:4999'

let request, app, store, users, ratelimit, abuse, PLANS, PLAN_IDS

before(async () => {
  request = (await import('supertest')).default
  app = (await import('../server.js')).default
  ;({ store, users } = await import('../store.js'))
  ratelimit = await import('../lib/ratelimit.js')
  abuse = await import('../lib/abuse.js')
  ;({ PLANS, PLAN_IDS } = await import('../lib/plans.js'))
})

after(() => rmSync(DATA_DIR, { recursive: true, force: true }))
beforeEach(() => {
  ratelimit._resetMemory()
  abuse._clearCache()
})

let seq = 0
async function account(plan = 'free') {
  const email = `e${++seq}@example.com`
  const res = await request(app).post('/auth/register').send({ email, password: 'a-good-password' })
  assert.equal(res.status, 200)
  const user = await users.getByEmail(email)
  if (plan !== 'free') {
    user.plan = plan
    user.subscriptionStatus = 'active'
    await users.update(user)
  }
  return { email, id: user.id, cookie: res.headers['set-cookie'] }
}

const create = (cookie, url, body = {}) =>
  request(app).post('/api/links').set('Cookie', cookie).send({ url, ...body })
const patch = (cookie, slug, body) =>
  request(app).patch(`/api/links/${slug}`).set('Cookie', cookie).send(body)

const BROWSER = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36'

/* ------------------------------- the free plan ---------------------------- */

test('free creates exactly its allowance, and the links it already made keep working', async () => {
  const me = await account('free')
  const cap = PLANS.free.limits.linksPerMonth
  const slugs = []

  for (let i = 1; i <= cap; i++) {
    const res = await create(me.cookie, `example.com/free-${i}`)
    assert.equal(res.status, 200, `link ${i} should be allowed`)
    slugs.push(res.body.slug)
  }

  const overflow = await create(me.cookie, 'example.com/free-one-too-many')
  assert.equal(overflow.status, 402)
  assert.equal(overflow.body.needsUpgrade, true)
  assert.equal(overflow.body.upgradeTo, 'pro')

  // The limit is on creating. Everything already published still redirects.
  for (const slug of slugs) {
    const hit = await request(app).get(`/${slug}`).set('User-Agent', BROWSER)
    assert.equal(hit.status, 302, `${slug} must still redirect`)
  }
  // And they are all still listed, not hidden behind the limit.
  const list = await request(app).get('/api/links?limit=100').set('Cookie', me.cookie)
  assert.equal(list.body.links.length, cap)
})

test('everything the pricing page says free does not include is refused by the server', async () => {
  const me = await account('free')
  const made = await create(me.cookie, 'example.com/gated')
  const slug = made.body.slug

  const refusals = [
    ['CSV export', () => request(app).get('/api/export?type=links').set('Cookie', me.cookie)],
    ['custom domains', () =>
      request(app).post('/api/domains').set('Cookie', me.cookie).send({ domain: 'go.example.com' })],
    ['branded QR', () =>
      request(app).patch('/api/qr/style').set('Cookie', me.cookie).send({ dark: '#ff0000' })],
    ['bulk import', () =>
      request(app).post('/api/links/bulk').set('Cookie', me.cookie).send({ rows: [{ url: 'example.com/b' }] })],
    ['smart routing', () =>
      patch(me.cookie, slug, { rules: [{ type: 'country', values: ['US'], url: 'example.com/us' }] })],
    ['link expiry', () => patch(me.cookie, slug, { expiresAt: Date.now() + 86400000 })],
    ['scheduling', () => patch(me.cookie, slug, { startsAt: Date.now() + 86400000 })],
    ['destination monitoring', () => request(app).get('/api/links/health').set('Cookie', me.cookie)],
    ['webhooks', () =>
      request(app).post('/api/webhooks').set('Cookie', me.cookie).send({ url: 'https://hooks.example.com/x', events: ['link.created'] })],
  ]

  for (const [name, call] of refusals) {
    const res = await call()
    assert.equal(res.status, 402, `${name} must be refused with an upgrade, got ${res.status}`)
    assert.equal(res.body.needsUpgrade, true, `${name} must say what to do about it`)
    assert.ok(PLAN_IDS.includes(res.body.upgradeTo), `${name} must name the plan that includes it`)
  }

  // And nothing was half-applied on the way out.
  const after = await store.get(slug)
  assert.deepEqual(after.rules, [])
  assert.equal(after.expiresAt, null)
  assert.equal(after.startsAt, null)
})

test('free sees a short analytics window, and its lifetime totals are still whole', async () => {
  const me = await account('free')
  const made = await create(me.cookie, 'example.com/old-and-new')
  const link = await store.get(made.body.slug)

  const day = (back) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10)
  link.daily = { [day(500)]: 5, [day(100)]: 7, [day(2)]: 3 }
  link.clicks = 15
  await store.add(link)

  const free = await request(app).get(`/api/links/${made.body.slug}/stats`).set('Cookie', me.cookie)
  assert.equal(free.body.analyticsDays, 30)
  assert.deepEqual(Object.keys(free.body.series), [day(2)], 'only the last 30 days of the series')
  // The total is a total. Windowing the series must not quietly rewrite it.
  assert.equal(free.body.clicks, 15)

  const user = await users.getByEmail(me.email)
  user.plan = 'pro'
  await users.update(user)

  const pro = await request(app).get(`/api/links/${made.body.slug}/stats`).set('Cookie', me.cookie)
  assert.equal(pro.body.analyticsDays, 400)
  assert.equal(Object.keys(pro.body.series).length, 2, 'upgrading shows history that was already there')

  user.plan = 'business'
  await users.update(user)
  const biz = await request(app).get(`/api/links/${made.body.slug}/stats`).set('Cookie', me.cookie)
  assert.equal(biz.body.analyticsDays, 730)
  assert.equal(Object.keys(biz.body.series).length, 3, 'two years reaches the oldest day')
})

test('the API quota is the plan\'s, and it is enforced on the key', async () => {
  const me = await account('free')
  const key = await request(app)
    .post('/api/keys')
    .set('Cookie', me.cookie)
    .send({ name: 'quota', scopes: ['links:read'] })
  const secret = key.body.key

  const res = await request(app).get('/api/links').set('x-api-key', secret)
  assert.equal(res.status, 200)
  assert.equal(res.headers['x-ratelimit-limit'], String(PLANS.free.limits.apiPerDay))
})

/* ------------------------------- the paid plans --------------------------- */

test('pro gets what pro is sold, and not what business is sold', async () => {
  const me = await account('pro')
  const made = await create(me.cookie, 'example.com/pro-link')
  const slug = made.body.slug

  assert.equal((await request(app).get('/api/export?type=links').set('Cookie', me.cookie)).status, 200)
  assert.equal((await request(app).get('/api/links/health').set('Cookie', me.cookie)).status, 200)
  assert.equal(
    (await request(app).patch('/api/qr/style').set('Cookie', me.cookie).send({ dark: '#ff0000' })).status,
    200,
  )
  assert.equal((await patch(me.cookie, slug, { expiresAt: Date.now() + 86400000 })).status, 200)
  assert.equal(
    (await patch(me.cookie, slug, { rules: [{ type: 'country', values: ['US'], url: 'example.com/us' }] })).status,
    200,
  )

  // Webhooks are Business, and saying so is the whole job of this assertion.
  const hook = await request(app)
    .post('/api/webhooks')
    .set('Cookie', me.cookie)
    .send({ url: 'https://hooks.example.com/x', events: ['link.created'] })
  assert.equal(hook.status, 402)
  assert.equal(hook.body.upgradeTo, 'business')

  // Routing has a rule budget on Pro, and it is a refusal rather than a silent
  // truncation: saving five of eight rules would route traffic somewhere the
  // person never chose.
  const tooMany = await patch(me.cookie, slug, {
    rules: Array.from({ length: PLANS.pro.limits.routingRules + 1 }, (_, i) => ({
      type: 'device',
      values: ['mobile'],
      url: `example.com/r${i}`,
    })),
  })
  assert.equal(tooMany.status, 400)
  assert.match(tooMany.body.error, new RegExp(`at most ${PLANS.pro.limits.routingRules} rules`))
})

test('business gets the things only business has', async () => {
  const me = await account('business')
  const hook = await request(app)
    .post('/api/webhooks')
    .set('Cookie', me.cookie)
    .send({ url: 'https://hooks.example.com/biz', events: ['link.created'] })
  assert.equal(hook.status, 200)

  const made = await create(me.cookie, 'example.com/biz')
  const rules = await patch(me.cookie, made.body.slug, {
    rules: Array.from({ length: PLANS.pro.limits.routingRules + 1 }, (_, i) => ({
      type: 'device',
      values: ['mobile'],
      url: `example.com/r${i}`,
    })),
  })
  assert.equal(rules.status, 200, 'business routing is not capped at the Pro budget')
})

/* -------------------------------- downgrade ------------------------------- */

test('a downgrade takes away what you can add, never what you already made', async () => {
  const me = await account('business')

  const made = await create(me.cookie, 'example.com/published')
  const slug = made.body.slug
  await request(app).post('/api/campaigns').set('Cookie', me.cookie).send({ name: 'Spring' })
  await request(app).patch('/api/qr/style').set('Cookie', me.cookie).send({ dark: '#ff0000' })
  await patch(me.cookie, slug, { rules: [{ type: 'country', values: ['US'], url: 'example.com/us' }] })

  const user = await users.getByEmail(me.email)
  user.plan = 'free'
  user.subscriptionStatus = 'canceled'
  await users.update(user)

  // The link still redirects, and still routes the way it was set up to.
  const hit = await request(app).get(`/${slug}`).set('User-Agent', BROWSER)
  assert.equal(hit.status, 302)

  // Its QR code still resolves.
  const qr = await request(app).get(`/api/qr?slug=${slug}`).set('Cookie', me.cookie)
  assert.equal(qr.status, 200)

  // Nothing was deleted: the link, its campaign and its rules are all still there.
  const record = await store.get(slug)
  assert.equal(record.rules.length, 1)
  const camps = await request(app).get('/api/campaigns').set('Cookie', me.cookie)
  assert.equal(camps.body.campaigns.length, 1)
  const list = await request(app).get('/api/links').set('Cookie', me.cookie)
  assert.equal(list.body.links.length, 1)

  // What is gone is the ability to add more of the paid things.
  assert.equal(
    (await request(app).post('/api/campaigns').set('Cookie', me.cookie).send({ name: 'Summer' })).status,
    402,
    'free allows one campaign and this account already has it',
  )
  assert.equal((await request(app).get('/api/export?type=links').set('Cookie', me.cookie)).status, 402)
})

/* --------------------------- what the pages are told ---------------------- */

test('the plan API says exactly what the server enforces', async () => {
  const res = await request(app).get('/api/plans')
  assert.equal(res.status, 200)

  for (const shown of res.body.plans) {
    const real = PLANS[shown.id]
    assert.equal(shown.price.monthly, real.price.monthly, `${shown.id} price`)
    for (const [key, value] of Object.entries(real.limits)) {
      const expected = value === Infinity ? null : value
      assert.equal(shown.limits[key], expected, `${shown.id} ${key}`)
    }
  }

  // The three numbers the marketing copy leans on, asserted by value, because
  // "it comes from the config" is only reassuring if the config is right.
  const byId = Object.fromEntries(res.body.plans.map((p) => [p.id, p]))
  assert.equal(byId.free.price.monthlyLabel, '$0')
  assert.equal(byId.pro.price.monthlyLabel, '$9')
  assert.equal(byId.business.price.monthlyLabel, '$29')
  assert.equal(byId.free.limits.linksPerMonth, 10)
  assert.equal(byId.pro.limits.linksPerMonth, 250)
  assert.equal(byId.business.limits.linksPerMonth, 2500)
  assert.equal(byId.pro.ctaLabel, 'Choose Pro')
  assert.equal(byId.business.ctaLabel, 'Choose Business')
  assert.equal(byId.free.ctaLabel, 'Start free')
  assert.equal(byId.pro.featured, true)
})

test('a plan with no Stripe price is reported as unavailable rather than linked to checkout', async () => {
  const res = await request(app).get('/api/plans')
  // Nothing is configured in the test environment, so nothing is buyable, and
  // the UI has what it needs to say so instead of opening a broken checkout.
  assert.equal(res.body.available.pro.monthly, false)
  assert.equal(res.body.available.business.annual, false)

  const me = await account('free')
  const checkout = await request(app)
    .post('/api/billing/checkout')
    .set('Cookie', me.cookie)
    .send({ plan: 'pro' })
  assert.equal(checkout.status, 503)
})

test('usage is reported from the same counters the limits are enforced with', async () => {
  const me = await account('free')
  await create(me.cookie, 'example.com/counted-1')
  await create(me.cookie, 'example.com/counted-2')

  const res = await request(app).get('/api/usage/summary').set('Cookie', me.cookie)
  assert.equal(res.status, 200)
  assert.equal(res.body.plan, 'free')
  assert.equal(res.body.links.used, 2)
  assert.equal(res.body.links.limit, PLANS.free.limits.linksPerMonth)
  assert.ok(res.body.links.resetAt > Date.now())
  assert.equal(res.body.linksKept, 2)
  assert.equal(res.body.nextPlan, 'pro')

  // Reading the meter must not spend the allowance it is reporting.
  const again = await request(app).get('/api/usage/summary').set('Cookie', me.cookie)
  assert.equal(again.body.links.used, 2)
})
