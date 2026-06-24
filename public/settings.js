const $ = (id) => document.getElementById(id)
let plan = 'free'

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

async function loadProfile() {
  const res = await fetch('/api/account')
  if (res.status === 401) return (window.location.href = '/login')
  const u = (await res.json()).user
  plan = u.plan || 'free'
  $('name').value = u.name || ''
  $('email').textContent = u.email
  $('plan').textContent = plan === 'free' ? 'Free' : plan.charAt(0).toUpperCase() + plan.slice(1)
  if (plan !== 'free') $('plan').classList.add('pro')

  // Domains are a Business feature.
  if (plan === 'business') {
    $('dom-area').style.display = ''
    await loadDomains()
  } else {
    $('dom-locked').style.display = 'flex'
  }
}

async function loadDomains() {
  const domains = (await (await fetch('/api/domains')).json()).domains || []
  $('dom-list').innerHTML = domains.length
    ? domains
        .map(
          (d) => `<div class="dom-row">
            <span class="mono">${escapeHtml(d.domain)}</span>
            <span class="dom-status ${d.status}">${d.status === 'connected' ? 'Connected' : 'Pending verification'}</span>
            <button class="icon-btn danger" data-del="${escapeHtml(d.domain)}" title="Remove">✕</button>
          </div>
          <div class="dom-hint">Point a CNAME record for <b>${escapeHtml(d.domain)}</b> to <span class="mono">cname.vercel-dns.com</span>.</div>`,
        )
        .join('')
    : '<div class="chart-empty">No domains yet.</div>'
  $('dom-list')
    .querySelectorAll('[data-del]')
    .forEach((b) => (b.onclick = () => delDomain(b.dataset.del)))
}

async function addDomain() {
  const domain = $('dom-input').value.trim()
  if (!domain) return
  $('dom-err').textContent = ''
  const res = await fetch('/api/domains', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain }),
  })
  const data = await res.json()
  if (!res.ok) {
    $('dom-err').textContent = data.error || 'Could not add domain'
    return
  }
  $('dom-input').value = ''
  await loadDomains()
}

async function delDomain(domain) {
  await fetch('/api/domains/' + encodeURIComponent(domain), { method: 'DELETE' })
  await loadDomains()
}

$('save-name').addEventListener('click', async () => {
  const name = $('name').value.trim()
  $('save-name').disabled = true
  $('save-name').textContent = 'Saving...'
  try {
    await fetch('/api/account', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    window.toast('Saved')
  } finally {
    $('save-name').disabled = false
    $('save-name').textContent = 'Save'
  }
})

$('dom-add').addEventListener('click', addDomain)
$('dom-input').addEventListener('keydown', (e) => e.key === 'Enter' && addDomain())

;(async () => {
  const user = await window.shellReady
  if (!user) return
  await loadProfile()
})()
