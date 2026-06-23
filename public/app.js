const $ = (id) => document.getElementById(id)
const PENDING = 'ashrt_pending_url'

// Gate the page: bounce to login if there's no session.
async function requireSession() {
  try {
    const res = await fetch('/auth/me')
    if (!res.ok) {
      window.location.href = '/login'
      return null
    }
    return (await res.json()).user
  } catch {
    window.location.href = '/login'
    return null
  }
}

function headers() {
  return { 'Content-Type': 'application/json' }
}

function fmtDate(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function last7(daily = {}) {
  const days = []
  const now = new Date()
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    days.push(daily[d.toISOString().slice(0, 10)] || 0)
  }
  return days
}

function sparkline(daily) {
  const days = last7(daily)
  const max = Math.max(1, ...days)
  return (
    '<div class="spark">' +
    days.map((v) => `<span style="height:${Math.round((v / max) * 100)}%" title="${v} clicks"></span>`).join('') +
    '</div>'
  )
}

const shortLabel = (url) => url.replace(/^https?:\/\//, '')

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

async function load() {
  let data
  try {
    const res = await fetch('/api/links', { headers: headers() })
    if (res.status === 401) return (window.location.href = '/login')
    data = await res.json()
  } catch {
    return
  }

  $('stat-links').textContent = data.totalLinks
  $('stat-clicks').textContent = data.totalClicks.toLocaleString()
  const busiest = [...data.links].sort((a, b) => (b.clicks || 0) - (a.clicks || 0))[0]
  $('stat-top').textContent = busiest && busiest.clicks ? shortLabel(busiest.shortUrl) : '-'

  const rows = data.links
  $('empty').style.display = rows.length ? 'none' : 'block'

  $('rows').innerHTML = rows
    .map(
      (l) => `
      <div class="row">
        <a class="short mono" href="${l.shortUrl}" target="_blank" rel="noreferrer">${shortLabel(l.shortUrl)}</a>
        <span class="dest" title="${escapeHtml(l.url)}">${escapeHtml(l.url)}</span>
        <span class="clicks">${(l.clicks || 0).toLocaleString()}</span>
        <span class="when">${fmtDate(l.createdAt)}</span>
        ${sparkline(l.daily)}
        <span class="row-actions">
          <button class="icon-btn" data-copy="${l.shortUrl}" title="Copy">⧉</button>
          <button class="icon-btn danger" data-del="${l.slug}" title="Delete">✕</button>
        </span>
      </div>`,
    )
    .join('')

  document.querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', () => copy(b.getAttribute('data-copy'), b)),
  )
  document.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => del(b.getAttribute('data-del'))),
  )
}

async function create() {
  const url = $('url').value.trim()
  const alias = $('alias').value.trim()
  if (!url) return
  $('go').disabled = true
  $('go').textContent = 'Working...'
  try {
    const res = await fetch('/api/links', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ url, alias: alias || undefined }),
    })
    const data = await res.json()
    if (!res.ok) {
      if (data.needsUpgrade && confirm(data.error + '\n\nGo to your account to upgrade?')) {
        window.location.href = '/account'
      } else {
        alert(data.error || 'Could not shorten that')
      }
      return
    }
    const link = $('result-link')
    link.textContent = shortLabel(data.shortUrl)
    link.href = data.shortUrl
    $('result').classList.add('show')
    $('url').value = ''
    $('alias').value = ''
    load()
  } catch {
    alert('Network error. Try again.')
  } finally {
    $('go').disabled = false
    $('go').textContent = 'Shorten'
  }
}

async function del(slug) {
  await fetch('/api/links/' + slug, { method: 'DELETE', headers: headers() })
  load()
}

function copy(text, btn) {
  navigator.clipboard?.writeText(text).catch(() => {})
  if (btn) {
    const old = btn.textContent
    btn.textContent = '✓'
    setTimeout(() => (btn.textContent = old), 1200)
  }
}

// If the visitor started shortening on the homepage before signing up, finish
// the job now that they're authenticated.
async function runPending() {
  const raw = localStorage.getItem(PENDING)
  if (!raw) return
  localStorage.removeItem(PENDING)
  try {
    const { url, alias } = JSON.parse(raw)
    if (url) {
      $('url').value = url
      if (alias) $('alias').value = alias
      await create()
    }
  } catch {}
}

$('go').addEventListener('click', create)
$('url').addEventListener('keydown', (e) => e.key === 'Enter' && create())
$('alias').addEventListener('keydown', (e) => e.key === 'Enter' && create())
$('result-copy').addEventListener('click', () => copy($('result-link').href, $('result-copy')))
$('logout').addEventListener('click', async (e) => {
  e.preventDefault()
  await fetch('/auth/logout', { method: 'POST' })
  window.location.href = '/'
})

;(async () => {
  const user = await requireSession()
  if (!user) return
  $('who').textContent = user.plan === 'pro' ? `${user.email} · Pro` : user.email
  if (new URLSearchParams(location.search).get('upgraded')) {
    alert("You're on Pro 🎉 Thanks for upgrading — your links are now unlimited.")
    history.replaceState({}, '', '/dashboard')
  }
  await load()
  await runPending()
})()
