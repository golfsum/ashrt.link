const { $, api, num, escapeHtml, shortUrl, fmtDate, toast, confirmAction } = window.Admin

let report = null

function kpi(label, value, sub) {
  return `<div class="card metric">
    <div class="label">${escapeHtml(label)}</div>
    <div class="value">${num(value)}</div>
    ${sub ? `<div class="metric-sub">${escapeHtml(sub)}</div>` : ''}
  </div>`
}

/** One account's links, with the ones the index cannot find called out. */
function accountCard(a) {
  const rows = a.links
    .map(
      (l) => `<div class="atable-row ${l.indexed ? '' : 'row-risky'}">
        <span class="at-main">
          <span class="at-title"><span class="mono">/${escapeHtml(l.slug)}</span>
            ${l.indexed ? '' : '<span class="pill pill-flagged">not indexed</span>'}</span>
          <span class="at-sub">${escapeHtml(shortUrl(l.url))}</span>
        </span>
        <span>${num(l.clicks)}</span>
        <span>${escapeHtml(l.status)}</span>
        <span class="at-date">${fmtDate(l.createdAt)}</span>
      </div>`,
    )
    .join('')

  const problems = []
  if (a.stale.length) {
    problems.push(
      `${num(a.stale.length)} index entr${a.stale.length === 1 ? 'y' : 'ies'} with no link behind ${
        a.stale.length === 1 ? 'it' : 'them'
      } (${a.stale.slice(0, 6).map(escapeHtml).join(', ')}${a.stale.length > 6 ? ', …' : ''})`,
    )
  }
  if (a.missing.length) {
    problems.push(
      `${num(a.missing.length)} link${a.missing.length === 1 ? '' : 's'} the index never learned about — ${
        a.missing.length === 1 ? 'it redirects but is' : 'they redirect but are'
      } missing from the dashboard`,
    )
  }

  return `<section class="panel-card">
    <div class="panel-head">
      <h2>${escapeHtml(a.email || a.id)}</h2>
      <span class="head-note">${num(a.records)} link${a.records === 1 ? '' : 's'} · index says ${num(a.indexed)}</span>
    </div>
    ${
      problems.length
        ? `<div class="admin-alert admin-alert-warn">${problems.map((p) => `<div>${p}</div>`).join('')}</div>`
        : ''
    }
    ${
      rows
        ? `<div class="atable atable-links-sm">
             <div class="atable-row atable-head"><span>Short code</span><span>Clicks</span><span>Status</span><span>Created</span></div>
             ${rows}
           </div>`
        : '<div class="chart-empty">No links. Every index entry for this account is stale.</div>'
    }
  </section>`
}

function render() {
  const healthy = report.problems === 0

  $('verdict').innerHTML = healthy
    ? ''
    : `<div class="admin-alert">
         ${num(report.fixable)} index fix${report.fixable === 1 ? '' : 'es'} needed across
         ${num(report.accounts.filter((a) => !a.healthy).length)} account(s)${
           report.zsetMissingTotal ? `, plus ${num(report.zsetMissingTotal)} link(s) missing from admin paging` : ''
         }. Nothing has been written.
       </div>`

  $('kpis').innerHTML = [
    kpi('Link records', report.scanned, report.truncated ? 'scan limit reached' : 'the source of truth'),
    kpi('Accounts checked', report.accounts.length, `${num(report.accountCount)} total`),
    kpi('Index fixes needed', report.fixable, healthy ? 'indexes agree' : 'run the rebuild'),
    kpi('Guest links', report.guestLinks, report.orphaned ? `${num(report.orphaned)} orphaned` : ''),
  ].join('')

  const unhealthy = report.accounts.filter((a) => !a.healthy)
  const shown = unhealthy.length ? unhealthy : report.accounts.slice(0, 10)

  $('body').innerHTML =
    (report.unreadable
      ? `<div class="admin-alert">${num(report.unreadable)} record(s) could not be read. Those are left strictly
         alone: an unreadable link still redirects, and unindexing it would hide it for good.</div>`
      : '') +
    (shown.length
      ? shown.map(accountCard).join('')
      : '<div class="chart-empty">No accounts own links yet.</div>')

  $('repair').style.display = report.fixable ? '' : 'none'
}

async function load() {
  $('body').innerHTML = '<div class="chart-empty">Checking…</div>'
  const who = $('who').value.trim()
  report = await api('/api/admin/health' + (who ? '?user=' + encodeURIComponent(who) : ''))
  render()
}

async function repair() {
  const ok = await confirmAction({
    title: 'Rebuild indexes from the links',
    body:
      `This applies ${num(report.fixable)} index write(s): it adds entries for links the index is missing ` +
      'and removes entries pointing at links that no longer exist. No link, destination, click count ' +
      'or account is touched, and nothing is deleted.',
    confirmLabel: 'Rebuild',
    typeToConfirm: 'repair',
    danger: false,
  })
  if (!ok) return

  $('repair').disabled = true
  try {
    const who = $('who').value.trim()
    const res = await api('/api/admin/health/repair', {
      method: 'POST',
      body: { confirm: 'repair', user: who || undefined },
    })
    toast(
      res.applied === res.attempted
        ? `Applied ${num(res.applied)} fix(es).`
        : `Applied ${num(res.applied)} of ${num(res.attempted)}. Re-check to see what is left.`,
    )
    await load()
  } catch (err) {
    toast(err.message, 'error')
  } finally {
    $('repair').disabled = false
  }
}

$('check').addEventListener('click', () => load())
$('who').addEventListener('keydown', (e) => e.key === 'Enter' && load())
$('repair').addEventListener('click', repair)

;(async () => {
  if (!(await window.adminReady)) return
  await load()
})()
