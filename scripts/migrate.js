#!/usr/bin/env node
/**
 * One-time backfill for the indexes and fields added in the safety pass.
 *
 * It is additive and idempotent: nothing is deleted, nothing is rewritten
 * destructively, and running it twice is harmless. Existing links, accounts,
 * click counts, campaigns and subscriptions are left exactly as they are.
 *
 * What it builds:
 *   ashrt:byowner:<uid>  set    a user's slugs, so the dashboard stops reading
 *                               every link in the system on every load
 *   ashrt:bycamp:<uid>   set    the same for campaigns
 *   ashrt:linkidx        zset   slugs by creation time, for admin paging
 *   ashrt:useridx        zset   users by creation time
 *   ashrt:apikey         hash   API keys indexed by SHA-256 instead of plaintext
 *   ashrt:gtok           hash   guest management tokens
 *   link defaults        status/guest/botClicks on records that predate them
 *   ashrt:meta           flag   ownerIndexBuilt=1, which switches reads over
 *
 * Until that final flag is set the app keeps using the old scan path, so the
 * deploy and the migration do not have to be simultaneous.
 *
 * Usage:
 *   node scripts/migrate.js --dry-run     # report only, writes nothing
 *   node scripts/migrate.js               # apply
 *   node scripts/migrate.js --yes         # apply without the confirmation pause
 */

import dotenv from 'dotenv'
dotenv.config()

const DRY = process.argv.includes('--dry-run') || process.argv.includes('-n')
const SKIP_PROMPT = process.argv.includes('--yes') || process.argv.includes('-y')

const { useKV, redis, pipeline } = await import('../lib/kv.js')
const { store, users, campaigns, hashApiKey, setMetaFlag } = await import('../store.js')

const log = (...a) => console.log(...a)
const plan = []
let writes = 0

function willWrite(what) {
  plan.push(what)
}

async function apply(commands, label) {
  if (!commands.length) return
  if (DRY) {
    willWrite(`${label}: ${commands.length} command(s)`)
    return
  }
  // Chunked so one migration of a large account does not build a giant request.
  for (let i = 0; i < commands.length; i += 100) {
    await pipeline(commands.slice(i, i + 100))
    writes += Math.min(100, commands.length - i)
  }
}

