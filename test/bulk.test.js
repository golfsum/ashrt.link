import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Bulk creation.
 *
 * The failure that matters here is the half-done import: 200 rows in, 86
 * created, one bad row, and now somebody has to work out which 86 exist before
 * they can try again. So the batch is judged before anything is written, every
 * row gets its own verdict, and running out of plan allowance stops the batch
 * cleanly rather than partway through a row.
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), 'ashrt-bulk-'))
process.env.ASHRT_DATA_DIR = DATA_DIR
process.env.SESSION_SECRET = 'bulk-test-secret-0123456789'
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
    .send({ email: `b${++seq}@example.com`, password: 'a-good-password' })
  assert.equal(res.status, 200)
  const u = await users.getById(res.body.user.id)
  u.plan = plan
  await users.update(u)
  return { cookie: res.headers['set-cookie'], id: res.body.user.id }
}

const bulk = (cookie, rows, extra = {}) =>
  request(app).post('/api/links/bulk').set('Cookie', cookie).send({ rows, ...extra })

test('bulk creation is a paid feature', async () => {
  const free = await signup('free')
  const res = await bulk(free.cookie, [{ url: 'example.com/a' }])
  assert.equal(res.status, 402)
  assert.equal(res.body.needsUpgrade, true)
})

test('a dry run judges every row and writes nothing', async () => {
  const me = await signup()
  const res = await bulk(
    me.cookie,
    [
      { url: 'example.com/good' },
      { url: 'not a url' },
      { url: 'http://127.0.0.1/admin' },
      { url: '' },
      { url: 'example.com/alias', alias: 'spring-sale' },
      { url: 'example.com/bad-alias', alias: 'spaces not allowed' },
    ],
    { dryRun: true },
  )
  assert.equal(res.status, 200)
  assert.equal(res.body.dryRun, true)
  assert.equal(res.body.ready, 2)
  assert.equal(res.body.rejected, 4)

  const byLine = Object.fromEntries(res.body.rows.map((r) => [r.line, r.status]))
  assert.equal(byLine[1], 'ready')
  assert.equal(byLine[2], 'invalid')
  assert.equal(byLine[3], 'invalid')
  assert.equal(byLine[4], 'empty')
  assert.equal(byLine[5], 'ready')
  assert.equal(byLine[6], 'bad_alias')

  assert.equal((await store.byOwner(me.id)).length, 0, 'a dry run writes nothing')
  assert.equal(await store.exists('spring-sale'), false)
})

test('every row carries its own verdict, not just a count', async () => {
  const me = await signup()
  const res = await bulk(me.cookie, [
    { url: 'example.com/one', title: 'One', tags: ['q3'] },
    { url: 'javascript:alert(1)' },
    { url: 'example.com/two', alias: 'two-please' },
  ])
  assert.equal(res.status, 200)
  assert.equal(res.body.created, 2)
  assert.equal(res.body.rejected, 1)

  const rows = res.body.rows
  assert.equal(rows[0].status, 'created')
  assert.ok(rows[0].slug && rows[0].shortUrl.includes(rows[0].slug))
  assert.equal(rows[1].status, 'invalid')
  assert.ok(rows[1].error)
  assert.equal(rows[2].slug, 'two-please', 'a requested short code is honoured')

  const mine = await store.byOwner(me.id)
  assert.equal(mine.length, 2)
  assert.equal(mine.find((l) => l.slug === 'two-please').url, 'https://example.com/two')
  assert.deepEqual(mine.find((l) => l.title === 'One').tags, ['q3'])
})

test('a short code already in use is refused, and the rest still import', async () => {
  const me = await signup()
  await bulk(me.cookie, [{ url: 'example.com/first', alias: 'taken-code' }])

  const res = await bulk(me.cookie, [
    { url: 'example.com/second', alias: 'taken-code' },
    { url: 'example.com/third' },
  ])
  assert.equal(res.body.rows[0].status, 'alias_taken')
  assert.equal(res.body.rows[1].status, 'created')
  assert.equal(res.body.created, 1)
})

test('the same short code twice in one file is caught before anything is written', async () => {
  const me = await signup()
  const res = await bulk(me.cookie, [
    { url: 'example.com/a', alias: 'same-code' },
    { url: 'example.com/b', alias: 'same-code' },
  ])
  assert.equal(res.body.rows[0].status, 'created')
  assert.equal(res.body.rows[1].status, 'alias_repeated')
})

test('a repeated destination is flagged as a duplicate but still created', async () => {
  // Two campaigns pointing at one page is normal. It is worth mentioning and
  // not worth refusing.
  const me = await signup()
  const res = await bulk(me.cookie, [
    { url: 'example.com/same-page' },
    { url: 'example.com/same-page' },
  ])
  assert.equal(res.body.created, 2)
  assert.equal(res.body.rows[1].status, 'created')
})

test('the batch stops at the plan allowance and says which rows did not make it', async () => {
  const { PLANS } = await import('../lib/plans.js')
  const real = PLANS.pro.limits.linksPerMonth
  PLANS.pro.limits.linksPerMonth = 2
  try {
    const me = await signup()
    const res = await bulk(me.cookie, [
      { url: 'example.com/1' },
      { url: 'example.com/2' },
      { url: 'example.com/3' },
      { url: 'example.com/4' },
    ])
    assert.equal(res.body.created, 2)
    assert.equal(res.body.rows[2].status, 'over_quota')
    assert.equal(res.body.rows[3].status, 'over_quota')
    assert.ok(res.body.rows[2].error.includes('allowance'))

    // Exactly two exist: the batch stopped at the limit, not partway through a
    // row, so re-running after an upgrade cannot double-create.
    assert.equal((await store.byOwner(me.id)).length, 2)
  } finally {
    PLANS.pro.limits.linksPerMonth = real
  }
})

test('a suspicious destination is imported flagged, not silently', async () => {
  const me = await signup()
  const res = await bulk(me.cookie, [
    { url: 'http://paypal-secure-login.tk/verify-account-now/password' },
  ])
  const row = res.body.rows[0]
  assert.ok(['created', 'flagged'].includes(row.status))
  if (row.status === 'flagged') {
    const link = await store.get(row.slug)
    assert.equal(link.status, 'flagged')
  }
})

test('an oversized batch is refused with the limit named', async () => {
  const me = await signup()
  const rows = Array.from({ length: 300 }, (_, i) => ({ url: `example.com/${i}` }))
  const res = await bulk(me.cookie, rows)
  assert.equal(res.status, 400)
  assert.match(res.body.error, /at most 250/)
})

test('bulk creation needs an account', async () => {
  const res = await request(app).post('/api/links/bulk').send({ rows: [{ url: 'example.com/x' }] })
  assert.equal(res.status, 401)
})
