const { $, api, num, escapeHtml, timeAgo, fmtDate, statusPill, shortUrl, toast, confirmAction, promptText } = window.Admin

let status = 'new'
let data = null

/**
 * Reports are grouped by the link they are about.
 *
 * Several people reporting the same URL is one decision, not N. Listing them
 * separately would mean clicking through the same verdict three times and makes
 * a coordinated pile-on look like three independent complaints.
 */
function groupReports(reports) {
  const groups = new Map()
  for (const r of reports) {
    if (!groups.has(r.slug)) groups.set(r.slug, { slug: r.slug, url: r.url, reports: [] })
    groups.get(r.slug).reports.push(r)
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      reporters: new Set(g.reports.map((r) => r.reporterHash).filter(Boolean)).size,
      newest: Math.max(...g.reports.map((r) => r.createdAt)),
      reasons: [...new Set(g.reports.map((r) => r.reason))],
    }))
    .sort((a, b) => b.reporters - a.reporters || b.newest - a.newest)
}

function reportGroup(g) {
  const ids = g.reports.map((r) => r.id).join(',')
  const multiple = g.reports.length > 1
  const notes = g.reports.flatMap((r) => r.notes || []).sort((a, b) => a.at - b.at)

  return `<div class="report-row">
    <div class="report-main">
      <div class="report-top">
        <a class="tl-slug" href="/admin/links?q=${encodeURIComponent(g.slug)}">/${escapeHtml(g.slug)}</a>
        ${g.reasons.map((r) => `<span class="pill pill-reason">${escapeHtml(r)}</span>`).join('')}
        ${statusPill(g.reports[0].status)}
        ${multiple ? `<span class="pill pill-flagged">${g.reports.length} reports · ${g.reporters} reporter${g.reporters === 1 ? '' : 's'}</span>` : ''}
        <span class="report-when">${timeAgo(g.newest)}</span>
      </div>
      <div class="at-sub" title="${escapeHtml(g.url)}">${escapeHtml(shortUrl(g.url, 70))}</div>
      ${g.reports
        .filter((r) => r.detail)
        .map((r) => `<div class="report-detail">${escapeHtml(r.detail)}</div>`)
        .join('')}
      ${notes.length
        ? `<div class="report-notes">${notes.map((n) => `<div class="note-row"><div class="note-meta">${escapeHtml(n.byEmail || 'admin')} · ${timeAgo(n.at)}</div><div class="note-text">${escapeHtml(n.text)}</div></div>`).join('')}</div>`
        : ''}
    </div>
    <div class="report-actions">
      ${g.reports[0].status !== 'reviewing' ? `<button class="btn btn-sm btn-ghost" data-rep="${ids}" data-status="reviewing">Reviewing</button>` : ''}
      <button class="btn btn-sm btn-danger" data-rep="${ids}" data-status="actioned">Actioned</button>
      <button class="btn btn-sm btn-ghost" data-rep="${ids}" data-status="dismissed">Dismiss</button>
      <button class="btn btn-sm btn-ghost" data-note="${ids}">Note</button>
      <button class="btn btn-sm btn-danger" data-link="${escapeHtml(g.slug)}" data-act="disable">Disable link</button>
    </div>
  </div>`
}

function render() {
  $('reports').innerHTML = data.reports.length
    ? groupReports(data.reports).map(reportGroup).join('')
    : '<div class="chart-empty">No reports in this state.</div>'

  $('flagged').innerHTML = data.flagged.length
    ? data.flagged
        .map(
          (l) => `<div class="atable-row">
            <span class="at-main">
              <a class="tl-slug" href="/admin/links?q=${encodeURIComponent(l.slug)}">/${escapeHtml(l.slug)}</a>
              <span class="at-sub">${escapeHtml(shortUrl(l.url, 60))}</span>
              ${(l.flagSignals || []).length ? `<span class="at-signals">${l.flagSignals.map((s) => `<span class="sig">${escapeHtml(s)}</span>`).join('')}</span>` : ''}
            </span>
            <span class="num">${num(l.clicks)} <span class="num-label">clicks</span></span>
            <span class="at-actions">
              <button class="btn btn-sm btn-danger" data-link="${escapeHtml(l.slug)}" data-act="disable">Disable</button>
              <button class="btn btn-sm btn-ghost" data-link="${escapeHtml(l.slug)}" data-act="unflag">Clear flag</button>
            </span>
          </div>`,
        )
        .join('')
    : '<div class="chart-empty">No links are currently flagged.</div>'

  $('blocked').innerHTML = data.blocked.length
    ? data.blocked
        .map(
          (b) => `<div class="atable-row">
            <span class="at-main">
              <span class="at-title mono">${escapeHtml(b.domain)}</span>
              <span class="at-sub">${escapeHtml(b.reason || 'no reason recorded')} · added ${fmtDate(b.addedAt)}</span>
            </span>
            <span class="at-actions">
              <button class="btn btn-sm btn-ghost" data-unblock="${escapeHtml(b.domain)}">Unblock</button>
            </span>
          </div>`,
        )
        .join('')
    : '<div class="chart-empty">No blocked domains. Blocking one stops every link pointing at it, including existing ones.</div>'

  $('reports').querySelectorAll('[data-rep]').forEach((b) => (b.onclick = () => setStatus(b.dataset.rep, b.dataset.status)))
  $('reports').querySelectorAll('[data-link]').forEach((b) => (b.onclick = () => linkAct(b.dataset.act, b.dataset.link)))
  $('reports').querySelectorAll('[data-note]').forEach((b) => (b.onclick = () => addNote(b.dataset.note)))
  $('flagged').querySelectorAll('[data-link]').forEach((b) => (b.onclick = () => linkAct(b.dataset.act, b.dataset.link)))
  $('blocked').querySelectorAll('[data-unblock]').forEach((b) => (b.onclick = () => unblock(b.dataset.unblock)))
}

