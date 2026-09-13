import crypto from 'node:crypto'

import { useKV, redis, pipeline } from './kv.js'
import { store, users } from '../store.js'
import { keysOf, hashApiKey } from './apikeys.js'
import { checkStored } from './urls.js'
import { audit } from './abuse.js'

/**
 * Production self-healing and abuse cleanup.
 *
 * Older records can predate the Redis indexes used by the admin screens. That
 * makes the record exist in ashrt:users / ashrt:links while being invisible to
 * the dashboard. Rebuilding the derived indexes from the records is safe and
 * idempotent: the hashes remain the source of truth and ZADD/SADD/HSET simply
 * converge the indexes on them.
 *
 * The same sweep disables links whose destination is on the built-in safety
 * denylist. An account is suspended automatically only when the evidence is
 * strong (multiple blocked links or substantial traffic to blocked links), so
 * one accidental bad destination does not lock out a legitimate customer.
 */

const RUN_EVERY_MS = 6 * 60 * 60 * 1000
const META_FIELD = 'startupMaintenanceAt'
const LOCK_KEY = 'ashrt:startup-maintenance:lock'
const LOCK_SECONDS = 300
const BATCH = 150

async function batches(commands, context) {
  for (let i = 0; i < commands.length; i += BATCH) {
    const part = commands.slice(i, i + BATCH)
    try {
      await pipeline(part)
    } catch (err) {
      console.error(`[maintenance] ${context} batch failed: ${err.message}`)
      // Retry individually. Index repair is more important than speed here,
      // and a partial pipeline must not leave a record invisible again.
      for (const cmd of part) {
        try {
          await redis(cmd)
        } catch (one) {
          console.error(`[maintenance] ${context} command failed: ${cmd[0]} ${cmd[1]} - ${one.message}`)
        }
      }
    }
  }
}

async function repairIndexes(allUsers, allLinks) {
  const commands = []

  for (const u of allUsers) {
    commands.push(['ZADD', 'ashrt:useridx', String(u.createdAt || Date.now()), u.id])
    if (u.email) commands.push(['HSET', 'ashrt:email', String(u.email).trim().toLowerCase(), u.id])
    for (const k of keysOf(u)) if (k.hash) commands.push(['HSET', 'ashrt:apikey', k.hash, u.id])
    if (u.stripeCustomerId) commands.push(['HSET', 'ashrt:stripe', u.stripeCustomerId, u.id])
    for (const o of u.oauth || []) commands.push(['HSET', 'ashrt:oauth', o, u.id])
  }

  for (const l of allLinks) {
    commands.push(['ZADD', 'ashrt:linkidx', String(l.createdAt || Date.now()), l.slug])
    if (l.owner) commands.push(['SADD', `ashrt:byowner:${l.owner}`, l.slug])
    if (l.guestTokenHash) commands.push(['HSET', 'ashrt:gtok', l.guestTokenHash, l.slug])
  }

  await batches(commands, 'index repair')

  // The owner index is now safe for normal account reads to trust.
  await redis(['HSET', 'ashrt:meta', 'ownerIndexBuilt', '1']).catch(() => {})
}

async function migrateLegacyApiKeys(allUsers) {
  let migrated = 0
  for (const u of allUsers) {
    if (!u.apiKey) continue

    // Preserve authentication by retaining the hash, but stop keeping the
    // plaintext secret in the user record. Existing clients continue to work.
    u.apiKeyHash = u.apiKeyHash || hashApiKey(u.apiKey)
    u.apiKey = null
    await users.update(u)
    migrated++
  }
  return migrated
}

