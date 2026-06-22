const $ = (id) => document.getElementById(id)
const KEY_STORE = 'ashrt_key'

let apiKey = localStorage.getItem(KEY_STORE) || ''
$('key').value = apiKey

function headers() {
  const h = { 'Content-Type': 'application/json' }
  if (apiKey) h['x-api-key'] = apiKey
  return h
}

$('key').addEventListener('input', (e) => {
  apiKey = e.target.value.trim()
  localStorage.setItem(KEY_STORE, apiKey)
  const saved = $('keysaved')
  saved.style.display = 'inline'
  clearTimeout(window.__kt)
  window.__kt = setTimeout(() => (saved.style.display = 'none'), 1200)
  load()
})

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

function shortLabel(url) {
  return url.replace(/^https?:\/\//, '')
}

async function load() {
  let data
  try {
    const res = await fetch('/api/links', { headers: headers() })
    if (res.status === 401) {
      $('rows').innerHTML = ''
      $('empty').textContent = 'Add your API key (top right) to see and manage links.'
      $('empty').style.display = 'block'
      return
    }
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
  $('empty').textContent = 'No links yet. Make your first one above.'

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
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
      alert(data.error || 'Could not shorten that')
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
    alert('Network error. Is the server running?')
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

$('go').addEventListener('click', create)
$('url').addEventListener('keydown', (e) => e.key === 'Enter' && create())
$('alias').addEventListener('keydown', (e) => e.key === 'Enter' && create())
$('result-copy').addEventListener('click', () => {
  copy($('result-link').href, $('result-copy'))
})

load()
