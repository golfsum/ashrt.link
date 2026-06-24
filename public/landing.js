const $ = (id) => document.getElementById(id)
let user = null

async function init() {
  try {
    const res = await fetch('/auth/me')
    if (res.ok) user = (await res.json()).user
  } catch {}

  // Nav
  $('nav').innerHTML = user
    ? `<a href="/dashboard">Dashboard</a><a href="/account">Account</a>`
    : `<a href="/login">Log in</a><a class="btn btn-sm" href="/signup">Get started</a>`

  // Custom alias is an account feature - hide the input when logged out.
  if (!user) {
    $('alias').style.display = 'none'
    $('alias-hint').style.display = 'block'
  }

  // Pro button label depends on plan.
  if (user?.plan === 'pro') {
    $('pro-btn').textContent = "You're on Pro ✓"
    $('pro-btn').disabled = true
  }
}

async function create() {
  const url = $('url').value.trim()
  if (!url) return
  $('go').disabled = true
  $('go').textContent = 'Working...'
  try {
    const body = { url }
    if (user) {
      const alias = $('alias').value.trim()
      if (alias) body.alias = alias
    }
    const res = await fetch('/api/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) {
      if (data.needsUpgrade) return upgrade()
      alert(data.error || 'Could not shorten that')
      return
    }
    const link = $('result-link')
    link.textContent = data.shortUrl.replace(/^https?:\/\//, '')
    link.href = data.shortUrl
    $('result').classList.add('show')
    // Nudge anonymous users to sign up to track clicks.
    if (!user) $('nudge').style.display = 'block'
    $('url').value = ''
    if (user) $('alias').value = ''
  } catch {
    alert('Network error. Try again.')
  } finally {
    $('go').disabled = false
    $('go').textContent = 'Shorten'
  }
}

// Start (or prompt for) a paid subscription.
async function upgrade(plan, btn, label) {
  if (!user) {
    window.location.href = '/signup'
    return
  }
  btn.disabled = true
  btn.textContent = 'Loading...'
  try {
    const res = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan }),
    })
    const data = await res.json()
    if (data.url) {
      window.location.href = data.url
      return
    }
    alert(data.error || 'Billing is not available yet.')
  } catch {
    alert('Could not start checkout.')
  } finally {
    btn.disabled = false
    btn.textContent = label
  }
}

$('go').addEventListener('click', create)
$('url').addEventListener('keydown', (e) => e.key === 'Enter' && create())
$('alias').addEventListener('keydown', (e) => e.key === 'Enter' && create())
$('pro-btn').addEventListener('click', () => upgrade('pro', $('pro-btn'), 'Upgrade to Pro'))
$('biz-btn')?.addEventListener('click', () => upgrade('business', $('biz-btn'), 'Choose Business'))
$('result-copy').addEventListener('click', () => {
  navigator.clipboard?.writeText($('result-link').href).catch(() => {})
  $('result-copy').textContent = '✓'
  setTimeout(() => ($('result-copy').textContent = 'Copy'), 1200)
})

init()
