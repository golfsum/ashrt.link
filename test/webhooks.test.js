import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { sign, verify, deliver, buildDelivery, nextAttemptAt, RETRY_DELAYS_MS } from '../lib/webhooks.js'

/**
 * Webhooks.
 *
 * The deliberate omission is the first thing checked: there is no per-click
 * webhook, because an outbound request on the redirect path would make the
 * fastest part of the product depend on the slowest subscriber.
 *
 * After that: a receiver has to be able to prove a delivery is real, a
 * user-supplied URL we make requests to is an SSRF risk, and a receiver that is
 * down must not be able to hold open or fail the request that triggered the
 * event.
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), 'ashrt-webhooks-'))
process.env.ASHRT_DATA_DIR = DATA_DIR
process.env.SESSION_SECRET = 'webhook-test-secret-0123456789'
process.env.BASE_URL = 'http://localhost:4999'

let request, app, users, store, ratelimit, abuse

before(async () => {
  request = (await import('supertest')).default
  app = (await import('../server.js')).default
  ;({ users, store } = await import('../store.js'))
  ratelimit = await import('../lib/ratelimit.js')
  abuse = await import('../lib/abuse.js')
})

after(() => rmSync(DATA_DIR, { recursive: true, force: true }))
beforeEach(() => {
  ratelimit._resetMemory()
  abuse._clearCache()
})

let seq = 0
async function signup(plan = 'business') {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: `w${++seq}@example.com`, password: 'a-good-password' })
  assert.equal(res.status, 200)
  const u = await users.getById(res.body.user.id)
  u.plan = plan
  await users.update(u)
  return { cookie: res.headers['set-cookie'], id: res.body.user.id }
}

/* --------------------------------- signing -------------------------------- */

test('a delivery is signed over the exact bytes sent, with a timestamp', () => {
  const body = JSON.stringify({ event: 'link.created', data: { slug: 'abc' } })
  const { header } = sign(body, 'whsec_test')
  assert.match(header, /^t=\d+,v1=[a-f0-9]{64}$/)
  assert.equal(verify(body, header, 'whsec_test'), true)
})

test('a forged or altered delivery does not verify', () => {
  const body = JSON.stringify({ event: 'link.created' })
  const { header } = sign(body, 'whsec_real')

  assert.equal(verify(body, header, 'whsec_guessed'), false, 'wrong secret')
  assert.equal(verify(body + ' ', header, 'whsec_real'), false, 'altered body')
  assert.equal(verify(body, 't=1,v1=deadbeef', 'whsec_real'), false, 'made-up signature')
})

test('an old capture cannot be replayed', () => {
  // The timestamp is signed too, so a request captured yesterday is not
  // acceptable today.
  const body = '{"event":"link.created"}'
  const old = Math.floor(Date.now() / 1000) - 4000
  const { header } = sign(body, 'whsec_test', old)
  assert.equal(verify(body, header, 'whsec_test'), false)
  assert.equal(verify(body, header, 'whsec_test', { toleranceSec: 10000 }), true, 'unless you allow it')
})

/* -------------------------------- delivery -------------------------------- */

test('a 2xx is success and anything else is not', async () => {
  const fake = (status) => async () => ({ status })
  assert.equal((await deliver({ url: 'https://x.example', secret: 's' }, buildDelivery('link.created', {}), { fetchImpl: fake(200) })).ok, true)
  assert.equal((await deliver({ url: 'https://x.example', secret: 's' }, buildDelivery('link.created', {}), { fetchImpl: fake(204) })).ok, true)
  assert.equal((await deliver({ url: 'https://x.example', secret: 's' }, buildDelivery('link.created', {}), { fetchImpl: fake(500) })).ok, false)
  // A redirect is not followed: an endpoint that moved should be updated.
  assert.equal((await deliver({ url: 'https://x.example', secret: 's' }, buildDelivery('link.created', {}), { fetchImpl: fake(302) })).ok, false)
})

test('a URL that has become unsafe is refused at delivery, not just at save', async () => {
  let called = false
  const result = await deliver(
    { url: 'http://169.254.169.254/', secret: 's' },
    buildDelivery('link.created', {}),
    {
      fetchImpl: async () => {
        called = true
        return { status: 200 }
      },
      validate: (url) => ({ ok: !url.includes('169.254'), error: 'private address' }),
    },
  )
  assert.equal(result.ok, false)
  assert.equal(result.permanent, true, 'and it is not retried forever')
  assert.equal(called, false, 'the address is never contacted')
})

