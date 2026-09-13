/**
 * Does the index agree with the records?
 *
 * Links live in one hash; several indexes point at them (an owner set per
 * account, a recency sorted set for admin paging). The records are the truth:
 * a link exists because its record exists. When an index drifts away from that
 * truth, an account is told it has used 19 of 25 links while its dashboard
 * lists six, and nothing in the product can explain the difference.
 *
 * This module is the explanation. It reads the records, reports what each index
 * says about them, and can put the indexes back in step. It never writes a
 * link, a click count or an account, and it never deletes anything a user made.
 *
 * Both `npm run doctor` and the admin health page run this same code, so the
 * command line and the browser cannot disagree about what is wrong.
 */

import { useKV, redis, pipeline } from './kv.js'
import { store, users } from '../store.js'

/** Above this many links, stop and say so rather than pulling the whole store. */
export const MAX_SCAN = 50000

/**
 * Above this many accounts, only check accounts that own links.
 *
 * Checking an account with no links means asking Redis for a set that is
 * usually empty, which is cheap per account and expensive at a hundred
 * thousand of them. Below the threshold we check everyone, because an account
 * whose index entries are all stale owns no records and would otherwise be
 * invisible to this report - and that is precisely the case worth finding.
 */
export const MAX_ACCOUNTS_FULL = 2000

/** Raw link records: no hydration, no index, just what is stored. */
async function rawLinks() {
  if (!useKV) return { links: await store.all(), unreadable: 0 }
  const flat = (await redis(['HGETALL', 'ashrt:links'])) || []
  const links = []
  let unreadable = 0
  for (let i = 1; i < flat.length; i += 2) {
    try {
      links.push(JSON.parse(flat[i]))
    } catch {
      unreadable++
    }
  }
  return { links, unreadable }
}

/**
 * Compare every index against the records behind it.
 *
 * @param {{ user?: string|null }} opts - limit the account report to one email or id
 */
export async function checkIntegrity({ user: who = null } = {}) {
  const { links, unreadable } = await rawLinks()
  const allUsers = await users.all()
  const byId = new Map(allUsers.map((u) => [u.id, u]))

  const owned = new Map()
  let guestLinks = 0
  let orphaned = 0
  for (const l of links) {
    if (!l.owner) {
      guestLinks++
      continue
    }
    if (!byId.has(l.owner)) orphaned++
    if (!owned.has(l.owner)) owned.set(l.owner, [])
    owned.get(l.owner).push(l)
  }

  let targets
  if (who) {
    const needle = String(who).toLowerCase()
    targets = allUsers.filter((u) => u.email?.toLowerCase() === needle || u.id === who)
  } else if (allUsers.length <= MAX_ACCOUNTS_FULL) {
    targets = allUsers
  } else {
    targets = allUsers.filter((u) => (owned.get(u.id) || []).length > 0)
  }

  // One round-trip for every owner set, rather than one per account.
  const indexes = useKV
    ? await pipeline(targets.map((u) => ['SMEMBERS', `ashrt:byowner:${u.id}`]))
    : targets.map((u) => (owned.get(u.id) || []).map((l) => l.slug))

  const fixes = []
  const accounts = []

  targets.forEach((u, i) => {
    const records = owned.get(u.id) || []
    const indexed = Array.isArray(indexes[i]) ? indexes[i] : []
    const recordSlugs = new Set(records.map((l) => l.slug))
    const indexSet = new Set(indexed)

    // In the index with no record behind it: invisible forever, and it used to
    // count against the account's quota.
    const stale = indexed.filter((s) => !recordSlugs.has(s))
    // Has a record the index never learned about: still redirects, but missing
    // from its owner's dashboard.
    const missing = records.filter((l) => !indexSet.has(l.slug)).map((l) => l.slug)

    if (!records.length && !indexed.length) return

    if (useKV) {
      for (const s of stale) fixes.push(['SREM', `ashrt:byowner:${u.id}`, s])
      for (const s of missing) fixes.push(['SADD', `ashrt:byowner:${u.id}`, s])
    }

    accounts.push({
      id: u.id,
      email: u.email,
      records: records.length,
      indexed: indexed.length,
      stale,
      missing,
      healthy: !stale.length && !missing.length,
      links: [...records]
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .map((l) => ({
          slug: l.slug,
          url: l.url,
          clicks: l.clicks || 0,
          createdAt: l.createdAt || null,
          status: l.status || 'active',
          indexed: indexSet.has(l.slug),
        })),
    })
  })

  // The recency index drives admin paging, so a gap there hides a link from the
  // admin link list even when its owner can see it.
  let zsetMissing = []
  if (useKV && !who) {
    const inZset = new Set((await redis(['ZRANGE', 'ashrt:linkidx', '0', '-1'])) || [])
    for (const l of links) {
      if (inZset.has(l.slug)) continue
      zsetMissing.push(l.slug)
      fixes.push(['ZADD', 'ashrt:linkidx', String(l.createdAt || Date.now()), l.slug])
    }
  }

  return {
    driver: store.driver,
    scanned: links.length,
    truncated: links.length >= MAX_SCAN,
    unreadable,
    accountCount: allUsers.length,
    guestLinks,
    orphaned,
    zsetMissing,
    accounts: accounts.sort(
      (a, b) => Number(a.healthy) - Number(b.healthy) || b.records - a.records,
    ),
    problems: accounts.filter((a) => !a.healthy).length + (zsetMissing.length ? 1 : 0),
    fixes,
  }
}

/**
 * Apply the fixes a check produced.
 *
 * Index entries only. Nothing here can delete a link, change a destination or
 * touch a click count, which is what makes it safe to offer in a browser.
 */
export async function applyFixes(fixes) {
  let applied = 0
  for (let i = 0; i < fixes.length; i += 100) {
    const batch = fixes.slice(i, i + 100)
    const results = await pipeline(batch)
    applied += batch.filter((_, n) => results[n] !== null && results[n] !== undefined).length
  }
  return { applied, attempted: fixes.length }
}
