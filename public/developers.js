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

/* -------------------------------- webhooks -------------------------------- */

let hooks = []
let hookEvents = {}
let hooksEntitled = false

function renderHooks() {
  if (!hooksEntitled) {
    $('hooks').innerHTML =
      '<div class="notice">Webhooks are part of the Business plan. <a href="/account">See plans</a></div>'
    $('new-hook').hidden = true
    return
  }
  $('new-hook').hidden = false

  $('hooks').innerHTML = hooks.length
    ? `<div class="key-list">${hooks
        .map(
          (h) => `<div class="key-item">
            <div class="key-main">
              <span class="key-name mono">${escapeHtml(h.url)}</span>
              ${h.active ? '' : '<span class="pill pill-flagged">off</span>'}
            </div>
            <div class="key-scopes">${(h.events || []).map((e) => `<span class="scope-chip">${escapeHtml(e)}</span>`).join('')}</div>
            <div class="key-meta">
              last delivery ${when(h.lastDeliveryAt)}${h.lastStatus ? ` · HTTP ${h.lastStatus}` : ''}${
                h.failures ? ` · ${h.failures} failed in a row` : ''
              }${h.disabledReason ? ` · ${escapeHtml(h.disabledReason)}` : ''}
            </div>
            <div class="hook-actions">
              <button class="btn btn-ghost btn-sm" data-test="${escapeHtml(h.id)}">Send a test</button>
              ${h.active ? '' : `<button class="btn btn-ghost btn-sm" data-enable="${escapeHtml(h.id)}">Turn back on</button>`}
              <button class="icon-btn danger" data-drop="${escapeHtml(h.id)}" title="Remove">✕</button>
            </div>
          </div>`,
        )
        .join('')}</div>`
    : '<div class="chart-empty">No endpoints yet.</div>'

  $('hooks').querySelectorAll('[data-drop]').forEach((b) => (b.onclick = () => dropHook(b.dataset.drop)))
  $('hooks').querySelectorAll('[data-test]').forEach((b) => (b.onclick = () => testHook(b.dataset.test, b)))
  $('hooks').querySelectorAll('[data-enable]').forEach((b) => (b.onclick = () => enableHook(b.dataset.enable)))
}

async function loadHooks() {
  const data = await (await fetch('/api/webhooks')).json()
  hooks = data.webhooks || []
  hookEvents = data.events || {}
  hooksEntitled = Boolean(data.entitled)
  renderHooks()
}

function openHookModal() {
  $('hook-url').value = ''
  $('hook-form').hidden = false
  $('hook-shown').hidden = true
  $('hook-err').textContent = ''
  $('hook-create').hidden = false
  $('hook-cancel').textContent = 'Cancel'
  $('hook-modal-title').textContent = 'Add an endpoint'
  // The daily summary is off by default: it is the noisiest of them, and
  // somebody adding an endpoint usually wants the lifecycle events first.
  $('hook-events').innerHTML = Object.entries(hookEvents)
    .map(
      ([id, label]) => `<label class="scope-row">
        <input type="checkbox" value="${escapeHtml(id)}" ${id === 'clicks.summary' ? '' : 'checked'} />
        <span><span class="mono">${escapeHtml(id)}</span> ${escapeHtml(label)}</span>
      </label>`,
    )
    .join('')
  $('hook-modal').classList.add('show')
  $('hook-url').focus()
}

async function createHook() {
  const events = [...$('hook-events').querySelectorAll('input:checked')].map((i) => i.value)
  if (!events.length) {
    $('hook-err').textContent = 'Choose at least one event.'
    return
  }
  $('hook-create').disabled = true
  try {
    const res = await fetch('/api/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: $('hook-url').value.trim(), events }),
    })
    const data = await res.json()
    if (!res.ok) {
      $('hook-err').textContent = data.error || 'Could not add that endpoint'
      return
    }
    // Shown once, like a key. It is what proves a delivery came from us.
    $('hook-form').hidden = true
    $('hook-shown').hidden = false
    $('hook-secret').value = data.secret
    $('hook-modal-title').textContent = 'Copy your signing secret'
    $('hook-create').hidden = true
    $('hook-cancel').textContent = 'Done'
    await loadHooks()
  } catch {
    $('hook-err').textContent = 'Network error. Try again.'
  } finally {
    $('hook-create').disabled = false
  }
}

async function testHook(id, btn) {
  const label = btn.textContent
  btn.disabled = true
  btn.textContent = 'Sending…'
  try {
    const res = await fetch(`/api/webhooks/${encodeURIComponent(id)}/test`, { method: 'POST' })
    const data = await res.json()
    window.toast(
      data.ok ? `Delivered, HTTP ${data.status}` : `Not delivered: ${data.error || 'HTTP ' + data.status}`,
    )
    await loadHooks()
  } finally {
    btn.disabled = false
    btn.textContent = label
  }
}

async function enableHook(id) {
  await fetch(`/api/webhooks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: true }),
  })
  await loadHooks()
}

async function dropHook(id) {
  const hook = hooks.find((h) => h.id === id)
  if (!confirm(`Remove ${hook?.url || 'this endpoint'}? We will stop sending to it.`)) return
  await fetch(`/api/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' })
  await loadHooks()
}

$('new-hook').addEventListener('click', openHookModal)
$('hook-create').addEventListener('click', createHook)
$('hook-cancel').addEventListener('click', () => $('hook-modal').classList.remove('show'))
$('hook-copy').addEventListener('click', () => {
  navigator.clipboard?.writeText($('hook-secret').value).catch(() => {})
  $('hook-copy').textContent = '✓'
  setTimeout(() => ($('hook-copy').textContent = 'Copy'), 1200)
})

;(async () => {
  const user = await window.shellReady
  if (!user) return
  await Promise.all([load(), loadHooks()])
})()
