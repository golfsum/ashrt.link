import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * CSV export.
 *
 * Two things matter here beyond "it produces a file": an export must only ever
 * contain the requesting account's own data, and a destination URL must not be
 * able to execute as a formula when the file is opened in a spreadsheet.
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), 'ashrt-export-'))
process.env.ASHRT_DATA_DIR = DATA_DIR
process.env.SESSION_SECRET = 'export-test-secret-0123456789'
process.env.BASE_URL = 'http://localhost:4999'

let request, app, ratelimit, abuse, store, users

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
/** CSV export is a paid feature, so the export tests run as a paying account. */
async function signup(plan = 'pro') {
  const email = `x${++seq}@example.com`
  const res = await request(app).post('/auth/register').send({ email, password: 'a-good-password' })
  assert.equal(res.status, 200)
  if (plan !== 'free') {
    const user = await users.getByEmail(email)
    user.plan = plan
    await users.update(user)
  }
  return res.headers['set-cookie']
}

const BROWSER = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36'

test('the link export has a header row and one row per link', async () => {
  const cookie = await signup()
  await request(app).post('/api/links').set('Cookie', cookie).send({ url: 'example.com/one', title: 'One' })
  await request(app).post('/api/links').set('Cookie', cookie).send({ url: 'example.com/two' })

  const res = await request(app).get('/api/export?type=links').set('Cookie', cookie)
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /text\/csv/)
  assert.match(res.headers['content-disposition'], /attachment; filename="ashrt-links-\d{4}-\d{2}-\d{2}\.csv"/)

  const lines = res.text.trim().split('\r\n')
  assert.equal(lines.length, 3)
  assert.match(lines[0], /^short_code,short_url,destination/)
  assert.ok(res.text.includes('https://example.com/one'))
})

test('an export contains only the requesting account', async () => {
  const mine = await signup()
  const theirs = await signup()
  await request(app).post('/api/links').set('Cookie', mine.toString()).send({ url: 'example.com/mine' })
  await request(app).post('/api/links').set('Cookie', theirs.toString()).send({ url: 'example.com/secret-other' })

  const res = await request(app).get('/api/export?type=links').set('Cookie', mine)
  assert.ok(res.text.includes('example.com/mine'))
  assert.ok(!res.text.includes('secret-other'), 'another account must never appear in an export')
})

test('a destination cannot execute as a spreadsheet formula', async () => {
  const cookie = await signup()
  // Titles are free text, so this is the realistic injection route.
  await request(app)
    .post('/api/links')
    .set('Cookie', cookie)
    .send({ url: 'example.com/sale', title: '=HYPERLINK("http://evil.example","click")' })

  const res = await request(app).get('/api/export?type=links').set('Cookie', cookie)
  assert.ok(!/,=HYPERLINK/.test(res.text), 'a leading = must be neutralised')
  assert.ok(res.text.includes("'=HYPERLINK"), 'and the text itself is still readable')
})

test('a value with a comma or a quote survives a round trip', async () => {
  const cookie = await signup()
  await request(app)
    .post('/api/links')
    .set('Cookie', cookie)
    .send({ url: 'example.com/q', title: 'Spring sale, "big" one' })

  const res = await request(app).get('/api/export?type=links').set('Cookie', cookie)
  assert.ok(res.text.includes('"Spring sale, ""big"" one"'))
})

test('the daily export has a row per link per day with clicks', async () => {
  const cookie = await signup()
  const made = await request(app).post('/api/links').set('Cookie', cookie).send({ url: 'example.com/daily' })
  await request(app).get(`/${made.body.slug}`).set('User-Agent', BROWSER)
  await request(app).get(`/${made.body.slug}`).set('User-Agent', 'Slackbot-LinkExpanding 1.0')

  const res = await request(app).get('/api/export?type=daily').set('Cookie', cookie)
  const lines = res.text.trim().split('\r\n')
  assert.equal(lines[0], 'date,short_code,destination,clicks,bot_clicks')
  assert.equal(lines.length, 2)
  assert.match(lines[1], new RegExp(`,${made.body.slug},.*,1,1$`), 'human and bot clicks stay separate')
})

test('the campaign export totals each campaign and names the rest', async () => {
  const cookie = await signup()
  const camp = await request(app).post('/api/campaigns').set('Cookie', cookie).send({ name: 'Spring' })
  const inCamp = await request(app)
    .post('/api/links')
    .set('Cookie', cookie)
    .send({ url: 'example.com/in', campaign: camp.body.id })
  await request(app).post('/api/links').set('Cookie', cookie).send({ url: 'example.com/out' })
  await request(app).get(`/${inCamp.body.slug}`).set('User-Agent', BROWSER)

  const res = await request(app).get('/api/export?type=campaigns').set('Cookie', cookie)
  const lines = res.text.trim().split('\r\n')
  assert.equal(lines[0], 'campaign,links,clicks,unique_visitors,bot_clicks,created_at')
  assert.ok(lines.some((l) => l.startsWith('Spring,1,1,')))
  assert.ok(lines.some((l) => l.startsWith('No campaign,1,0,')), 'links outside a campaign are not silently dropped')
})

test('exports need an account', async () => {
  assert.equal((await request(app).get('/api/export?type=links')).status, 401)
})

test('an unknown type falls back to links rather than erroring', async () => {
  const cookie = await signup()
  const res = await request(app).get('/api/export?type=../../etc/passwd').set('Cookie', cookie)
  assert.equal(res.status, 200)
  assert.match(res.headers['content-disposition'], /ashrt-links-/)
})

test('export is enforced on the server, not by hiding the button', async () => {
  // A free account that calls the endpoint directly gets the same answer the
  // UI would give it, and is told which plan includes the feature.
  const cookie = await signup('free')
  await request(app).post('/api/links').set('Cookie', cookie).send({ url: 'example.com/free-export' })

  for (const type of ['links', 'daily', 'campaigns']) {
    const res = await request(app).get(`/api/export?type=${type}`).set('Cookie', cookie)
    assert.equal(res.status, 402, `${type} must be refused`)
    assert.equal(res.body.needsUpgrade, true)
    assert.equal(res.body.upgradeTo, 'pro')
    assert.ok(!res.text.includes('short_code'), 'no rows may leak in the refusal')
  }
})
