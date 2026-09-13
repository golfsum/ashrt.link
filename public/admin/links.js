const { $, api, num, escapeHtml, fmtDate, timeAgo, statusPill, shortUrl, toast, confirmAction, promptText } = window.Admin

let cursor = 0
let rows = []
let owners = {}
let timer = null

// Deep links from the overview land here with a filter already applied.
const initial = new URLSearchParams(location.search)

function row(l) {
  const owner = l.owner ? owners[l.owner] : null
  const risky = (l.flagSignals || []).length > 0
  return `<div class="atable-row ${risky ? 'row-risky' : ''}">
    <span class="at-main">
      <a class="tl-slug" href="/${escapeHtml(l.slug)}" target="_blank" rel="noreferrer nofollow">/${escapeHtml(l.slug)}</a>
      <span class="at-sub" title="${escapeHtml(l.url)}">${escapeHtml(shortUrl(l.url, 64))}</span>
      ${risky ? `<span class="at-signals">${l.flagSignals.map((s) => `<span class="sig">${escapeHtml(s)}</span>`).join('')}</span>` : ''}
    </span>
    <span class="at-owner">${
      owner
        ? `<a href="/admin/user?id=${encodeURIComponent(owner.id)}">${escapeHtml(owner.email)}</a>`
        : '<span class="pill pill-guest">guest</span>'
    }</span>
    ${statusPill(l.status)}
    <span class="num">${num(l.clicks)}</span>
    <span class="at-date">${l.lastClickAt ? timeAgo(l.lastClickAt) : 'never'}</span>
    <span class="at-actions">
      ${l.status === 'disabled'
        ? `<button class="btn btn-sm btn-ghost" data-act="enable" data-slug="${escapeHtml(l.slug)}">Enable</button>`
        : `<button class="btn btn-sm btn-danger" data-act="disable" data-slug="${escapeHtml(l.slug)}">Disable</button>`}
      ${l.status === 'flagged'
        ? `<button class="btn btn-sm btn-ghost" data-act="unflag" data-slug="${escapeHtml(l.slug)}">Clear flag</button>`
        : `<button class="btn btn-sm btn-ghost" data-act="flag" data-slug="${escapeHtml(l.slug)}">Flag</button>`}
      <button class="icon-btn danger" data-act="delete" data-slug="${escapeHtml(l.slug)}" title="Delete permanently">✕</button>
    </span>
  </div>`
}

function render() {
  $('empty').style.display = rows.length ? 'none' : 'block'
  $('rows').innerHTML = rows.length
    ? `<div class="atable-row atable-head">
        <span>Link</span><span>Owner</span><span>Status</span><span>Clicks</span><span>Last click</span><span></span>
      </div>` + rows.map(row).join('')
    : ''
  $('rows').querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => act(b.dataset.act, b.dataset.slug)))
}

async function load({ append = false } = {}) {
  const params = new URLSearchParams()
  const q = $('search').value.trim()
  if (q) params.set('q', q)
  if ($('status').value) params.set('status', $('status').value)
  if ($('guest').value) params.set('guest', $('guest').value)
  params.set('cursor', append ? cursor : 0)

  const data = await api('/api/admin/links?' + params)
  rows = append ? [...rows, ...data.links] : data.links
  owners = { ...owners, ...data.owners }
  cursor = data.nextCursor ?? 0
  $('more').style.display = data.nextCursor ? '' : 'none'
  $('count').textContent =
    `${num(data.total)} link${data.total === 1 ? '' : 's'}` +
    (data.truncated ? ` (stopped after scanning ${num(data.scanned)}; narrow the search)` : '')
  render()
}

async function act(action, slug) {
  if (action === 'delete') {
    const ok = await confirmAction({
      title: `Delete /${slug} permanently?`,
      body: 'This removes the link and its entire click history. It cannot be undone. <b>Disabling is reversible and is usually what you want.</b>',
      confirmLabel: 'Delete forever',
      typeToConfirm: slug,
    })
    if (!ok) return
    try {
      await api(`/api/admin/links/${encodeURIComponent(slug)}`, { method: 'DELETE', body: { confirm: slug } })
      toast(`/${slug} deleted`)
      await load()
    } catch (e) {
      toast(e.message, 'error')
    }
    return
  }

  let reason
  if (action === 'disable' || action === 'flag') {
    reason = await promptText({
      title: action === 'disable' ? `Disable /${slug}` : `Flag /${slug}`,
      label: 'Reason (recorded in the audit log)',
      placeholder: 'phishing, malware, spam...',
    })
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

$('search').addEventListener('input', () => {
  clearTimeout(timer)
  timer = setTimeout(() => load().catch((e) => toast(e.message)), 250)
})
$('status').addEventListener('change', () => load().catch((e) => toast(e.message)))
$('guest').addEventListener('change', () => load().catch((e) => toast(e.message)))
$('more').addEventListener('click', () => load({ append: true }).catch((e) => toast(e.message)))

;(async () => {
  if (!(await window.adminReady)) return
  if (initial.get('q')) $('search').value = initial.get('q')
  if (initial.get('status')) $('status').value = initial.get('status')
  await load()
})()
