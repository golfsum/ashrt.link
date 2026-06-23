const $ = (id) => document.getElementById(id)
let apiKey = ''
let revealed = false

function renderKey() {
  $('apikey').value = revealed ? apiKey : '•'.repeat(Math.min(apiKey.length, 24))
  $('reveal').textContent = revealed ? 'Hide' : 'Show'
}

function renderSnippet() {
  const key = revealed ? apiKey : 'YOUR_API_KEY'
  $('snippet').textContent =
    `curl -X POST ${location.origin}/api/links \\\n` +
    `  -H "x-api-key: ${key}" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"url":"https://example.com/long/path"}'`
  const base = document.getElementById('api-base')
  if (base) base.textContent = location.origin
}

async function load() {
  let data
  try {
    const res = await fetch('/api/account')
    if (res.status === 401) return (window.location.href = '/login')
    data = (await res.json()).user
  } catch {
    return
  }
  $('email').textContent = data.email
  $('provider').textContent = data.provider === 'password' ? 'Email & password' : data.provider
  apiKey = data.apiKey
  renderKey()
  renderSnippet()
  renderPlan(data.plan)
}

async function renderPlan(plan) {
  const isPro = plan === 'pro'
  $('plan').textContent = isPro ? 'Pro' : 'Free'
  $('plan').classList.toggle('pro', isPro)
  // Only show the upgrade panel to free users when billing is actually enabled.
  if (isPro) return
  try {
    const { enabled } = await (await fetch('/api/billing/status')).json()
    if (enabled) $('upgrade-panel').style.display = 'block'
  } catch {}
}

$('upgrade')?.addEventListener('click', async () => {
  $('upgrade').disabled = true
  $('upgrade').textContent = 'Loading...'
  try {
    const res = await fetch('/api/billing/checkout', { method: 'POST' })
    const data = await res.json()
    if (data.url) return (window.location.href = data.url)
    alert(data.error || 'Billing is not available yet.')
  } catch {
    alert('Could not start checkout.')
  } finally {
    $('upgrade').disabled = false
    $('upgrade').textContent = 'Upgrade to Pro'
  }
})

$('reveal').addEventListener('click', () => {
  revealed = !revealed
  renderKey()
  renderSnippet()
})

$('copykey').addEventListener('click', () => {
  navigator.clipboard?.writeText(apiKey).catch(() => {})
  $('copykey').textContent = '✓'
  setTimeout(() => ($('copykey').textContent = 'Copy'), 1200)
})

$('rotate').addEventListener('click', async () => {
  if (!confirm('Rotate your API key? Any apps using the old key will stop working until you update them.')) return
  const res = await fetch('/api/account/rotate-key', { method: 'POST' })
  const data = await res.json()
  if (data.apiKey) {
    apiKey = data.apiKey
    revealed = true
    renderKey()
    renderSnippet()
  }
})

$('logout').addEventListener('click', async (e) => {
  e.preventDefault()
  await fetch('/auth/logout', { method: 'POST' })
  window.location.href = '/'
})

load()