test('retries back off and then stop', () => {
  assert.equal(typeof nextAttemptAt(0), 'number')
  assert.ok(nextAttemptAt(1) > nextAttemptAt(0))
  assert.equal(nextAttemptAt(RETRY_DELAYS_MS.length), null, 'giving up is part of the design')
})

/* ------------------------------- the endpoints ---------------------------- */

test('webhooks are a Business feature, enforced on the server', async () => {
  const pro = await signup('pro')
  const res = await request(app)
    .post('/api/webhooks')
    .set('Cookie', pro.cookie)
    .send({ url: 'https://hooks.example.com/x', events: ['link.created'] })
  assert.equal(res.status, 402)
})

test('an endpoint must be https and must not point inward', async () => {
  const me = await signup()
  for (const url of ['http://hooks.example.com/x', 'https://127.0.0.1/x', 'https://169.254.169.254/']) {
    const res = await request(app)
      .post('/api/webhooks')
      .set('Cookie', me.cookie)
      .send({ url, events: ['link.created'] })
    assert.equal(res.status, 400, `${url} must be refused`)
  }
})

test('there is no per-click event to subscribe to', async () => {
  // Adding one would put an outbound HTTP request on the redirect path.
  const me = await signup()
  const list = await request(app).get('/api/webhooks').set('Cookie', me.cookie)
  const names = Object.keys(list.body.events)
  assert.ok(!names.includes('click.recorded'))
  assert.ok(names.includes('clicks.summary'), 'volume is offered as a summary instead')

  const res = await request(app)
    .post('/api/webhooks')
    .set('Cookie', me.cookie)
    .send({ url: 'https://hooks.example.com/x', events: ['click.recorded'] })
  assert.equal(res.status, 400)
})

test('the secret is shown once, at creation', async () => {
  const me = await signup()
  const made = await request(app)
    .post('/api/webhooks')
    .set('Cookie', me.cookie)
    .send({ url: 'https://hooks.example.com/one', events: ['link.created'] })
  assert.equal(made.status, 200)
  assert.match(made.body.secret, /^whsec_/)

  const list = await request(app).get('/api/webhooks').set('Cookie', me.cookie)
  assert.ok(!JSON.stringify(list.body).includes(made.body.secret), 'and not handed back afterwards')
})

test('a delivery arrives at a real server, signed over exactly what was sent', async () => {
  // deliver() is exercised against a real HTTP server rather than a stub, so
  // the headers and the signed bytes are the ones that actually go out. The
  // URL check is the caller's job and is tested separately, which is why it is
  // not passed here: the app itself would refuse this loopback address, and
  // rightly.
  const received = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      received.push({ body, headers: req.headers })
      res.writeHead(200)
      res.end('ok')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))

  try {
    const endpoint = {
      url: `http://127.0.0.1:${server.address().port}/hook`,
      secret: 'whsec_test_value',
    }
    const delivery = buildDelivery('link.created', { slug: 'abc', url: 'https://example.com/hooked' })
    const result = await deliver(endpoint, delivery)

    assert.equal(result.ok, true)
    assert.equal(received.length, 1)

    const { body, headers } = received[0]
    assert.equal(headers['x-ashrt-event'], 'link.created')
    assert.ok(headers['x-ashrt-delivery'].startsWith('evt_'))
    assert.equal(verify(body, headers['x-ashrt-signature'], 'whsec_test_value'), true)
    assert.notEqual(verify(body, headers['x-ashrt-signature'], 'whsec_wrong'), true)

    const payload = JSON.parse(body)
    assert.equal(payload.event, 'link.created')
    assert.equal(payload.data.url, 'https://example.com/hooked')
    assert.ok(payload.id && payload.createdAt, 'ids and timestamps let a receiver dedupe a retry')
  } finally {
    server.close()
  }
})

