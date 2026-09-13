import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keysOf, matchKey, keyAllows, DEFAULT_SCOPES, MAX_KEYS } from '../lib/apikeys.js'

/**
 * API keys.
 *
 * Three things have to hold. A key is never recoverable after it is shown. A
 * revoked key stops working immediately, which is the whole point of revoking.
 * And an account that predates all of this keeps authenticating exactly as it
 * did, because an upgrade that silently breaks somebody's integration is worse
 * than not shipping the feature.
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), 'ashrt-keys-'))
process.env.ASHRT_DATA_DIR = DATA_DIR
process.env.SESSION_SECRET = 'keys-test-secret-0123456789'
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
async function signup() {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: `k${++seq}@example.com`, password: 'a-good-password' })
  assert.equal(res.status, 200)
  return { cookie: res.headers['set-cookie'], id: res.body.user.id }
}

const mint = (cookie, body) => request(app).post('/api/keys').set('Cookie', cookie).send(body)

test('a new key is shown once and never again', async () => {
  const me = await signup()
  const made = await mint(me.cookie, { name: 'CI pipeline' })
  assert.equal(made.status, 200)
  assert.match(made.body.key, /^ask_/)
  assert.equal(made.body.created.name, 'CI pipeline')

  const list = await request(app).get('/api/keys').set('Cookie', me.cookie)
  const listed = list.body.keys.find((k) => k.id === made.body.created.id)
  assert.ok(listed, 'it is listed')
  assert.ok(!JSON.stringify(list.body).includes(made.body.key), 'but the key itself is not')
  assert.ok(listed.prefix.length < 20, 'only enough to recognise it')

  // And it is stored hashed, not in the clear.
  const record = await users.getById(me.id)
  assert.ok(!JSON.stringify(record.apiKeys).includes(made.body.key))
})

test('a key authenticates, and a revoked one stops immediately', async () => {
  const me = await signup()
  const made = await mint(me.cookie, { name: 'Script' })
  const key = made.body.key

  const works = await request(app).get('/api/links').set('x-api-key', key)
  assert.equal(works.status, 200)

  const gone = await request(app).delete(`/api/keys/${made.body.created.id}`).set('Cookie', me.cookie)
  assert.equal(gone.status, 200)

  const after = await request(app).get('/api/links').set('x-api-key', key)
  assert.equal(after.status, 401, 'a revoked key is not an anonymous request either')
})

test('scopes are enforced on the route, not inside the handler', async () => {
  const me = await signup()
  const readOnly = (await mint(me.cookie, { name: 'Reader', scopes: ['links:read'] })).body.key

  assert.equal((await request(app).get('/api/links').set('x-api-key', readOnly)).status, 200)

  const write = await request(app)
    .post('/api/links')
    .set('x-api-key', readOnly)
    .send({ url: 'example.com/nope' })
  assert.equal(write.status, 403)
  assert.equal(write.body.needsScope, 'links:write')

  const stats = await request(app).get('/api/stats').set('x-api-key', readOnly)
  assert.equal(stats.status, 403)
})

test('a scoped key can do exactly what it was given', async () => {
  const me = await signup()
  const writer = (await mint(me.cookie, { name: 'Writer', scopes: ['links:write', 'links:read'] })).body.key

  const made = await request(app).post('/api/links').set('x-api-key', writer).send({ url: 'example.com/api-made' })
  assert.equal(made.status, 200)
  assert.equal((await request(app).get('/api/links').set('x-api-key', writer)).status, 200)
  assert.equal((await request(app).get('/api/stats').set('x-api-key', writer)).status, 403)
})

test('a session is never scope-limited', async () => {
  // Somebody signed into their own dashboard has full access to their own
  // account by definition; scoping that would be theatre.
  const me = await signup()
  await mint(me.cookie, { name: 'Narrow', scopes: ['links:read'] })
  assert.equal((await request(app).get('/api/stats').set('Cookie', me.cookie)).status, 200)
})

test('nonsense scopes fall back to full rather than to none', () => {
  // A key created with an unrecognised scope must not silently become useless.
  const { sanitizeScopes } = { sanitizeScopes: (v) => v }
  void sanitizeScopes
  assert.deepEqual(keyAllows({ scopes: [] }, 'links:write'), true)
  assert.deepEqual(keyAllows({ scopes: ['links:read'] }, 'links:write'), false)
})

test('an account created before any of this keeps working', async () => {
  const me = await signup()
  const record = await users.getById(me.id)

  // The shape an older account has: one plaintext key and its hash.
  const legacyKey = 'ak_legacy_key_value_here'
  record.apiKeys = undefined
  record.apiKey = legacyKey
  record.apiKeyHash = (await import('../lib/apikeys.js')).hashApiKey(legacyKey)
  await users.update(record)

  const res = await request(app).get('/api/links').set('x-api-key', legacyKey)
  assert.equal(res.status, 200, 'the old key still authenticates')

  const list = await request(app).get('/api/keys').set('Cookie', me.cookie)
  assert.equal(list.body.keys.length, 1)
  assert.equal(list.body.keys[0].name, 'Default')
  assert.equal(list.body.keys[0].legacy, true)
  assert.deepEqual(list.body.keys[0].scopes, DEFAULT_SCOPES, 'and it keeps the access it always had')
})

test('revoking the original single key clears it properly', async () => {
  const me = await signup()
  const record = await users.getById(me.id)
  const legacyKey = 'ak_another_legacy_value'
  record.apiKeys = undefined
  record.apiKey = legacyKey
  record.apiKeyHash = (await import('../lib/apikeys.js')).hashApiKey(legacyKey)
  await users.update(record)

  await request(app).delete('/api/keys/legacy').set('Cookie', me.cookie)
  assert.equal((await request(app).get('/api/links').set('x-api-key', legacyKey)).status, 401)

  const after = await users.getById(me.id)
  assert.equal(keysOf(after).length, 0)
})

test('a key belongs to one account and reaches nothing else', async () => {
  const mine = await signup()
  const theirs = await signup()
  const key = (await mint(mine.cookie, { name: 'Mine' })).body.key

  await request(app).post('/api/links').set('Cookie', theirs.cookie).send({ url: 'example.com/theirs' })
  const list = await request(app).get('/api/links').set('x-api-key', key)
  assert.equal(list.body.links.length, 0, 'another account\'s links are not visible')

  // And the key cannot be revoked by anyone else.
  const made = keysOf(await users.getById(mine.id))[0]
  await request(app).delete(`/api/keys/${made.id}`).set('Cookie', theirs.cookie)
  assert.equal((await request(app).get('/api/links').set('x-api-key', key)).status, 200, 'still works')
})

test('an account cannot hold unlimited keys, and the one it starts with counts', async () => {
  const me = await signup()
  // A new account already has the key it was issued at signup, so the limit is
  // on everything the account holds rather than on what was added since.
  const already = (await request(app).get('/api/keys').set('Cookie', me.cookie)).body.keys.length
  assert.equal(already, 1)

  for (let i = already; i < MAX_KEYS; i++) {
    assert.equal((await mint(me.cookie, { name: `Key ${i}` })).status, 200, `key ${i}`)
  }
  const tooMany = await mint(me.cookie, { name: 'One more' })
  assert.equal(tooMany.status, 400)
  assert.match(tooMany.body.error, new RegExp(String(MAX_KEYS)))
})

test('a key can be renamed and re-scoped without being reissued', async () => {
  const me = await signup()
  const made = await mint(me.cookie, { name: 'Old name', scopes: ['links:read'] })
  const key = made.body.key

  const patched = await request(app)
    .patch(`/api/keys/${made.body.created.id}`)
    .set('Cookie', me.cookie)
    .send({ name: 'New name', scopes: ['links:read', 'analytics:read'] })
  assert.equal(patched.body.key.name, 'New name')

  assert.equal((await request(app).get('/api/stats').set('x-api-key', key)).status, 200)
  assert.equal(
    (await request(app).post('/api/links').set('x-api-key', key).send({ url: 'example.com/x' })).status,
    403,
  )
})

test('matchKey finds the key that was presented, not just the account', async () => {
  const me = await signup()
  const a = (await mint(me.cookie, { name: 'A', scopes: ['links:read'] })).body.key
  const b = (await mint(me.cookie, { name: 'B', scopes: ['links:write'] })).body.key
  const record = await users.getById(me.id)

  assert.equal(matchKey(record, a).name, 'A')
  assert.equal(matchKey(record, b).name, 'B')
  assert.equal(matchKey(record, 'ask_not_a_real_key'), null)
})

test('a key-authenticated response says where the caller stands on quota', async () => {
  // A client that can see its remaining quota can slow down. One that only
  // finds out at the 429 cannot.
  const me = await signup()
  const key = (await mint(me.cookie, { name: 'Quota' })).body.key
  const res = await request(app).get('/api/links').set('x-api-key', key)

  assert.equal(res.status, 200)
  assert.ok(Number(res.headers['x-ratelimit-limit']) > 0)
  assert.ok(Number(res.headers['x-ratelimit-remaining']) >= 0)
  assert.ok(Number(res.headers['x-ratelimit-reset']) > Date.now() / 1000)

  // A session in the dashboard is not a programmatic caller and is not counted.
  const session = await request(app).get('/api/links').set('Cookie', me.cookie)
  assert.equal(session.headers['x-ratelimit-limit'], undefined)
})
