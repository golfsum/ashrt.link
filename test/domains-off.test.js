import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The kill switch.
 *
 * Custom domains ship on, because the feature now reports its own state
 * honestly instead of silently doing nothing. CUSTOM_DOMAINS=0 still has to
 * turn the whole thing off cleanly: a deployment that cannot serve branded
 * hosts must say so rather than accept domains it will never route.
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), 'ashrt-domains-off-'))
process.env.ASHRT_DATA_DIR = DATA_DIR
process.env.SESSION_SECRET = 'domains-off-secret-0123456789'
process.env.BASE_URL = 'http://localhost:4999'
process.env.CUSTOM_DOMAINS = '0'

let request, app, users

before(async () => {
  request = (await import('supertest')).default
  app = (await import('../server.js')).default
  ;({ users } = await import('../store.js'))
})

after(() => rmSync(DATA_DIR, { recursive: true, force: true }))

async function paidSignup() {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: `off${Date.now()}@example.com`, password: 'a-good-password' })
  assert.equal(res.status, 200)
  const u = await users.getById(res.body.user.id)
  u.plan = 'business'
  await users.update(u)
  return res.headers['set-cookie']
}

test('the switch reports itself as off rather than pretending', async () => {
  const cookie = await paidSignup()
  const status = await request(app).get('/api/domains').set('Cookie', cookie)
  assert.equal(status.body.available, false)
  assert.equal(status.body.entitled, true, 'the plan still entitles them; the deployment does not')
})

test('adding and checking are both refused, and not as a plan problem', async () => {
  const cookie = await paidSignup()
  const add = await request(app).post('/api/domains').set('Cookie', cookie).send({ domain: 'links.example.com' })
  assert.equal(add.status, 503, 'not a 402: paying more would not help')
  assert.equal(add.body.unavailable, true)

  const verify = await request(app).post('/api/domains/links.example.com/verify').set('Cookie', cookie)
  assert.equal(verify.status, 503)
})

test('links are minted on the canonical host with the switch off', async () => {
  const cookie = await paidSignup()
  const made = await request(app).post('/api/links').set('Cookie', cookie).send({ url: 'example.com/x' })
  assert.match(made.body.shortUrl, /^http:\/\/localhost:4999\//)
})
