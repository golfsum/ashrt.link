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

  await loadDomains()
}

async function loadDomains() {
  const data = await (await fetch('/api/domains')).json()
  const domains = data.domains || []

  // The server decides whether the feature is live for this deployment.
  if (!data.available) {
    $('dom-area').style.display = ''
    $('dom-locked').style.display = 'none'
    $('dom-input').disabled = true
    $('dom-add').disabled = true
    $('dom-list').innerHTML =
      `<div class="notice">
         <b>Not switched on yet.</b>
         The routing is built and tested, but your domain also has to be pointed
         at this deployment at the hosting level before it can serve anything.
       </div>` +
      (domains.length
        ? `<div class="dom-hint">Domains you added earlier are still saved: ` +
          domains.map((d) => `<span class="mono">${escapeHtml(d.domain)}</span>`).join(', ') +
          `</div>`
        : '')
    return
  }

  if (!data.entitled) {
    $('dom-locked').style.display = 'flex'
    return
  }

  $('dom-area').style.display = ''
  $('dom-input').disabled = false
  $('dom-add').disabled = false

  $('dom-list').innerHTML = domains.length
    ? domains.map(domainRow).join('')
    : '<div class="chart-empty">No domains yet. Add one and we will show you the DNS records to publish.</div>'

  $('dom-list').querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => delDomain(b.dataset.del)))
  $('dom-list').querySelectorAll('[data-verify]').forEach((b) => (b.onclick = () => verifyDomain(b.dataset.verify, b)))
}

/** One domain, with the exact DNS records to publish while it is pending. */
function domainRow(d) {
  const verified = d.status === 'verified'
  return `<div class="dom-row">
      <span class="mono">${escapeHtml(d.domain)}</span>
      <span class="dom-status ${escapeHtml(d.status)}">${verified ? 'Verified' : 'Pending verification'}</span>
      <span class="dom-row-actions">
        ${verified ? '' : `<button class="btn btn-sm" data-verify="${escapeHtml(d.domain)}">Check DNS</button>`}
        <button class="icon-btn danger" data-del="${escapeHtml(d.domain)}" title="Remove">✕</button>
      </span>
    </div>
    ${verified
      ? `<div class="dom-hint">Your new links are created on <b>${escapeHtml(d.domain)}</b>. Links already shared on the main domain keep working.</div>`
      : `<div class="dom-dns">
           <div class="dom-dns-row"><span>1. Prove you own it</span><code>TXT _ashrt.${escapeHtml(d.domain)} → ${escapeHtml(d.token || '')}</code></div>
           <div class="dom-dns-row"><span>2. Point it here</span><code>CNAME ${escapeHtml(d.domain)} → ${escapeHtml(d.dns?.cname?.value || '')}</code></div>
           <div class="dom-dns-note">DNS can take a few minutes. Press Check DNS once both records are published.</div>
         </div>`}`
}

async function verifyDomain(domain, btn) {
  btn.disabled = true
  btn.textContent = 'Checking...'
  try {
    const res = await fetch('/api/domains/' + encodeURIComponent(domain) + '/verify', { method: 'POST' })
    const data = await res.json()
    if (!res.ok) {
      $('dom-err').textContent = data.error || 'Could not verify that domain'
      return
    }
    $('dom-err').textContent = ''
    await loadDomains()
  } catch {
    $('dom-err').textContent = 'Network error. Try again.'
  } finally {
    btn.disabled = false
    btn.textContent = 'Check DNS'
  }
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
