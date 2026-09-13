import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The admin surface. Two things are being checked here and they matter in
 * different ways:
 *
 *   1. Nobody without the role can reach any of it, and nothing leaks a secret.
 *   2. The actions actually do what the button says, and leave an audit trail.
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), 'ashrt-admin-'))
process.env.ASHRT_DATA_DIR = DATA_DIR
process.env.SESSION_SECRET = 'admin-test-secret-0123456789'
process.env.BASE_URL = 'http://localhost:4999'
process.env.ADMIN_EMAILS = 'root@ashrt.link'

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

/* -------------------------------- helpers -------------------------------- */

let seq = 0
async function signup(overrides = {}) {
  const email = overrides.email || `member${++seq}@example.com`
  const res = await request(app)
    .post('/auth/register')
    .send({ email, password: 'a-good-password', name: 'Member', ...overrides })
  assert.equal(res.status, 200, `signup failed: ${JSON.stringify(res.body)}`)
  return { email, cookie: res.headers['set-cookie'], user: res.body.user }
}

let rootMade = false
async function asRoot() {
  const creds = { email: 'root@ashrt.link', password: 'a-good-password' }
  if (!rootMade) {
    rootMade = true
    return signup(creds)
  }
  const res = await request(app).post('/auth/login').send(creds)
  assert.equal(res.status, 200)
  return { cookie: res.headers['set-cookie'], user: res.body.user }
}

const adminGet = (cookie, path) => request(app).get(path).set('Cookie', cookie)
const adminPatch = (cookie, path, body) => request(app).patch(path).set('Cookie', cookie).send(body)

/* ------------------------------ authorization ----------------------------- */

test('every admin route is invisible without the role', async () => {
  const member = await signup()
  const paths = [
    '/api/admin/overview',
    '/api/admin/users',
    '/api/admin/users/u_whatever',
    '/api/admin/links',
    '/api/admin/abuse',
    '/api/admin/blocked',
    '/api/admin/audit',
    '/api/admin/health',
  ]
  for (const path of paths) {
    assert.equal((await request(app).get(path)).status, 401, `${path} anonymous`)
    assert.equal((await adminGet(member.cookie, path)).status, 404, `${path} as a normal user`)
  }
})

test('admin writes are refused for a normal user too, not just the reads', async () => {
  const member = await signup()
  const victim = await signup()
  const made = await request(app).post('/api/links').set('Cookie', victim.cookie).send({ url: 'example.com/x' })

  const attempts = [
    adminPatch(member.cookie, `/api/admin/users/${victim.user.id}`, { action: 'suspend' }),
    adminPatch(member.cookie, `/api/admin/links/${made.body.slug}`, { action: 'disable' }),
    request(app).post('/api/admin/blocked').set('Cookie', member.cookie).send({ domain: 'example.com' }),
    request(app).delete(`/api/admin/links/${made.body.slug}`).set('Cookie', member.cookie).send({ confirm: made.body.slug }),
  ]
  for (const res of await Promise.all(attempts)) {
    assert.equal(res.status, 404)
  }

  // And nothing actually happened.
  const still = await store.get(made.body.slug)
  assert.equal(still.status, 'active')
  const v = await users.getById(victim.user.id)
  assert.notEqual(v.status, 'suspended')
})

test('admin responses never contain a password hash or an API key', async () => {
  const root = await asRoot()
  const member = await signup()
  await request(app).post('/api/links').set('Cookie', member.cookie).send({ url: 'example.com/leak' })

  for (const path of ['/api/admin/users', `/api/admin/users/${member.user.id}`, '/api/admin/links']) {
    const res = await adminGet(root.cookie, path)
    assert.equal(res.status, 200, path)
    const body = JSON.stringify(res.body)
    assert.ok(!body.includes('passwordHash'), `${path} leaked a password hash`)
    assert.ok(!/"apiKey"/.test(body), `${path} leaked an API key`)
    assert.ok(!/"apiKeyHash"/.test(body), `${path} leaked an API key hash`)
    assert.ok(!body.includes('$2a$') && !body.includes('$2b$'), `${path} leaked a bcrypt hash`)
  }
})

/* -------------------------------- overview -------------------------------- */

