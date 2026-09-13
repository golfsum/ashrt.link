const $ = (id) => document.getElementById(id)
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

let keys = []
let scopeLabels = {}
let creating = false

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

const when = (ts) => (ts ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'never')

/**
 * The keys an account holds.
 *
 * Metadata only. The prefix is enough to tell two keys apart in a list and not
 * enough to use one, which is the whole point of storing them hashed.
 */
function renderKeys() {
  $('keys').innerHTML = keys.length
    ? `<div class="key-list">${keys
        .map(
          (k) => `<div class="key-item">
            <div class="key-main">
              <span class="key-name">${escapeHtml(k.name)}</span>
              <span class="mono key-prefix">${escapeHtml(k.prefix)}</span>
            </div>
            <div class="key-scopes">${(k.scopes || []).map((sc) => `<span class="scope-chip">${escapeHtml(sc)}</span>`).join('')}</div>
            <div class="key-meta">created ${when(k.createdAt)} · last used ${when(k.lastUsedAt)}</div>
            <button class="icon-btn danger" data-revoke="${escapeHtml(k.id)}" title="Revoke">✕</button>
          </div>`,
        )
        .join('')}</div>`
    : '<div class="chart-empty">No keys yet. Create one to use the API.</div>'

  $('keys').querySelectorAll('[data-revoke]').forEach((b) => (b.onclick = () => revoke(b.dataset.revoke)))
}

function renderCode() {
  $('code').textContent = TEMPLATES[lang].replaceAll('{BASE}', BASE).replaceAll('{KEY}', 'YOUR_API_KEY')
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

async function loadKeys() {
  const data = await (await fetch('/api/keys')).json()
  keys = data.keys || []
  scopeLabels = data.scopes || {}
  renderKeys()

  // An account from before hashed storage still holds its key in the clear.
  // Say so, offer it one last time, and make replacing it the obvious move.
  const legacy = keys.find((k) => k.legacy)
  $('legacy-note').hidden = !legacy
  if (legacy) {
    $('legacy-note').innerHTML =
      `<b>Your original key predates hashed storage.</b> It still works. ` +
      `<a href="#" id="show-legacy">Show it one last time</a>, then replace it with a named key — ` +
      `after that it will not be displayed again.`
    $('show-legacy').onclick = async (e) => {
      e.preventDefault()
      const res = await fetch('/api/keys/legacy')
      if (!res.ok) return
      const { key } = await res.json()
      $('legacy-note').innerHTML = `<b>Your original key:</b> <span class="mono">${escapeHtml(key)}</span>`
    }
  }
}

async function load() {
  const [usage] = await Promise.all([
    fetch('/api/usage').then((r) => (r.ok ? r.json() : null)),
    loadKeys(),
  ])
  if (!usage) return (window.location.href = '/login')
  renderCode()
  $('m-today').textContent = usage.today.toLocaleString()
  $('m-month').textContent = usage.month.toLocaleString()
  $('m-limit').textContent = `${usage.dailyLimit.toLocaleString()}/day`
  $('m-plan').textContent = usage.plan === 'free' ? 'Free' : usage.plan.charAt(0).toUpperCase() + usage.plan.slice(1)
  Charts.line($('chart-usage'), usageSeries(usage.byDay))
}

/* ------------------------------ creating keys ----------------------------- */

function openKeyModal() {
  creating = true
  $('key-modal-title').textContent = 'New API key'
  $('key-name').value = ''
  $('key-form').hidden = false
  $('key-shown').hidden = true
  $('key-err').textContent = ''
  $('key-create').hidden = false
  $('key-cancel').textContent = 'Cancel'
  $('key-scopes').innerHTML = Object.entries(scopeLabels)
    .map(
      ([id, label]) => `<label class="scope-row">
        <input type="checkbox" value="${escapeHtml(id)}" checked />
        <span><span class="mono">${escapeHtml(id)}</span> ${escapeHtml(label)}</span>
      </label>`,
    )
    .join('')
  $('key-modal').classList.add('show')
  $('key-name').focus()
}

async function createKey() {
  const scopes = [...$('key-scopes').querySelectorAll('input:checked')].map((i) => i.value)
  if (!scopes.length) {
    $('key-err').textContent = 'Give the key at least one thing it may do.'
    return
  }
  $('key-create').disabled = true
  try {
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('key-name').value.trim(), scopes }),
    })
    const data = await res.json()
    if (!res.ok) {
      $('key-err').textContent = data.error || 'Could not create a key'
      return
    }
    // Shown once, here, and never again.
    $('key-form').hidden = true
    $('key-shown').hidden = false
    $('key-value').value = data.key
    $('key-modal-title').textContent = 'Copy your key'
    $('key-create').hidden = true
    $('key-cancel').textContent = 'Done'
    await loadKeys()
  } catch {
    $('key-err').textContent = 'Network error. Try again.'
  } finally {
    $('key-create').disabled = false
  }
}

async function revoke(id) {
  const key = keys.find((k) => k.id === id)
  if (!confirm(`Revoke "${key?.name || 'this key'}"? Anything using it stops working immediately.`)) return
  await fetch('/api/keys/' + encodeURIComponent(id), { method: 'DELETE' })
  await loadKeys()
}

$('new-key').addEventListener('click', openKeyModal)
$('key-create').addEventListener('click', createKey)
$('key-cancel').addEventListener('click', () => {
  $('key-modal').classList.remove('show')
  creating = false
})
$('key-copy').addEventListener('click', () => {
  navigator.clipboard?.writeText($('key-value').value).catch(() => {})
  $('key-copy').textContent = '✓'
  setTimeout(() => ($('key-copy').textContent = 'Copy'), 1200)
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
