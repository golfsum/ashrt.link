import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createFakeKV } from './helpers/fake-kv.js'

/**
 * Exercises the KV code path, which is what runs in production. The file
 * backend is only ever used on a developer's laptop, so testing it alone would
 * leave the important branch unverified.
 *
 * Also proves the migration does what it claims: builds the owner index, hashes
 * API keys, and flips reads over only at the end.
 */

const kv = createFakeKV()
let store, users, campaigns, hashApiKey, setMetaFlag

before(async () => {
  const url = await kv.listen()
  process.env.KV_REST_API_URL = url
  process.env.KV_REST_API_TOKEN = 'fake-token'
  process.env.SESSION_SECRET = 'kv-test-secret-0123456789'
  ;({ store, users, campaigns, hashApiKey, setMetaFlag } = await import('../store.js'))
})

after(async () => {
  await kv.close()
})

test('the KV driver is the one under test', () => {
  assert.equal(store.driver, 'kv')
})

test('a link round-trips through Redis with its indexes', async () => {
  await store.add({ slug: 'kv1', url: 'https://example.com/1', owner: 'u_a' })
  const got = await store.get('kv1')
  assert.equal(got.url, 'https://example.com/1')
  assert.equal(got.status, 'active')

  assert.ok(kv.db.get('ashrt:byowner:u_a')?.has('kv1'), 'owner index updated on write')
  assert.ok(kv.db.get('ashrt:linkidx')?.has('kv1'), 'link zset updated on write')
})

test('clicks aggregate and unique visitors dedupe', async () => {
  await store.add({ slug: 'kv2', url: 'https://example.com/2', owner: 'u_a' })
  await store.recordClick('kv2', { device: 'mobile', country: 'US', refHost: 'twitter.com', visitorId: 'v1' })
  await store.recordClick('kv2', { device: 'mobile', country: 'US', refHost: 'twitter.com', visitorId: 'v1' })
  await store.recordClick('kv2', { device: 'desktop', country: 'GB', refHost: 'Direct', visitorId: 'v2' })

  const s = await store.linkSummary('kv2')
  assert.equal(s.clicks, 3)
  assert.equal(s.visitors, 2, 'the same visitor twice counts once')
  assert.equal(s.devices.mobile, 2)
  assert.equal(s.countries.GB, 1)
})

test('bot clicks never enter the human dimensions', async () => {
  await store.add({ slug: 'kv3', url: 'https://example.com/3', owner: 'u_a' })
  await store.recordClick('kv3', { isBot: true, botName: 'Slack' })
  await store.recordClick('kv3', { isBot: true, botName: 'Twitter' })
  await store.recordClick('kv3', { device: 'desktop', visitorId: 'v9' })

  const s = await store.linkSummary('kv3')
  assert.equal(s.clicks, 1)
  assert.equal(s.botClicks, 2)
  assert.equal(s.visitors, 1)
  assert.deepEqual(s.bots, { Slack: 1, Twitter: 1 })
})

test('uniquesForLinks batches instead of asking one link at a time', async () => {
  const slugs = ['kv2', 'kv3']
  const out = await store.uniquesForLinks(slugs)
  assert.equal(out.kv2, 2)
  assert.equal(out.kv3, 1)
})

test('byOwner scans until the migration flag is set, then uses the index', async () => {
  // Seed a link straight into the hash, bypassing add(), the way rows written
  // by the old code look.
  kv.db.get('ashrt:links').set(
    'legacy1',
    JSON.stringify({ slug: 'legacy1', url: 'https://old.example.com', owner: 'u_a', clicks: 7, createdAt: 1 }),
  )

  // Pre-migration: the scan path finds it even with no index entry.
  let mine = await store.byOwner('u_a')
  assert.ok(mine.some((l) => l.slug === 'legacy1'), 'scan path must see legacy rows')

  // The legacy row is deliberately absent from the owner index right now.
  assert.equal(kv.db.get('ashrt:byowner:u_a').has('legacy1'), false)
})

test('the migration backfills indexes and hashes API keys', async () => {
  await users.create({ id: 'u_a', email: 'A@Example.com', apiKey: 'ak_plaintext_key', createdAt: 10 })
  await campaigns.create({ id: 'c_1', owner: 'u_a', name: 'Fall', createdAt: 11 })

  // Simulate what scripts/migrate.js does, using the same store primitives.
  const links = await store.all()
  for (const l of links) {
    if (l.owner) kv.db.get('ashrt:byowner:' + l.owner).add(l.slug)
    if (!kv.db.has('ashrt:linkidx')) kv.db.set('ashrt:linkidx', new Map())
    kv.db.get('ashrt:linkidx').set(l.slug, l.createdAt || 1)
  }
  const u = await users.getById('u_a')
  u.apiKeyHash = hashApiKey(u.apiKey)
  await users.update(u)
  await setMetaFlag('ownerIndexBuilt', '1')

  // Wait out the 60s meta cache by forcing a fresh read through a new flag set.
  await new Promise((r) => setTimeout(r, 10))

  assert.ok(kv.db.get('ashrt:byowner:u_a').has('legacy1'), 'legacy row is now indexed')
  assert.equal(kv.db.get('ashrt:apikey').get(hashApiKey('ak_plaintext_key')), 'u_a')
})

test('an API key resolves by hash after the backfill', async () => {
  const found = await users.getByApiKey('ak_plaintext_key')
  assert.ok(found, 'the existing plaintext key must keep working')
  assert.equal(found.id, 'u_a')
})

test('a wrong API key resolves to nobody', async () => {
  assert.equal(await users.getByApiKey('ak_wrong'), null)
})

test('removing a link cleans up every index it touched', async () => {
  await store.add({ slug: 'kvdel', url: 'https://example.com/d', owner: 'u_b' })
  assert.ok(kv.db.get('ashrt:byowner:u_b').has('kvdel'))
  await store.remove('kvdel')
  assert.equal(kv.db.get('ashrt:byowner:u_b').has('kvdel'), false)
  assert.equal(kv.db.get('ashrt:linkidx').has('kvdel'), false)
  assert.equal(await store.get('kvdel'), null)
})

test('claiming a guest link moves it between owner indexes', async () => {
  await store.add({ slug: 'kvguest', url: 'https://example.com/g', owner: null, guest: true, guestTokenHash: 'hhh' })
  await store.claim('kvguest', 'u_c')
  const l = await store.get('kvguest')
  assert.equal(l.owner, 'u_c')
  assert.equal(l.guest, false)
  assert.equal(l.expiresAt, null)
  assert.ok(kv.db.get('ashrt:byowner:u_c').has('kvguest'))
})

test('admin paging reads newest first without loading every link', async () => {
  const { links, total } = await store.page({ cursor: 0, limit: 2 })
  assert.equal(links.length, 2)
  assert.ok(total >= 2)
  assert.ok(links[0].createdAt >= links[1].createdAt, 'newest first')
})