test('the overview reports real numbers, not placeholders', async () => {
  const root = await asRoot()
  const member = await signup()
  const made = await request(app).post('/api/links').set('Cookie', member.cookie).send({ url: 'example.com/counted' })
  await request(app).get(`/${made.body.slug}`).set('User-Agent', 'Mozilla/5.0 Chrome/120')

  const res = await adminGet(root.cookie, '/api/admin/overview')
  assert.equal(res.status, 200)
  assert.ok(res.body.users.total >= 2)
  assert.ok(res.body.links.total >= 1)
  assert.ok(res.body.clicks.total >= 1)
  assert.equal(typeof res.body.users.free, 'number')
  assert.ok(Object.keys(res.body.series).length > 0, 'the chart series should be filled in')
})

/* ------------------------------ user management --------------------------- */

test('suspending an account stops it working, and restoring brings it back', async () => {
  const root = await asRoot()
  const member = await signup()

  const suspended = await adminPatch(root.cookie, `/api/admin/users/${member.user.id}`, {
    action: 'suspend',
    reason: 'spamming',
  })
  assert.equal(suspended.status, 200)
  assert.equal(suspended.body.user.status, 'suspended')

  assert.equal((await request(app).get('/auth/me').set('Cookie', member.cookie)).status, 401)

  const restored = await adminPatch(root.cookie, `/api/admin/users/${member.user.id}`, { action: 'restore' })
  assert.equal(restored.body.user.status, 'active')
  assert.equal((await request(app).get('/auth/me').set('Cookie', member.cookie)).status, 200)
})

test('an admin cannot suspend or demote their own account', async () => {
  const root = await asRoot()
  for (const action of ['suspend', 'demote']) {
    const res = await adminPatch(root.cookie, `/api/admin/users/${root.user.id}`, { action })
    assert.equal(res.status, 400, `${action} on self should be refused`)
  }
  assert.equal((await adminGet(root.cookie, '/api/admin/overview')).status, 200, 'still an admin')
})

/** Mint a key the way the developers page does. The plaintext is shown once. */
async function newKey(cookie, name = 'Test key') {
  const res = await request(app).post('/api/keys').set('Cookie', cookie).send({ name })
  assert.equal(res.status, 200, `key creation failed: ${JSON.stringify(res.body)}`)
  return res.body.key
}

test('disabling API access blocks the key but leaves the session working', async () => {
  const root = await asRoot()
  const member = await signup()
  const key = await newKey(member.cookie)

  assert.equal((await request(app).get('/api/account').set('x-api-key', key)).status, 200)

  await adminPatch(root.cookie, `/api/admin/users/${member.user.id}`, { action: 'disable-api' })
  assert.equal((await request(app).get('/api/account').set('x-api-key', key)).status, 401)
  assert.equal((await request(app).get('/api/account').set('Cookie', member.cookie)).status, 200)

  await adminPatch(root.cookie, `/api/admin/users/${member.user.id}`, { action: 'enable-api' })
  assert.equal((await request(app).get('/api/account').set('x-api-key', key)).status, 200)
})

test('revoking a key invalidates the old one', async () => {
  const root = await asRoot()
  const member = await signup()
  const before = await newKey(member.cookie, 'To be revoked')
  assert.equal((await request(app).get('/api/account').set('x-api-key', before)).status, 200)

  const res = await adminPatch(root.cookie, `/api/admin/users/${member.user.id}`, { action: 'revoke-key' })
  assert.equal(res.status, 200)
  assert.ok(!JSON.stringify(res.body).includes(before), 'the response must not echo the old key')

  assert.equal((await request(app).get('/api/account').set('x-api-key', before)).status, 401)
})

test('the account endpoint never hands back a key', async () => {
  // Keys are hashed at rest and shown once, at creation. An endpoint that
  // returns one on request makes the hashing pointless.
  const member = await signup()
  await newKey(member.cookie)
  const account = await request(app).get('/api/account').set('Cookie', member.cookie)
  assert.equal(account.status, 200)
  assert.ok(!/ask_|"apiKey"/.test(JSON.stringify(account.body)), 'no key material in the account payload')
})