test('creating a link attempts a delivery and records what happened', async () => {
  const me = await signup()
  const user = await users.getById(me.id)
  user.webhooks = [
    {
      id: 'wh-record',
      url: 'https://hooks.example.com/records',
      secret: 'whsec_x',
      events: ['link.created'],
      active: true,
      failures: 0,
    },
  ]
  await users.update(user)

  await request(app).post('/api/links').set('Cookie', me.cookie).send({ url: 'example.com/recorded' })

  // Delivery is detached from the request on purpose, so wait for it to land.
  let after
  for (let i = 0; i < 60; i++) {
    after = await users.getById(me.id)
    if (after.webhooks[0].lastDeliveryAt) break
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.ok(after.webhooks[0].lastDeliveryAt, 'the attempt is recorded even though it failed')
  assert.ok(after.webhooks[0].failures >= 1, 'and counted, which is what eventually disables it')
})

test('a receiver that is down neither fails nor slows the request', async () => {
  const me = await signup()
  const user = await users.getById(me.id)
  user.webhooks = [
    {
      id: 'wh-dead',
      // Nothing listens here.
      url: 'https://127.0.0.1:9/hook',
      secret: 'whsec_x',
      events: ['link.created'],
      active: true,
      failures: 0,
    },
  ]
  await users.update(user)

  const started = Date.now()
  const made = await request(app).post('/api/links').set('Cookie', me.cookie).send({ url: 'example.com/still-ok' })
  assert.equal(made.status, 200, 'the link is created regardless')
  assert.ok(Date.now() - started < 3000, 'and the caller does not wait for the receiver')
})

test('an endpoint that keeps failing is switched off with a reason', async () => {
  const me = await signup()
  const user = await users.getById(me.id)
  user.webhooks = [
    {
      id: 'wh-bad',
      url: 'https://hooks.example.com/bad',
      secret: 'whsec_x',
      events: ['link.created'],
      active: true,
      failures: 9,
    },
  ]
  await users.update(user)

  await request(app).post('/api/links').set('Cookie', me.cookie).send({ url: 'example.com/tenth' })
  for (let i = 0; i < 60; i++) {
    const now = await users.getById(me.id)
    if (now.webhooks[0].active === false) break
    await new Promise((r) => setTimeout(r, 50))
  }

  const after = await users.getById(me.id)
  assert.equal(after.webhooks[0].active, false)
  assert.match(after.webhooks[0].disabledReason, /failed deliveries/)
})

test('turning an endpoint back on clears the failure count', async () => {
  const me = await signup()
  const made = await request(app)
    .post('/api/webhooks')
    .set('Cookie', me.cookie)
    .send({ url: 'https://hooks.example.com/two', events: ['link.created'] })

  const user = await users.getById(me.id)
  user.webhooks[0].active = false
  user.webhooks[0].failures = 10
  user.webhooks[0].disabledReason = 'Switched off'
  await users.update(user)

  const res = await request(app)
    .patch(`/api/webhooks/${made.body.webhook.id}`)
    .set('Cookie', me.cookie)
    .send({ active: true })
  assert.equal(res.body.webhook.active, true)
  assert.equal(res.body.webhook.failures, 0)
  assert.equal(res.body.webhook.disabledReason, null)
})

test('endpoints belong to one account', async () => {
  const mine = await signup()
  const theirs = await signup()
  const made = await request(app)
    .post('/api/webhooks')
    .set('Cookie', mine.cookie)
    .send({ url: 'https://hooks.example.com/private', events: ['link.created'] })

  const list = await request(app).get('/api/webhooks').set('Cookie', theirs.cookie)
  assert.deepEqual(list.body.webhooks, [])

  const patched = await request(app)
    .patch(`/api/webhooks/${made.body.webhook.id}`)
    .set('Cookie', theirs.cookie)
    .send({ url: 'https://evil.example/steal' })
  assert.equal(patched.status, 404)
})

test('click volume arrives as a daily summary, and only when there is something to say', async () => {
  process.env.CRON_SECRET = 'wh-cron-secret'
  const me = await signup()
  const user = await users.getById(me.id)
  user.webhooks = [
    {
      id: 'wh-sum',
      url: 'https://hooks.example.com/summary',
      secret: 'whsec_x',
      events: ['clicks.summary'],
      active: true,
      failures: 0,
    },
  ]
  await users.update(user)

  const run = () =>
    request(app).get('/api/cron/health-check').set('Authorization', 'Bearer wh-cron-secret')

  // No clicks yet: a daily "0 clicks" webhook is noise that gets an endpoint
  // muted, so nothing is sent.
  const quiet = await run()
  assert.equal(quiet.body.summaries?.sent || 0, 0)

  const made = await request(app).post('/api/links').set('Cookie', me.cookie).send({ url: 'example.com/summed' })
  await request(app).get(`/${made.body.slug}`).set('User-Agent', 'Mozilla/5.0 Chrome/120 Safari/537.36')

  const busy = await run()
  assert.equal(busy.body.summaries.sent, 1)

  // And not again the same day: this is a digest, not a feed.
  const again = await run()
  assert.equal(again.body.summaries.sent, 0)
})
