import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Destination history.
 *
 * A short link is often printed, scheduled, or handed to someone else, so
 * changing where it points changes something already out in the world. The
 * product has to be able to answer "what did this used to be", to say how much
 * traffic is at stake before the change, and to undo it.
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), 'ashrt-history-'))
process.env.ASHRT_DATA_DIR = DATA_DIR
process.env.SESSION_SECRET = 'history-test-secret-0123456789'
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
  const email = `h${++seq}@example.com`
  const res = await request(app).post('/auth/register').send({ email, password: 'a-good-password' })
  assert.equal(res.status, 200)
  if (plan !== 'free') {
    const user = await users.getByEmail(email)
    user.plan = plan
    await users.update(user)
  }
  return { cookie: res.headers['set-cookie'], id: res.body.user.id, email: res.body.user.email }
}

const create = (cookie, url) => request(app).post('/api/links').set('Cookie', cookie).send({ url })
const edit = (cookie, slug, body) => request(app).patch(`/api/links/${slug}`).set('Cookie', cookie).send(body)

test('changing a destination remembers the old one', async () => {
  const me = await signup()
  const made = await create(me.cookie, 'example.com/first')
  const slug = made.body.slug

  const changed = await edit(me.cookie, slug, { url: 'example.com/second' })
  assert.equal(changed.status, 200)
  assert.equal(changed.body.url, 'https://example.com/second')
  assert.equal(changed.body.history.length, 1)
  assert.equal(changed.body.history[0].url, 'https://example.com/first')
  assert.equal(changed.body.history[0].by, me.email, 'and who changed it')
  assert.ok(changed.body.history[0].changedAt > 0)
})

test('editing something other than the destination adds no history', async () => {
  const me = await signup()
  const made = await create(me.cookie, 'example.com/same')
  const renamed = await edit(me.cookie, made.body.slug, { title: 'Spring sale' })
  assert.equal(renamed.body.history.length, 0)

  // Nor does setting the same destination again.
  const again = await edit(me.cookie, made.body.slug, { url: 'https://example.com/same' })
  assert.equal(again.body.history.length, 0)
})

test('the history is capped so one record cannot grow forever', async () => {
  const me = await signup()
  const made = await create(me.cookie, 'example.com/0')
  for (let i = 1; i <= 14; i++) await edit(me.cookie, made.body.slug, { url: `example.com/${i}` })

  const now = await request(app).get('/api/links').set('Cookie', me.cookie)
  const link = now.body.links.find((l) => l.slug === made.body.slug)
  assert.equal(link.history.length, 10, 'Pro rolls back ten')
  assert.equal(link.history[0].url, 'https://example.com/13', 'newest first')
})

test('how far back you can roll is the plan, and the record is not thrown away', async () => {
  // Free gets the one destination before this one — enough to undo a mistake.
  // The rest of the record is still kept, so upgrading shows it rather than
  // starting the history over, and downgrading never deletes it.
  const me = await signup('free')
  const made = await create(me.cookie, 'example.com/a')
  for (const step of ['b', 'c', 'd']) await edit(me.cookie, made.body.slug, { url: `example.com/${step}` })

  const asFree = await request(app).get('/api/links').set('Cookie', me.cookie)
  const shown = asFree.body.links.find((l) => l.slug === made.body.slug)
  assert.equal(shown.history.length, 1)
  assert.equal(shown.history[0].url, 'https://example.com/c')
  assert.equal(shown.historyKept, 3, 'the record still holds all three')

  // And the depth is enforced, not just displayed: reverting to a destination
  // the plan cannot reach is an upgrade prompt, never a silent success.
  const older = (await store.get(made.body.slug)).history.at(-1)
  const denied = await request(app)
    .post(`/api/links/${made.body.slug}/revert`)
    .set('Cookie', me.cookie)
    .send({ changedAt: older.changedAt })
  assert.equal(denied.status, 402)
  assert.equal(denied.body.upgradeTo, 'pro')

  const user = await users.getByEmail(me.email)
  user.plan = 'pro'
  await users.update(user)

  const asPro = await request(app).get('/api/links').set('Cookie', me.cookie)
  const full = asPro.body.links.find((l) => l.slug === made.body.slug)
  assert.equal(full.history.length, 3, 'upgrading reveals what was already there')
})