test('admin notes are stored and stripped of tag characters', async () => {
  const root = await asRoot()
  const member = await signup()
  await adminPatch(root.cookie, `/api/admin/users/${member.user.id}`, {
    action: 'note',
    reason: 'chargeback <script>alert(1)</script> risk',
  })
  const detail = await adminGet(root.cookie, `/api/admin/users/${member.user.id}`)
  const note = detail.body.user.notes.at(-1)
  assert.match(note.text, /chargeback/)
  assert.ok(!note.text.includes('<'), 'tag characters should be stripped from notes')
  assert.equal(note.byEmail, 'root@ashrt.link')
})

test('user search finds an account by email', async () => {
  const root = await asRoot()
  const member = await signup({ email: 'findable@example.com' })
  const res = await adminGet(root.cookie, '/api/admin/users?q=findable')
  assert.equal(res.status, 200)
  assert.equal(res.body.users.length, 1)
  assert.equal(res.body.users[0].id, member.user.id)
})

test('the user list carries per-account link and click totals', async () => {
  const root = await asRoot()
  const member = await signup()
  const made = await request(app).post('/api/links').set('Cookie', member.cookie).send({ url: 'example.com/tally' })
  await request(app).get(`/${made.body.slug}`).set('User-Agent', 'Mozilla/5.0 Chrome/120')

  const res = await adminGet(root.cookie, `/api/admin/users?q=${member.email}`)
  const row = res.body.users[0]
  assert.equal(row.links, 1)
  assert.ok(row.clicks >= 1)
})