async function quarantineBlockedDestinations(allUsers, allLinks) {
  const byUser = new Map()
  let disabled = 0

  for (const link of allLinks) {
    const result = checkStored(link.url, { blocked: [] })
    if (result.ok || result.reason !== 'blocked_domain') continue

    if (link.status !== 'disabled' || link.disabledReason !== 'Blocked unsafe destination') {
      link.status = 'disabled'
      link.disabledAt = link.disabledAt || Date.now()
      link.disabledBy = link.disabledBy || 'system'
      link.disabledReason = 'Blocked unsafe destination'
      await store.add(link)
      disabled++
      await audit({
        actor: null,
        action: 'link.auto_disabled',
        targetType: 'link',
        targetId: link.slug,
        meta: { reason: 'built-in blocked destination', owner: link.owner || null },
      }).catch(() => {})
    }

    if (link.owner) {
      const row = byUser.get(link.owner) || { count: 0, clicks: 0, slugs: [] }
      row.count++
      row.clicks += Number(link.clicks) || 0
      row.slugs.push(link.slug)
      byUser.set(link.owner, row)
    }
  }

  const userMap = new Map(allUsers.map((u) => [u.id, u]))
  let suspended = 0
  for (const [id, evidence] of byUser) {
    const u = userMap.get(id)
    if (!u || u.role === 'admin' || u.status === 'suspended') continue

    // Strong evidence only: repeated blocked destinations, or meaningful
    // distribution of a blocked destination. A single low-traffic mistake is
    // disabled at the link level but does not suspend the whole account.
    if (evidence.count < 2 && evidence.clicks < 100) {
      u.flags = Array.from(new Set([...(u.flags || []), 'blocked-destination']))
      await users.update(u)
      continue
    }

    u.status = 'suspended'
    u.suspendedAt = Date.now()
    u.suspendedBy = 'system'
    u.suspendedReason = `Automatic abuse quarantine: ${evidence.count} blocked link(s), ${evidence.clicks} clicks`
    u.flags = Array.from(new Set([...(u.flags || []), 'automatic-abuse-quarantine']))
    await users.update(u)
    suspended++
    await audit({
      actor: null,
      action: 'user.auto_suspended',
      targetType: 'user',
      targetId: u.id,
      meta: { blockedLinks: evidence.count, blockedClicks: evidence.clicks, slugs: evidence.slugs.slice(0, 20) },
    }).catch(() => {})
  }

  return { disabled, suspended }
}

export async function runStartupMaintenance({ force = false } = {}) {
  if (!useKV) return { skipped: true, reason: 'non-kv' }

  let last = 0
  try {
    last = Number(await redis(['HGET', 'ashrt:meta', META_FIELD])) || 0
  } catch {
    // If metadata cannot be read, attempt the repair rather than assuming the
    // indexes are healthy.
  }
  if (!force && last && Date.now() - last < RUN_EVERY_MS) {
    return { skipped: true, reason: 'recent' }
  }

  const token = crypto.randomBytes(12).toString('hex')
  let locked = false
  try {
    const reply = await redis(['SET', LOCK_KEY, token, 'NX', 'EX', String(LOCK_SECONDS)])
    locked = reply === 'OK'
  } catch {
    // A missing lock is not a reason to make admin data invisible. Continue;
    // every operation below is idempotent.
    locked = true
  }
  if (!locked) return { skipped: true, reason: 'locked' }

  try {
    const [allUsers, allLinks] = await Promise.all([users.all(), store.all()])
    await repairIndexes(allUsers, allLinks)
    const migratedApiKeys = await migrateLegacyApiKeys(allUsers)
    const abuse = await quarantineBlockedDestinations(allUsers, allLinks)
    await redis(['HSET', 'ashrt:meta', META_FIELD, String(Date.now())]).catch(() => {})
    console.log(
      `[maintenance] indexed ${allUsers.length} users / ${allLinks.length} links; ` +
        `migrated ${migratedApiKeys} legacy API keys; disabled ${abuse.disabled} blocked links; ` +
        `suspended ${abuse.suspended} abusive accounts`,
    )
    return { users: allUsers.length, links: allLinks.length, migratedApiKeys, ...abuse }
  } catch (err) {
    console.error(`[maintenance] failed: ${err.message}`)
    return { error: err.message }
  } finally {
    // Only release our own lock. If it expired and another instance acquired a
    // new one, do not delete that instance's lock.
    try {
      const current = await redis(['GET', LOCK_KEY])
      if (current === token) await redis(['DEL', LOCK_KEY])
    } catch {
      /* expires on its own */
    }
  }
}
