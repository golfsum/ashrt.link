import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createFakeKV } from './helpers/fake-kv.js'

/**
 * Regressions for the bug that made a real account read "19 of 25 links used"
 * while the dashboard showed none of them.
 *
 * Two independent faults produced it. The quota counted the owner index while
 * the list read the records, so the two numbers were free to disagree; and the
 * index writes were fire-and-forget, so a failed one stranded a slug in the
 * index forever.
 *
 * The rule these tests hold the store to: the number you are shown must count
 * the things you can see.
 */

const kv = createFakeKV()
let store, users, setMetaFlag

before(async () => {
  const url = await kv.listen()
  process.env.KV_REST_API_URL = url
  process.env.KV_REST_API_TOKEN = 'fake-token'
  process.env.SESSION_SECRET = 'drift-test-secret-0123456789'
  ;({ store, users, setMetaFlag } = await import('../store.js'))
  await setMetaFlag('ownerIndexBuilt', '1')
  await users.create({ id: 'u_d', email: 'drift@example.com', createdAt: 1 })
})

after(async () => {
  kv.failWhen(null)
  await kv.close()
})

/** Strand slugs in the owner index with no record behind them. */
const strand = (owner, ...slugs) => {
  for (const s of slugs) kv.db.get(`ashrt:byowner:${owner}`).add(s)
}

test('the quota counts links you can actually see, not index membership', async () => {
  for (let i = 1; i <= 3; i++) {
    await store.add({ slug: `d${i}`, url: `https://example.com/${i}`, owner: 'u_d' })
  }
  strand('u_d', 'ghost1', 'ghost2', 'ghost3', 'ghost4')

  assert.equal(kv.db.get('ashrt:byowner:u_d').size, 7, 'the index really is inflated')

  const visible = await store.byOwner('u_d')
  const counted = await store.countByOwner('u_d')
  assert.equal(counted, visible.length, 'quota and list must be the same number')
  assert.equal(counted, 3)
})

test('reading the dashboard heals the stranded entries it found', async () => {
  strand('u_d', 'ghost5', 'ghost6')
  await store.byOwner('u_d')
  // The self-heal is fire-and-forget so the read stays fast; give it a tick.
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(kv.db.get('ashrt:byowner:u_d').size, 3, 'dead entries are dropped, live ones kept')
  const slugs = [...kv.db.get('ashrt:byowner:u_d')].sort()
  assert.deepEqual(slugs, ['d1', 'd2', 'd3'])
})

test('a deleted link leaves nothing behind in any index', async () => {
  await store.add({ slug: 'dgone', url: 'https://example.com/gone', owner: 'u_d' })
  await store.remove('dgone')
  assert.equal(kv.db.get('ashrt:byowner:u_d').has('dgone'), false)
  assert.equal(kv.db.get('ashrt:linkidx').has('dgone'), false)
  assert.equal(await store.countByOwner('u_d'), (await store.byOwner('u_d')).length)
})

test('an index write that fails is retried, not swallowed', async () => {
  // Fail the owner-index write on the first attempt only. The pipeline path
  // reports this as a per-command error, which used to be discarded silently.
  let tripped = false
  kv.failWhen((cmd) => {
    if (tripped) return false
    if (String(cmd[0]).toUpperCase() === 'SADD' && String(cmd[1]).includes('byowner')) {
      tripped = true
      return true
    }
    return false
  })

  const errors = []
  const realError = console.error
  console.error = (...a) => errors.push(a.join(' '))
  try {
    await store.add({ slug: 'dretry', url: 'https://example.com/retry', owner: 'u_d' })
  } finally {
    console.error = realError
    kv.failWhen(null)
  }

  assert.ok(tripped, 'the failure was actually injected')
  assert.ok(
    errors.some((e) => e.includes('rejected') || e.includes('pipeline failed')),
    'the failure is reported rather than hidden',
  )
  assert.ok(kv.db.get('ashrt:byowner:u_d').has('dretry'), 'the retry put it back in the index')
  const visible = await store.byOwner('u_d')
  assert.ok(visible.some((l) => l.slug === 'dretry'), 'and the owner can see it')
})