test('a user detail page shows their links and usage', async () => {
  const root = await asRoot()
  const member = await signup()
  await request(app).post('/api/links').set('Cookie', member.cookie).send({ url: 'example.com/detail' })

  const res = await adminGet(root.cookie, `/api/admin/users/${member.user.id}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.links.length, 1)
  assert.equal(res.body.user.links, 1)
  assert.equal(typeof res.body.user.apiCallsThisMonth, 'number')
  assert.equal(res.body.user.hasApiKey, true)
})

/* ------------------------------ link management --------------------------- */

test('admin link search matches a destination, not only a short code', async () => {
  const root = await asRoot()
  const member = await signup()
  await request(app).post('/api/links').set('Cookie', member.cookie).send({ url: 'https://very-distinctive-domain.com/x' })

  const res = await adminGet(root.cookie, '/api/admin/links?q=very-distinctive-domain')
  assert.equal(res.status, 200)
  assert.equal(res.body.links.length, 1)
  assert.match(res.body.links[0].url, /very-distinctive-domain/)
})

test('the admin link list resolves owner emails', async () => {
  const root = await asRoot()
  const member = await signup({ email: 'owner-lookup@example.com' })
  const made = await request(app).post('/api/links').set('Cookie', member.cookie).send({ url: 'example.com/owned' })

  const res = await adminGet(root.cookie, `/api/admin/links?q=${made.body.slug}`)
  const link = res.body.links[0]
  assert.equal(res.body.owners[link.owner].email, 'owner-lookup@example.com')
})

test('links can be filtered by status', async () => {
  const root = await asRoot()
  const member = await signup()
  const made = await request(app).post('/api/links').set('Cookie', member.cookie).send({ url: 'example.com/tobedisabled' })
  await adminPatch(root.cookie, `/api/admin/links/${made.body.slug}`, { action: 'disable', reason: 'test' })

  const res = await adminGet(root.cookie, '/api/admin/links?status=disabled')
  assert.ok(res.body.links.some((l) => l.slug === made.body.slug))
  assert.ok(res.body.links.every((l) => l.status === 'disabled'))
})

test('deleting a link requires naming it again', async () => {
  const root = await asRoot()
  const member = await signup()
  const made = await request(app).post('/api/links').set('Cookie', member.cookie).send({ url: 'example.com/doomed' })
  const slug = made.body.slug

  const noConfirm = await request(app).delete(`/api/admin/links/${slug}`).set('Cookie', root.cookie).send({})
  assert.equal(noConfirm.status, 400)
  assert.ok(await store.get(slug), 'still there')

  const wrongConfirm = await request(app)
    .delete(`/api/admin/links/${slug}`)
    .set('Cookie', root.cookie)
    .send({ confirm: 'something-else' })
  assert.equal(wrongConfirm.status, 400)
  assert.ok(await store.get(slug), 'still there')

  const ok = await request(app).delete(`/api/admin/links/${slug}`).set('Cookie', root.cookie).send({ confirm: slug })
  assert.equal(ok.status, 200)
  assert.equal(await store.get(slug), null)
})

/* -------------------------------- abuse ----------------------------------- */

test('the abuse view gathers reports, flagged links and blocked domains', async () => {
  const root = await asRoot()
  const made = await request(app).post('/api/links').set('Cookie', root.cookie).send({ url: 'example.com/abusive' })
  await request(app).post('/api/report').set('X-Forwarded-For', '203.0.113.200').send({ link: made.body.slug, reason: 'phishing' })
  await request(app).post('/api/admin/blocked').set('Cookie', root.cookie).send({ domain: 'blockme.example', reason: 'phishing' })
  await adminPatch(root.cookie, `/api/admin/links/${made.body.slug}`, { action: 'flag', reason: 'manual' })

  const res = await adminGet(root.cookie, '/api/admin/abuse')
  assert.equal(res.status, 200)
  assert.ok(res.body.reports.some((r) => r.slug === made.body.slug))
  assert.ok(res.body.blocked.some((b) => b.domain === 'blockme.example'))
  assert.ok(res.body.flagged.some((l) => l.slug === made.body.slug))
})

test('blocking a domain from the admin API stops new and existing links', async () => {
  const root = await asRoot()
  const made = await request(app).post('/api/links').set('Cookie', root.cookie).send({ url: 'soon-blocked.example/page' })
  assert.equal((await request(app).get(`/${made.body.slug}`).set('User-Agent', 'Mozilla/5.0 Chrome/120')).status, 302)

  await request(app).post('/api/admin/blocked').set('Cookie', root.cookie).send({ domain: 'soon-blocked.example' })
  abuse._clearCache()

  assert.equal((await request(app).get(`/${made.body.slug}`).set('User-Agent', 'Mozilla/5.0 Chrome/120')).status, 410)
  assert.equal((await request(app).post('/api/links').send({ url: 'soon-blocked.example/other' })).status, 400)

  await request(app).delete('/api/admin/blocked/soon-blocked.example').set('Cookie', root.cookie)
  abuse._clearCache()
  assert.equal((await request(app).get(`/${made.body.slug}`).set('User-Agent', 'Mozilla/5.0 Chrome/120')).status, 302)
})

test('a report can be worked through its statuses', async () => {
  const root = await asRoot()
  const made = await request(app).post('/api/links').set('Cookie', root.cookie).send({ url: 'example.com/triage' })
  await request(app).post('/api/report').set('X-Forwarded-For', '203.0.113.201').send({ link: made.body.slug, reason: 'spam' })

  const list = await adminGet(root.cookie, '/api/admin/abuse?status=new')
  const report = list.body.reports.find((r) => r.slug === made.body.slug)
  assert.ok(report)

  const reviewing = await adminPatch(root.cookie, `/api/admin/abuse/reports/${report.id}`, {
    status: 'reviewing',
    note: 'looking at it',
  })
  assert.equal(reviewing.body.report.status, 'reviewing')

  const done = await adminPatch(root.cookie, `/api/admin/abuse/reports/${report.id}`, { status: 'dismissed' })
  assert.equal(done.body.report.status, 'dismissed')
  assert.ok(done.body.report.resolvedAt)
})

/* -------------------------------- audit log ------------------------------- */

test('every admin action lands in the audit log with an actor', async () => {
  const root = await asRoot()
  const member = await signup()
  const made = await request(app).post('/api/links').set('Cookie', member.cookie).send({ url: 'example.com/audit-me' })

  await adminPatch(root.cookie, `/api/admin/users/${member.user.id}`, { action: 'suspend', reason: 'audit test' })
  await adminPatch(root.cookie, `/api/admin/users/${member.user.id}`, { action: 'restore' })
  await adminPatch(root.cookie, `/api/admin/links/${made.body.slug}`, { action: 'disable', reason: 'audit test' })
  await request(app).post('/api/admin/blocked').set('Cookie', root.cookie).send({ domain: 'audited.example' })

  const res = await adminGet(root.cookie, '/api/admin/audit')
  const actions = res.body.entries.map((e) => e.action)
  for (const expected of ['user.suspend', 'user.restore', 'link.disable', 'domain.blocked']) {
    assert.ok(actions.includes(expected), `${expected} should be in the audit log`)
  }
  for (const entry of res.body.entries) {
    if (entry.action.startsWith('user.') || entry.action === 'link.disable') {
      assert.equal(entry.actorEmail, 'root@ashrt.link')
    }
  }
})

test('the audit log records a deletion with enough context to understand it', async () => {
  const root = await asRoot()
  const made = await request(app).post('/api/links').set('Cookie', root.cookie).send({ url: 'https://example.com/gone-forever' })
  await request(app).delete(`/api/admin/links/${made.body.slug}`).set('Cookie', root.cookie).send({ confirm: made.body.slug })

  const res = await adminGet(root.cookie, '/api/admin/audit?action=link.delete')
  const entry = res.body.entries.find((e) => e.targetId === made.body.slug)
  assert.ok(entry, 'the deletion should be logged')
  assert.equal(entry.meta.url, 'https://example.com/gone-forever')
})

/* -------------------------------- billing --------------------------------- */

test('the billing report is admin-only', async () => {
  const member = await signup()
  assert.equal((await request(app).get('/api/admin/billing')).status, 401)
  assert.equal((await adminGet(member.cookie, '/api/admin/billing')).status, 404)
})

test('billing reports plan mix and says its MRR is an estimate', async () => {
  const root = await asRoot()
  const res = await adminGet(root.cookie, '/api/admin/billing')
  assert.equal(res.status, 200)

  assert.equal(typeof res.body.byPlan.free, 'number')
  assert.equal(typeof res.body.estimatedMrr, 'number')
  assert.equal(res.body.estimatedArr, res.body.estimatedMrr * 12)
  // The number is derived, not read from Stripe, and the payload has to say so
  // rather than letting the UI present it as authoritative.
  assert.match(res.body.note, /estimated/i)
  assert.match(res.body.note, /Stripe is the source of truth/i)
})

test('MRR counts only active paid subscriptions', async () => {
  const root = await asRoot()
  const paying = await signup()
  const lapsed = await signup()

  const a = await users.getById(paying.user.id)
  a.plan = 'pro'
  a.subscriptionStatus = 'active'
  a.stripeCustomerId = 'cus_ok'
  await users.update(a)

  const b = await users.getById(lapsed.user.id)
  b.plan = 'pro'
  b.subscriptionStatus = 'past_due'
  b.stripeCustomerId = 'cus_bad'
  await users.update(b)

  const res = await adminGet(root.cookie, '/api/admin/billing')
  assert.equal(res.body.estimatedMrr, 9, 'the past-due account must not be counted as revenue')
  assert.equal(res.body.byPlan.pro, 2, 'but it is still on the pro plan')
})

test('billing surfaces accounts a human needs to look at', async () => {
  const root = await asRoot()
  const failing = await signup()
  const orphaned = await signup()

  const a = await users.getById(failing.user.id)
  a.plan = 'pro'
  a.subscriptionStatus = 'past_due'
  a.stripeCustomerId = 'cus_failing'
  await users.update(a)

  // A paid plan with no Stripe customer means our records and Stripe's have
  // drifted apart, which is worth knowing about before the customer complains.
  const b = await users.getById(orphaned.user.id)
  b.plan = 'business'
  await users.update(b)

  const res = await adminGet(root.cookie, '/api/admin/billing')
  const reasons = Object.fromEntries(res.body.problems.map((p) => [p.email, p.reason]))
  assert.equal(reasons[failing.email], 'payment failing')
  assert.equal(reasons[orphaned.email], 'paid plan with no Stripe customer')
})

test('the billing report leaks no card or key data', async () => {
  const root = await asRoot()
  const res = await adminGet(root.cookie, '/api/admin/billing')
  const body = JSON.stringify(res.body)
  for (const leak of ['passwordHash', 'apiKey', 'apiKeyHash', '$2a$', '$2b$']) {
    assert.ok(!body.includes(leak), `billing leaked ${leak}`)
  }
})

/* ------------------------- bootstrap role consistency --------------------- */

/**
 * The bug this guards against: ADMIN_EMAILS granted access server-side, but
 * /auth/me computed `role` from the stored record alone and reported "user".
 * The server let the admin page load and the page then redirected the person
 * straight back out, which looks exactly like "admin is broken".
 */
test('an allowlisted account is reported as an admin, not just treated as one', async () => {
  // An account that exists with no role on its record, the way one does when
  // ADMIN_EMAILS is added after the account was created.
  const late = await signup({ email: 'root@ashrt.link' }).catch(async () => {
    const res = await request(app).post('/auth/login').send({ email: 'root@ashrt.link', password: 'a-good-password' })
    return { cookie: res.headers['set-cookie'], user: res.body.user }
  })

  const record = await users.getById(late.user.id)
  record.role = 'user' // simulate a record predating the allowlist
  await users.update(record)

  // The server still lets them in...
  assert.equal((await adminGet(late.cookie, '/api/admin/overview')).status, 200)

  // ...and /auth/me must agree, or the page bounces them.
  const me = await request(app).get('/auth/me').set('Cookie', late.cookie)
  assert.equal(me.body.user.role, 'admin', 'the client is told the same thing the server enforces')
})

test('reading /auth/me persists the granted role so the env var can be removed', async () => {
  const root = await asRoot()
  const record = await users.getById(root.user.id)
  record.role = 'user'
  await users.update(record)

  await request(app).get('/auth/me').set('Cookie', root.cookie)

  const after = await users.getById(root.user.id)
  assert.equal(after.role, 'admin', 'the role should be written to the record, not recomputed forever')
})

test('a normal account is never reported as an admin', async () => {
  const member = await signup()
  const me = await request(app).get('/auth/me').set('Cookie', member.cookie)
  assert.equal(me.body.user.role, 'user')

  const record = await users.getById(member.user.id)
  assert.notEqual(record.role, 'admin', 'and nothing promoted them on the way through')
})

/* ------------------------------ storage health ---------------------------- */

test('health names the links an account owns, so a count can be checked against a list', async () => {
  const root = await asRoot()
  const member = await signup()
  const made = await request(app)
    .post('/api/links')
    .set('Cookie', member.cookie)
    .send({ url: 'example.com/health-check' })
  assert.equal(made.status, 200)

  const res = await adminGet(root.cookie, `/api/admin/health?user=${encodeURIComponent(member.email)}`)
  assert.equal(res.status, 200)

  const account = res.body.accounts.find((a) => a.email === member.email)
  assert.ok(account, 'the account asked about is in the report')
  assert.equal(account.records, account.links.length, 'the number and the list are the same thing')
  assert.ok(
    account.links.some((l) => l.slug === made.body.slug),
    'and the list names the actual short code',
  )
})

test('rebuilding indexes is refused without the confirmation', async () => {
  const root = await asRoot()
  const res = await request(app).post('/api/admin/health/repair').set('Cookie', root.cookie).send({})
  assert.equal(res.status, 400)

  const member = await signup()
  const asMember = await request(app)
    .post('/api/admin/health/repair')
    .set('Cookie', member.cookie)
    .send({ confirm: 'repair' })
  assert.equal(asMember.status, 404, 'and a normal account cannot reach it at all')
})

test('the health report carries no secrets', async () => {
  const root = await asRoot()
  const res = await adminGet(root.cookie, '/api/admin/health')
  assert.equal(res.status, 200)
  const body = JSON.stringify(res.body).toLowerCase()
  for (const secret of ['password', 'apikey', 'stripe', 'secret']) {
    assert.ok(!body.includes(secret), `${secret} must not appear in the health report`)
  }
})

test('a suspended allowlisted account is not an admin', async () => {
  const root = await asRoot()
  const record = await users.getById(root.user.id)
  record.status = 'suspended'
  await users.update(record)

  assert.equal((await request(app).get('/auth/me').set('Cookie', root.cookie)).status, 401)
  assert.equal((await adminGet(root.cookie, '/api/admin/overview')).status, 401)

  record.status = 'active'
  await users.update(record)
})