/** One verdict applies to every report in the group. */
async function setStatus(idList, next) {
  const ids = idList.split(',')
  if (next === 'actioned') {
    const ok = await confirmAction({
      title: ids.length > 1 ? `Mark ${ids.length} reports as actioned?` : 'Mark as actioned?',
      body: 'Use this once you have actually disabled the link or suspended the account. It does not take any action by itself.',
      confirmLabel: 'Mark actioned',
      danger: false,
    })
    if (!ok) return
  }
  try {
    for (const id of ids) {
      await api(`/api/admin/abuse/reports/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status: next } })
    }
    toast(ids.length > 1 ? `${ids.length} reports updated` : 'Report updated')
    await load()
  } catch (e) {
    toast(e.message, 'error')
  }
}

async function addNote(idList) {
  const note = await promptText({ title: 'Add a note', label: 'Note', placeholder: 'What did you find?' })
  if (!note) return
  try {
    // The note goes on the first report of the group; it renders for all of them.
    await api(`/api/admin/abuse/reports/${encodeURIComponent(idList.split(',')[0])}`, {
      method: 'PATCH',
      body: { note },
    })
    await load()
  } catch (e) {
    toast(e.message, 'error')
  }
}

async function linkAct(action, slug) {
  let reason
  if (action === 'disable') {
    reason = await promptText({ title: `Disable /${slug}`, label: 'Reason', placeholder: 'phishing, malware, spam...' })
    if (reason === null) return
  }
  try {
    await api(`/api/admin/links/${encodeURIComponent(slug)}`, { method: 'PATCH', body: { action, reason } })
    toast('Done')
    await load()
  } catch (e) {
    toast(e.message, 'error')
  }
}

async function unblock(domain) {
  const ok = await confirmAction({
    title: `Unblock ${domain}?`,
    body: 'Links pointing at this domain will start working again immediately.',
    confirmLabel: 'Unblock',
  })
  if (!ok) return
  try {
    await api(`/api/admin/blocked/${encodeURIComponent(domain)}`, { method: 'DELETE' })
    toast(`${domain} unblocked`)
    await load()
  } catch (e) {
    toast(e.message, 'error')
  }
}

$('add-block').addEventListener('click', async () => {
  const domain = await promptText({
    title: 'Block a domain',
    label: 'Domain (subdomains are covered too)',
    placeholder: 'phishing-site.example',
    confirmLabel: 'Block',
  })
  if (!domain) return
  const reason = await promptText({ title: 'Why?', label: 'Reason', placeholder: 'Recorded in the audit log', required: false })
  try {
    await api('/api/admin/blocked', { method: 'POST', body: { domain, reason } })
    toast(`${domain} blocked`)
    await load()
  } catch (e) {
    toast(e.message, 'error')
  }
})

$('repfilter').addEventListener('click', (e) => {
  const btn = e.target.closest('button')
  if (!btn) return
  status = btn.dataset.status
  ;[...$('repfilter').children].forEach((b) => b.classList.toggle('active', b === btn))
  load().catch((err) => toast(err.message))
})

async function load() {
  data = await api('/api/admin/abuse' + (status ? `?status=${status}` : ''))
  render()
}

;(async () => {
  if (!(await window.adminReady)) return
  await load()
})()
