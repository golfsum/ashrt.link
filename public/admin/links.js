const { $, api, num, escapeHtml, fmtDate, timeAgo, statusPill, shortUrl, toast, confirmAction, promptText } = window.Admin

let cursor = 0
let rows = []
let owners = {}
let timer = null

// Deep links from the overview or user page land here with filters already applied.
const initial = new URLSearchParams(location.search)

function ownerCell(l) {
  const owner = l.owner ? owners[l.owner] : null
  if (!l.owner) return '<span class="pill pill-guest">guest</span>'
  if (!owner) {
    return `<span class="at-owner-missing" title="Owner record was not resolved">${escapeHtml(l.owner)}</span>`
  }
  return `<a href="/admin/user?id=${encodeURIComponent(owner.id)}" title="Open account">${escapeHtml(owner.email)}</a>
    <span class="at-sub">${escapeHtml(owner.id)} · ${escapeHtml(owner.plan || 'free')}${owner.status && owner.status !== 'active' ? ` · ${escapeHtml(owner.status)}` : ''}</span>`
}

function row(l) {
  const risky = (l.flagSignals || []).length > 0
  return `<div class="atable-row ${risky ? 'row-risky' : ''}">
    <span class="at-main">
      <a class="tl-slug" href="/${escapeHtml(l.slug)}" target="_blank" rel="noreferrer nofollow">/${escapeHtml(l.slug)}</a>
      <span class="at-sub" title="${escapeHtml(l.url)}">${escapeHtml(shortUrl(l.url, 64))}</span>
      ${l.domain ? `<span class="at-sub">domain: ${escapeHtml(l.domain)}</span>` : ''}
      ${risky ? `<span class="at-signals">${l.flagSignals.map((s) => `<span class="sig">${escapeHtml(s)}</span>`).join('')}</span>` : ''}
    </span>
    <span class="at-owner">${ownerCell(l)}</span>
    ${statusPill(l.status)}
    <span class="num">${num(l.clicks)}</span>
    <span class="at-date" title="${l.createdAt ? escapeHtml(fmtDate(l.createdAt)) : ''}">${l.createdAt ? timeAgo(l.createdAt) : 'unknown'}</span>
    <span class="at-date">${l.lastClickAt ? timeAgo(l.lastClickAt) : 'never'}</span>
    <span class="at-actions">
      ${l.owner ? `<a class="btn btn-sm btn-ghost" href="/admin/user?id=${encodeURIComponent(l.owner)}">User</a>` : ''}
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
        <span>Link / destination</span><span>Created by</span><span>Status</span><span>Clicks</span><span>Created</span><span>Last click</span><span></span>
      </div>` + rows.map(row).join('')
    : ''
  $('rows').querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => act(b.dataset.act, b.dataset.slug)))
}

async function load({ append = false } = {}) {
  const params = new URLSearchParams()
  const q = $('search').value.trim()
  const owner = $('owner').value.trim()
  if (q) params.set('q', q)
  if (owner) params.set('owner', owner)
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

function delayedLoad() {
  clearTimeout(timer)
  timer = setTimeout(() => load().catch((e) => toast(e.message)), 250)
}

$('search').addEventListener('input', delayedLoad)
$('owner').addEventListener('input', delayedLoad)
$('status').addEventListener('change', () => load().catch((e) => toast(e.message)))
$('guest').addEventListener('change', () => load().catch((e) => toast(e.message)))
$('more').addEventListener('click', () => load({ append: true }).catch((e) => toast(e.message)))

;(async () => {
  if (!(await window.adminReady)) return
  if (initial.get('q')) $('search').value = initial.get('q')
  if (initial.get('owner')) $('owner').value = initial.get('owner')
  if (initial.get('status')) $('status').value = initial.get('status')
  if (initial.get('guest')) $('guest').value = initial.get('guest')
  await load()
})()
