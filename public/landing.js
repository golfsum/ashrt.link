const $ = (id) => document.getElementById(id)
const PENDING = 'ashrt_pending_url'

// Fill the top nav based on whether someone is signed in.
async function renderNav() {
  let user = null
  try {
    const res = await fetch('/auth/me')
    if (res.ok) user = (await res.json()).user
  } catch {}
  const nav = $('nav')
  if (!nav) return
  nav.innerHTML = user
    ? `<a href="/dashboard">Dashboard</a><a href="/account">Account</a>`
    : `<a href="/login">Log in</a><a class="btn btn-sm" href="/signup">Get started</a>`
  window.__user = user
}

async function create() {
  const url = $('url').value.trim()
  if (!url) return
  // Logged out: stash the URL and send them to sign up, then we make it for them.
  if (!window.__user) {
    localStorage.setItem(PENDING, JSON.stringify({ url, alias: $('alias').value.trim() }))
    window.location.href = '/signup'
    return
  }
  $('go').disabled = true
  $('go').textContent = 'Working...'
  try {
    const res = await fetch('/api/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, alias: $('alias').value.trim() || undefined }),
    })
    const data = await res.json()
    if (!res.ok) {
      alert(data.error || 'Could not shorten that')
      return
    }
    const link = $('result-link')
    link.textContent = data.shortUrl.replace(/^https?:\/\//, '')
    link.href = data.shortUrl
    $('result').classList.add('show')
    $('url').value = ''
    $('alias').value = ''
  } catch {
    alert('Network error. Try again.')
  } finally {
    $('go').disabled = false
    $('go').textContent = 'Shorten'
  }
}

$('go').addEventListener('click', create)
$('url').addEventListener('keydown', (e) => e.key === 'Enter' && create())
$('alias').addEventListener('keydown', (e) => e.key === 'Enter' && create())
$('result-copy').addEventListener('click', () => {
  navigator.clipboard?.writeText($('result-link').href).catch(() => {})
  $('result-copy').textContent = '✓'
  setTimeout(() => ($('result-copy').textContent = 'Copy'), 1200)
})

renderNav()
