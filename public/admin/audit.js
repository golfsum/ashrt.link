const { $, api, num, escapeHtml, timeAgo } = window.Admin

let cursor = 0
let rows = []

// Plain-language labels: an audit log is read under pressure, so it should not
// require translating internal action names.
const LABELS = {
  'user.suspend': 'suspended account',
  'user.restore': 'restored account',
  'user.disable-api': 'disabled API access for',
  'user.enable-api': 're-enabled API access for',
  'user.revoke-key': 'revoked the API key of',
  'user.note': 'noted on account',
  'user.flag': 'flagged account',
  'user.unflag': 'cleared a flag on',
  'user.promote': 'granted admin to',
  'user.demote': 'removed admin from',
  'link.disable': 'disabled link',
  'link.enable': 're-enabled link',
  'link.flag': 'flagged link',
  'link.unflag': 'cleared the flag on link',
  'link.note': 'noted on link',
  'link.delete': 'permanently deleted link',
  'link.auto_flagged': 'was auto-flagged',
  'domain.blocked': 'blocked domain',
  'domain.unblocked': 'unblocked domain',
  'report.updated': 'updated report',
}

const DESTRUCTIVE = new Set(['link.delete', 'user.suspend', 'user.promote', 'user.demote'])

function targetLink(e) {
  // targetLabel is the email for a user target, resolved server-side: a raw
  // account id tells whoever is reading this log nothing.
  const label = escapeHtml(e.targetLabel || e.targetId || '')
  if (e.targetType === 'user') return `<a href="/admin/user?id=${encodeURIComponent(e.targetId)}">${label}</a>`
  if (e.targetType === 'link') return `<a href="/admin/links?q=${encodeURIComponent(e.targetId)}">/${label}</a>`
  return `<span class="mono">${label}</span>`
}

function row(e) {
  const meta = []
  if (e.meta?.reason) meta.push(escapeHtml(e.meta.reason))
  if (e.meta?.url) meta.push(escapeHtml(e.meta.url))
  if (e.meta?.signals?.length) meta.push(escapeHtml(e.meta.signals.join(', ')))
  if (e.meta?.clicks !== undefined) meta.push(`${num(e.meta.clicks)} clicks lost`)

  return `<div class="atable-row ${DESTRUCTIVE.has(e.action) ? 'row-risky' : ''}">
    <span class="at-main">
      <span class="at-title">
        <b>${escapeHtml(e.actorEmail || 'system')}</b>
        ${escapeHtml(LABELS[e.action] || e.action)}
        ${targetLink(e)}
      </span>
      ${meta.length ? `<span class="at-sub">${meta.join(' · ')}</span>` : ''}
    </span>
    <span class="at-date" title="${new Date(e.at).toISOString()}">${timeAgo(e.at)}</span>
  </div>`
}

function render() {
  $('empty').style.display = rows.length ? 'none' : 'block'
  $('rows').innerHTML = rows.map(row).join('')
}

async function load({ append = false } = {}) {
  const params = new URLSearchParams()
  if ($('filter').value) params.set('action', $('filter').value)
  params.set('cursor', append ? cursor : 0)

  const data = await api('/api/admin/audit?' + params)
  rows = append ? [...rows, ...data.entries] : data.entries
  cursor = data.nextCursor ?? 0
  $('more').style.display = data.nextCursor ? '' : 'none'
  render()
}

$('filter').addEventListener('change', () => load())
$('more').addEventListener('click', () => load({ append: true }))

;(async () => {
  if (!(await window.adminReady)) return
  await load()
})()