test('an index write that keeps failing says so instead of reporting success', async () => {
  kv.failWhen((cmd) => String(cmd[0]).toUpperCase() === 'SADD')

  const errors = []
  const realError = console.error
  console.error = (...a) => errors.push(a.join(' '))
  try {
    await store.add({ slug: 'dlost', url: 'https://example.com/lost', owner: 'u_d' })
  } finally {
    console.error = realError
    kv.failWhen(null)
  }

  assert.ok(
    errors.some((e) => e.includes('index write(s) lost') && e.includes('doctor')),
    'the operator is told what to run',
  )
  // The link itself still exists and still redirects: losing an index entry
  // must never lose the record.
  assert.ok(await store.get('dlost'), 'the link record survives a lost index write')
  // And the quota still matches the list, even mid-breakage.
  assert.equal(await store.countByOwner('u_d'), (await store.byOwner('u_d')).length)
})

test('a record that will not parse keeps its index entry', async () => {
  // The dangerous version of self-healing: a record that exists but cannot be
  // read looks exactly like a record that is gone. Unindexing it would hide a
  // link that still redirects, so the entry stays and the problem is logged.
  kv.db.get('ashrt:links').set('dbroken', '{not json')
  kv.db.get('ashrt:byowner:u_d').add('dbroken')

  const errors = []
  const realError = console.error
  console.error = (...a) => errors.push(a.join(' '))
  try {
    await store.byOwner('u_d')
    await new Promise((r) => setTimeout(r, 25))
  } finally {
    console.error = realError
  }

  assert.ok(kv.db.get('ashrt:byowner:u_d').has('dbroken'), 'unreadable is not the same as absent')
  assert.ok(errors.some((e) => e.includes('dbroken') && e.includes('doctor')), 'and it is reported')

  kv.db.get('ashrt:links').delete('dbroken')
  kv.db.get('ashrt:byowner:u_d').delete('dbroken')
})

test('a link that changed hands leaves the old owner index', async () => {
  await store.add({ slug: 'dmoved', url: 'https://example.com/m', owner: 'u_d' })
  // Reassign the record without touching the index, the way an older claim path
  // could have.
  const rec = JSON.parse(kv.db.get('ashrt:links').get('dmoved'))
  rec.owner = 'u_e'
  kv.db.get('ashrt:links').set('dmoved', JSON.stringify(rec))

  const mine = await store.byOwner('u_d')
  await new Promise((r) => setTimeout(r, 25))
  assert.ok(!mine.some((l) => l.slug === 'dmoved'), 'not shown to the old owner')
  assert.equal(kv.db.get('ashrt:byowner:u_d').has('dmoved'), false, 'and not counted by them either')
})

test('the admin user list counts the same links the detail page lists', async () => {
  await users.create({ id: 'u_e', email: 'other@example.com', createdAt: 2 })
  await store.add({ slug: 'e1', url: 'https://example.com/e1', owner: 'u_e' })
  strand('u_e', 'eghost1', 'eghost2', 'eghost3')

  const counts = await store.countsByOwners(['u_d', 'u_e'])
  const detailD = (await store.byOwner('u_d')).length
  const detailE = (await store.byOwner('u_e')).length

  assert.equal(counts.u_e, detailE, 'the list and the detail page must agree')
  assert.equal(counts.u_e, 1, 'stranded index entries are not links')
  assert.equal(counts.u_d, detailD)
})

test('ZRANGE over the recency index returns every link, oldest first', async () => {
  // What scripts/doctor.js reads. Negative indexes are the whole point: 0 -1
  // means everything, not nothing.
  const { redis } = await import('../lib/kv.js')
  const all = await redis(['ZRANGE', 'ashrt:linkidx', '0', '-1'])
  const rev = await redis(['ZREVRANGE', 'ashrt:linkidx', '0', '-1'])
  assert.ok(all.length >= 3)
  assert.deepEqual(all, [...rev].reverse(), 'the two directions agree')
  assert.deepEqual([...all].sort(), [...(await store.all())].map((l) => l.slug).sort())
})