test('a link says how much traffic is at stake before it is changed', async () => {
  const me = await signup()
  const made = await create(me.cookie, 'example.com/busy')
  const BROWSER = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36'
  for (let i = 0; i < 3; i++) {
    await request(app).get(`/${made.body.slug}`).set('User-Agent', BROWSER).set('X-Forwarded-For', `9.9.9.${i}`)
  }

  const list = await request(app).get('/api/links').set('Cookie', me.cookie)
  const link = list.body.links.find((l) => l.slug === made.body.slug)
  assert.equal(link.recentClicks, 3)
  assert.equal(link.recentDays, 30)
})

test('a link can be put back to where it used to point', async () => {
  const me = await signup()
  const made = await create(me.cookie, 'example.com/original')
  await edit(me.cookie, made.body.slug, { url: 'example.com/oops' })

  const list = await request(app).get('/api/links').set('Cookie', me.cookie)
  const entry = list.body.links.find((l) => l.slug === made.body.slug).history[0]

  const back = await request(app)
    .post(`/api/links/${made.body.slug}/revert`)
    .set('Cookie', me.cookie)
    .send({ changedAt: entry.changedAt })
  assert.equal(back.status, 200)
  assert.equal(back.body.url, 'https://example.com/original')
  assert.equal(back.body.history[0].url, 'https://example.com/oops', 'reverting is itself a change')

  // And the link actually redirects there now.
  const hit = await request(app).get(`/${made.body.slug}`).set('User-Agent', 'Mozilla/5.0 Chrome/120 Safari/537.36')
  assert.equal(hit.headers.location, 'https://example.com/original')
})

test('reverting re-checks the destination instead of trusting the past', async () => {
  const me = await signup()
  const made = await create(me.cookie, 'soon-bad.example/page')
  await edit(me.cookie, made.body.slug, { url: 'example.com/safe' })

  const list = await request(app).get('/api/links').set('Cookie', me.cookie)
  const entry = list.body.links.find((l) => l.slug === made.body.slug).history[0]

  // The old destination is blocked between the change and the revert.
  const { blockDomain, _clearCache } = await import('../lib/abuse.js')
  await blockDomain('soon-bad.example', { by: 'test', reason: 'phishing' })
  _clearCache()

  const back = await request(app)
    .post(`/api/links/${made.body.slug}/revert`)
    .set('Cookie', me.cookie)
    .send({ changedAt: entry.changedAt })
  assert.equal(back.status, 400, 'allowed six weeks ago is not a reason to serve it today')

  const after = await store.get(made.body.slug)
  assert.equal(after.url, 'https://example.com/safe', 'and nothing changed')
})

test('history and revert belong to the owner alone', async () => {
  const me = await signup()
  const stranger = await signup()
  const made = await create(me.cookie, 'example.com/mine')
  await edit(me.cookie, made.body.slug, { url: 'example.com/mine-2' })

  const theirs = await request(app)
    .post(`/api/links/${made.body.slug}/revert`)
    .set('Cookie', stranger.cookie)
    .send({ changedAt: Date.now() })
  assert.equal(theirs.status, 403)
})

/* --------------------------------- expiry --------------------------------- */

test('expiry is a paid feature, refused server-side', async () => {
  const me = await signup('free')
  const made = await create(me.cookie, 'example.com/expiring')
  const res = await edit(me.cookie, made.body.slug, { expiresAt: Date.now() + 86400000 })
  assert.equal(res.status, 402)
  assert.equal(res.body.needsUpgrade, true)

  const after = await store.get(made.body.slug)
  assert.equal(after.expiresAt, null, 'and nothing was set')
})

