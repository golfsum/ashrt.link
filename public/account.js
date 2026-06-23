const $ = (id) => document.getElementById(id)
let apiKey = ''
let revealed = false

function renderKey() {
  $('apikey').value = revealed ? apiKey : '•'.repeat(Math.min(apiKey.length, 24))
  $('reveal').textContent = revealed ? 'Hide' : 'Show'
}

function renderSnippet() {
  $('snippet').textContent = `ASHRT_API_URL=${location.origin}\nASHRT_API_KEY=${revealed ? apiKey : 'your-key-above'}`
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
}

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
  if (!confirm('Rotate your API key? Apps using the old key (including Schedlytics) will stop working until you update them.')) return
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
