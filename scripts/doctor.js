#!/usr/bin/env node
/**
 * Inspect and repair the link store.
 *
 * Written for a specific class of problem: a number that disagrees with a list.
 * "You have used 19 of 25 links" while the dashboard shows none of them means
 * the owner index and the link records have drifted apart, and until now there
 * was no way to see which of the two was lying.
 *
 * The checking itself lives in lib/integrity.js, which the admin health page
 * also uses, so this command and the browser always say the same thing.
 *
 * Usage:
 *   npm run doctor                  # report on every account
 *   npm run doctor -- --user you@example.com
 *   npm run doctor -- --repair      # rebuild the indexes from the records
 */

import dotenv from 'dotenv'
dotenv.config()

const args = process.argv.slice(2)
const REPAIR = args.includes('--repair')
const wants = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : null
}
const WHO = wants('--user')

const { checkIntegrity, applyFixes } = await import('../lib/integrity.js')

const log = (...a) => console.log(...a)
const pad = (s, n) => String(s).padEnd(n)
const some = (list, n = 8) =>
  `${list.slice(0, n).join(', ')}${list.length > n ? `, +${list.length - n} more` : ''}`

async function main() {
  const report = await checkIntegrity({ user: WHO })

  log('')
  log('  ashrt.link doctor')
  log('  -----------------')
  log(`  driver: ${report.driver}${REPAIR ? '   mode: REPAIR' : ''}`)
  log(`  ${report.scanned} link record(s), ${report.accountCount} account(s)`)
  log(`  ${report.guestLinks} guest link(s), ${report.orphaned} link(s) whose owner no longer exists`)
  if (report.unreadable) {
    log(`  ${report.unreadable} record(s) could not be read. Those are left strictly alone.`)
  }
  if (report.truncated) log('  (scan limit reached: the report may be partial)')
  log('')

  if (WHO && !report.accounts.length) {
    log(`  No account matches "${WHO}", or it owns nothing and is indexed for nothing.`)
    log('')
    return
  }

  for (const a of report.accounts) {
    log(`  ${a.email}`)
    log(`    real links (records):  ${a.records}`)
    log(`    index says:            ${a.indexed}${a.healthy ? '' : '   <-- disagrees'}`)
    if (a.stale.length) log(`    stale index entries:   ${a.stale.length}  (${some(a.stale)})`)
    if (a.missing.length) log(`    missing from index:    ${a.missing.length}  (${some(a.missing)})`)

    if (a.links.length) {
      log('')
      log(`    ${pad('SHORT CODE', 14)}${pad('CLICKS', 8)}${pad('CREATED', 13)}DESTINATION`)
      for (const l of a.links) {
        const created = l.createdAt ? new Date(l.createdAt).toISOString().slice(0, 10) : '-'
        const dest = String(l.url || '').replace(/^https?:\/\//, '').slice(0, 60)
        const flag = l.indexed ? '' : '  (hidden: not indexed)'
        log(`    ${pad('/' + l.slug, 14)}${pad(l.clicks, 8)}${pad(created, 13)}${dest}${flag}`)
      }
    }
    log('')
  }

  if (report.zsetMissing.length) {
    log(`  ${report.zsetMissing.length} link(s) missing from the recency index (admin paging)`)
    log(`    ${some(report.zsetMissing)}`)
    log('')
  }

  if (report.driver !== 'kv') {
    log('  The file backend reads records directly and keeps no index, so there')
    log('  is nothing here that can drift. Point this at production to check KV.')
    log('')
    return
  }

  if (!report.fixes.length) {
    log('  Indexes agree with the records. Nothing to fix.')
    log('')
    return
  }

  if (!REPAIR) {
    log(`  ${report.fixes.length} index fix(es) needed. Nothing was written.`)
    log('  Re-run with --repair to apply:')
    log('')
    log('      npm run doctor -- --repair')
    log('')
    log('  Only index entries are touched. No link, click count or account is')
    log('  modified, and no link is deleted.')
    log('')
    return
  }

  const { applied, attempted } = await applyFixes(report.fixes)
  log(`  Applied ${applied} of ${attempted} index fix(es).`)
  if (applied < attempted) {
    log('  Some writes were rejected. Run the report again to see what is left.')
  } else {
    log('  Links now match what the dashboard shows.')
  }
  log('')
}

main().catch((err) => {
  console.error('')
  console.error('  doctor failed:', err.message)
  console.error('  Nothing was written unless it says otherwise above.')
  console.error('')
  process.exit(1)
})