test('a paid account can set an expiry, and an expired link stops forwarding', async () => {
  const me = await signup()
  const u = await users.getById(me.id)
  u.plan = 'pro'
  await users.update(u)

  const made = await create(me.cookie, 'example.com/ends')
  const set = await edit(me.cookie, made.body.slug, { expiresAt: Date.now() + 60000 })
  assert.equal(set.status, 200)
  assert.ok(set.body.expiresAt > Date.now())

  const live = await request(app).get(`/${made.body.slug}`).set('User-Agent', 'Mozilla/5.0 Chrome/120 Safari/537.36')
  assert.equal(live.status, 302)

  // Move it into the past the way time would.
  const link = await store.get(made.body.slug)
  link.expiresAt = Date.now() - 1000
  await store.add(link)

  const done = await request(app).get(`/${made.body.slug}`).set('User-Agent', 'Mozilla/5.0 Chrome/120 Safari/537.36')
  assert.equal(done.status, 410, 'an expired link says so rather than 404ing')

  // And it can be brought back by clearing the date.
  const cleared = await edit(me.cookie, made.body.slug, { expiresAt: null })
  assert.equal(cleared.body.expiresAt, null)
  const again = await request(app).get(`/${made.body.slug}`).set('User-Agent', 'Mozilla/5.0 Chrome/120 Safari/537.36')
  assert.equal(again.status, 302)
})

/* ------------------------------- scheduling -------------------------------- */

test('a scheduled link can be printed today and starts forwarding later', async () => {
  const me = await signup('pro')
  const made = await create(me.cookie, 'example.com/launch')
  const startsAt = Date.now() + 60_000

  const set = await edit(me.cookie, made.body.slug, { startsAt })
  assert.equal(set.status, 200)
  assert.equal(set.body.startsAt, startsAt)
  assert.equal(set.body.status, 'scheduled')

  // Before its time it does not forward, and it says why rather than looking
  // like a broken link.
  const early = await request(app).get(`/${made.body.slug}`)
  assert.equal(early.status, 404)
  assert.match(early.text, /Not live yet/)

  // Once the time passes it starts on its own, with no further action.
  const link = await store.get(made.body.slug)
  link.startsAt = Date.now() - 1000
  await store.add(link)
  const live = await request(app).get(`/${made.body.slug}`)
  assert.equal(live.status, 302)
  assert.equal(live.headers.location, 'https://example.com/launch')
})

test('scheduling is a paid feature, refused server-side', async () => {
  const me = await signup('free')
  const made = await create(me.cookie, 'example.com/free-launch')
  const res = await edit(me.cookie, made.body.slug, { startsAt: Date.now() + 60_000 })
  assert.equal(res.status, 402)
  assert.equal(res.body.upgradeTo, 'pro')
  assert.equal((await store.get(made.body.slug)).startsAt, null, 'and nothing was set')
})

test('a link cannot be scheduled to start after it expires', async () => {
  const me = await signup('pro')
  const made = await create(me.cookie, 'example.com/window')
  await edit(me.cookie, made.body.slug, { expiresAt: Date.now() + 60_000 })
  const res = await edit(me.cookie, made.body.slug, { startsAt: Date.now() + 120_000 })
  assert.equal(res.status, 400)
})

test('the record outlives the longest plan window, so no plan promises history we threw away', async () => {
  const { DAILY_RETENTION_DAYS } = await import('../store.js')
  const { PLANS, PLAN_IDS } = await import('../lib/plans.js')
  const longest = Math.max(...PLAN_IDS.map((id) => PLANS[id].limits.analyticsDays))
  assert.ok(
    DAILY_RETENTION_DAYS >= longest,
    `storage keeps ${DAILY_RETENTION_DAYS} days but a plan sells ${longest}`,
  )
})