async function main() {
  log('')
  log('  ashrt.link migration')
  log('  --------------------')
  log(`  driver: ${store.driver}`)
  log(`  mode:   ${DRY ? 'DRY RUN (no writes)' : 'APPLY'}`)
  log('')

  if (!useKV) {
    log('  The KV driver is not configured, so there is nothing to migrate:')
    log('  the file backend scans on read and needs no indexes.')
    log('  Set KV_REST_API_URL and KV_REST_API_TOKEN to migrate production.')
    log('')
    return
  }

  if (!DRY && !SKIP_PROMPT) {
    log('  This writes new index keys to your production store.')
    log('  It does not modify or delete any existing link, user or click data.')
    log('  Press Ctrl+C within 5 seconds to abort.')
    log('')
    await new Promise((r) => setTimeout(r, 5000))
  }

  /* ------------------------------- links -------------------------------- */

  /**
   * Read the raw stored rows, not store.all(): that hydrates missing fields in
   * memory, so every record would look like it already has defaults and the
   * backfill would silently do nothing.
   */
  async function rawLinks() {
    const flat = (await redis(['HGETALL', 'ashrt:links'])) || []
    const out = []
    for (let i = 1; i < flat.length; i += 2) {
      try {
        out.push(JSON.parse(flat[i]))
      } catch {
        log(`    ! skipping unparseable row at field ${flat[i - 1]}`)
      }
    }
    return out
  }

  const links = await rawLinks()
  log(`  links found: ${links.length}`)

  const linkCmds = []
  const ownerCounts = new Map()
  const ownerClicks = new Map()
  let needDefaults = 0
  let guestTokens = 0

  for (const l of links) {
    const createdAt = l.createdAt || Date.now()
    linkCmds.push(['ZADD', 'ashrt:linkidx', String(createdAt), l.slug])

    if (l.owner) {
      linkCmds.push(['SADD', `ashrt:byowner:${l.owner}`, l.slug])
      ownerCounts.set(l.owner, (ownerCounts.get(l.owner) || 0) + 1)
      ownerClicks.set(l.owner, (ownerClicks.get(l.owner) || 0) + (l.clicks || 0))
    }
    if (l.guestTokenHash) {
      linkCmds.push(['HSET', 'ashrt:gtok', l.guestTokenHash, l.slug])
      guestTokens++
    }

    // Persist the fields the new code expects, so a stored row matches what is
    // read back. Purely additive: existing keys are never overwritten.
    if (l.status === undefined || l.botClicks === undefined || l.guest === undefined) {
      needDefaults++
      const filled = {
        status: 'active',
        botClicks: 0,
        guest: !l.owner,
        tags: [],
        title: null,
        expiresAt: null,
        flagScore: 0,
        flagSignals: [],
        ...l,
      }
      linkCmds.push(['HSET', 'ashrt:links', l.slug, JSON.stringify(filled)])
    }
  }

  // The per-owner click counter is maintained incrementally from now on, so it
  // has to start from the totals already on the link records. HSET, not
  // HINCRBY, so re-running does not double-count.
  for (const [owner, total] of ownerClicks) {
    linkCmds.push(['HSET', 'ashrt:clicks:owner', owner, String(total)])
  }

  log(`    owner index entries: ${ownerCounts.size} owner(s)`)
  log(`    guest tokens indexed: ${guestTokens}`)
  log(`    records needing field defaults: ${needDefaults}`)
  log(`    per-owner click totals seeded: ${ownerClicks.size}`)
  await apply(linkCmds, 'link indexes')

  /* ------------------------------- users -------------------------------- */

  const allUsers = await users.all()
  log(`  users found: ${allUsers.length}`)

  const userCmds = []
  let keysHashed = 0

  for (const u of allUsers) {
    userCmds.push(['ZADD', 'ashrt:useridx', String(u.createdAt || Date.now()), u.id])
    if (u.email) userCmds.push(['HSET', 'ashrt:email', String(u.email).toLowerCase(), u.id])
    if (u.stripeCustomerId) userCmds.push(['HSET', 'ashrt:stripe', u.stripeCustomerId, u.id])
    for (const o of u.oauth || []) userCmds.push(['HSET', 'ashrt:oauth', o, u.id])

    // Verified custom domains, so a branded host resolves without a scan.
    // Only verified ones: a pending domain must not route anything.
    for (const d of u.domains || []) {
      if (d.status === 'verified') {
        userCmds.push(['HSET', 'ashrt:domain', String(d.domain).toLowerCase(), u.id])
      }
    }

    // Index API keys by hash. The plaintext index entry is left in place so
    // keys already deployed in other apps keep working; nothing breaks today,
    // and the plaintext entries can be swept later.
    if (u.apiKey && !u.apiKeyHash) {
      const h = hashApiKey(u.apiKey)
      u.apiKeyHash = h
      userCmds.push(['HSET', 'ashrt:apikey', h, u.id])
      userCmds.push(['HSET', 'ashrt:users', u.id, JSON.stringify(u)])
      keysHashed++
    } else if (u.apiKeyHash) {
      userCmds.push(['HSET', 'ashrt:apikey', u.apiKeyHash, u.id])
    }
  }

  log(`    API keys given a hash index: ${keysHashed}`)
  await apply(userCmds, 'user indexes')

  /* ----------------------------- campaigns ------------------------------ */

  const allCampaigns = []
  for (const owner of ownerCounts.keys()) {
    for (const c of await campaigns.byOwner(owner)) allCampaigns.push(c)
  }
  const campCmds = allCampaigns.map((c) => ['SADD', `ashrt:bycamp:${c.owner}`, c.id])
  log(`  campaigns indexed: ${allCampaigns.length}`)
  await apply(campCmds, 'campaign indexes')

  /* ------------------------- flip reads to indexes ----------------------- */

  if (DRY) {
    log('')
    log('  Planned writes:')
    for (const p of plan) log(`    - ${p}`)
    log('    - set ashrt:meta ownerIndexBuilt=1 (switches reads to the index)')
    log('')
    log('  Nothing was written. Re-run without --dry-run to apply.')
  } else {
    await setMetaFlag('ownerIndexBuilt', '1')
    log('')
    log(`  Applied ${writes} index command(s).`)
    log('  ownerIndexBuilt=1: dashboard reads now use the owner index.')
  }
  log('')
}

main().catch((err) => {
  console.error('')
  console.error('  Migration failed:', err.message)
  console.error('  Nothing is half-applied in a damaging way: every write is')
  console.error('  additive, so re-running after fixing the cause is safe.')
  console.error('')
  process.exit(1)
})
