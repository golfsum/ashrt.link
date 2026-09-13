const { $, api, num, escapeHtml, timeAgo, fmtDate, toast } = window.Admin

let cursor = 0
let rows = []
let timer = null

function row(u) {
  const flags = []
  if (u.role === 'admin') flags.push('<span class="pill pill-admin">admin</span>')
  if (u.status === 'suspended') flags.push('<span class="pill pill-disabled">suspended</span>')
  if (u.apiDisabled) flags.push('<span class="pill pill-flagged">API off</span>')
  if ((u.flags || []).length) flags.push(`<span class="pill pill-flagged">${escapeHtml(u.flags[0])}</span>`)

  return `<a class="atable-row" href="/admin/user?id=${encodeURIComponent(u.id)}">
    <span class="at-main">
      <span class="at-title">${escapeHtml(u.email)}</span>
      <span class="at-sub">${escapeHtml(u.name || '')} ${flags.join(' ')}</span>
    </span>
    <span class="pill pill-plan-${escapeHtml(u.plan)}">${escapeHtml(u.plan)}</span>
    <span class="num">${num(u.links)}</span>
    <span class="num">${num(u.clicks)}</span>
    <span class="at-date">${fmtDate(u.createdAt)}</span>
  </a>`
}

function render() {
  $('empty').style.display = rows.length ? 'none' : 'block'
  $('rows').innerHTML = rows.length
    ? `<div class="atable-row atable-head">
        <span>Account</span><span>Plan</span><span>Links</span><span>Clicks</span><span>Joined</span>
      </div>` + rows.map(row).join('')
    : ''
}

async function load({ append = false } = {}) {
  const params = new URLSearchParams()
  const q = $('search').value.trim()
  if (q) params.set('q', q)
  if ($('filter').value) params.set('filter', $('filter').value)
  params.set('cursor', append ? cursor : 0)

  const data = await api('/api/admin/users?' + params)
  rows = append ? [...rows, ...data.users] : data.users
  cursor = data.nextCursor ?? 0
  $('more').style.display = data.nextCursor ? '' : 'none'
  $('count').textContent = `${num(data.total)} account${data.total === 1 ? '' : 's'}`
  render()
}

$('search').addEventListener('input', () => {
  clearTimeout(timer)
  timer = setTimeout(() => load().catch((e) => toast(e.message)), 250)
})
$('filter').addEventListener('change', () => load().catch((e) => toast(e.message)))
$('more').addEventListener('click', () => load({ append: true }).catch((e) => toast(e.message)))

;(async () => {
  if (!(await window.adminReady)) return
  await load()
})()
