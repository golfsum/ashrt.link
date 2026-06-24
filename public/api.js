const $ = (id) => document.getElementById(id)
let apiKey = ''
let revealed = false
let lang = 'curl'
const BASE = location.origin

const TEMPLATES = {
  curl: `curl -X POST {BASE}/api/links \\
  -H "x-api-key: {KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com/long/path"}'`,
  js: `const res = await fetch("{BASE}/api/links", {
  method: "POST",
  headers: {
    "x-api-key": "{KEY}",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ url: "https://example.com/long/path" }),
});
const link = await res.json();
console.log(link.shortUrl);`,
  py: `import requests

r = requests.post(
    "{BASE}/api/links",
    headers={"x-api-key": "{KEY}"},
    json={"url": "https://example.com/long/path"},
)
print(r.json()["shortUrl"])`,
  php: `<?php
$ch = curl_init("{BASE}/api/links");
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_POST => true,
  CURLOPT_HTTPHEADER => ["x-api-key: {KEY}", "Content-Type: application/json"],
  CURLOPT_POSTFIELDS => json_encode(["url" => "https://example.com/long/path"]),
]);
$link = json_decode(curl_exec($ch), true);
echo $link["shortUrl"];`,
}

function renderKey() {
  $('apikey').value = revealed ? apiKey : '•'.repeat(Math.min(apiKey.length || 24, 24))
  $('reveal').textContent = revealed ? 'Hide' : 'Show'
}
function renderCode() {
  const key = revealed ? apiKey : 'YOUR_API_KEY'
  $('code').textContent = TEMPLATES[lang].replaceAll('{BASE}', BASE).replaceAll('{KEY}', key)
}

function usageSeries(byDay) {
  const out = []
  const now = new Date()
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    out.push({ label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), value: byDay[key] || 0 })
  }
  return out
}

async function load() {
  const [acc, usage] = await Promise.all([
    fetch('/api/account').then((r) => (r.ok ? r.json() : null)),
    fetch('/api/usage').then((r) => (r.ok ? r.json() : null)),
  ])
  if (!acc || !usage) return (window.location.href = '/login')
  apiKey = acc.user.apiKey
  renderKey()
  renderCode()
  $('m-today').textContent = usage.today.toLocaleString()
  $('m-month').textContent = usage.month.toLocaleString()
  $('m-limit').textContent = `${usage.dailyLimit.toLocaleString()}/day`
  $('m-plan').textContent = usage.plan === 'free' ? 'Free' : usage.plan.charAt(0).toUpperCase() + usage.plan.slice(1)
  Charts.line($('chart-usage'), usageSeries(usage.byDay))
}

$('reveal').addEventListener('click', () => {
  revealed = !revealed
  renderKey()
  renderCode()
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
    renderCode()
  }
})
$('lang').addEventListener('click', (e) => {
  const btn = e.target.closest('button')
  if (!btn) return
  lang = btn.dataset.lang
  ;[...$('lang').children].forEach((b) => b.classList.toggle('active', b === btn))
  renderCode()
})

;(async () => {
  const user = await window.shellReady
  if (!user) return
  await load()
})()
