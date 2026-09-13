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

const STATUS_TONE = {
  active: 'ok',
  pending_ssl: 'warn',
  pending_platform: 'warn',
  pending_dns: 'warn',
  dns_missing: 'warn',
  dns_incorrect: 'err',
  error: 'err',
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
         <b>Switched off on this deployment.</b>
         Branded hosts are not being served right now, so adding one would not do anything.
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
  const atLimit = data.limit !== null && domains.length >= data.limit
  $('dom-input').disabled = atLimit
  $('dom-add').disabled = atLimit

  $('dom-list').innerHTML =
    (domains.length
      ? domains.map((d) => domainRow(d, domains.length)).join('')
      : '<div class="chart-empty">No domains yet. Add one and we will show you the exact records to publish.</div>') +
    (atLimit
      ? `<div class="dom-hint">Your plan covers ${data.limit} domain${data.limit === 1 ? '' : 's'}. <a href="/account">See plans</a></div>`
      : '')

  $('dom-list').querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => delDomain(b.dataset.del)))
  $('dom-list').querySelectorAll('[data-verify]').forEach((b) => (b.onclick = () => verifyDomain(b.dataset.verify, b)))
  $('dom-list').querySelectorAll('[data-default]').forEach((b) => (b.onclick = () => setDefault(b.dataset.default)))
  $('dom-list').querySelectorAll('[data-save-redirects]').forEach((b) => {
    b.onclick = () => saveRedirects(b.dataset.saveRedirects, b)
  })
}

/** One DNS record, written the way a DNS panel asks for it. */
const recordRow = (r) => `<div class="dom-dns-row">
    <span>${r.purpose === 'ownership' ? 'Prove you own it' : 'Point it here'}</span>
    <code>${escapeHtml(r.type)} ${escapeHtml(r.name)} → ${escapeHtml(r.value)}</code>
  </div>`

/** What has been checked, and what is still outstanding. */
const checkRow = (c) => `<div class="dom-check ${c.ok ? 'ok' : 'pending'}">
    <span class="dom-check-mark">${c.ok ? '✓' : '•'}</span>
    <span class="dom-check-name">${escapeHtml(c.name)}</span>
    <span class="dom-check-detail">${escapeHtml(c.detail || '')}</span>
  </div>`

/**
 * One domain.
 *
 * A live domain shows its settings; one that is not yet live shows the records
 * to publish and which check is failing, because "pending" on its own is the
 * least useful thing a status can say.
 */
function domainRow(d, total) {
  const tone = STATUS_TONE[d.status] || 'warn'
  return `<div class="dom-row">
      <span class="mono">${escapeHtml(d.domain)}${d.isDefault && total > 1 ? ' <span class="dom-default">default</span>' : ''}</span>
      <span class="dom-status ${tone}">${escapeHtml(d.statusLabel || d.status)}</span>
      <span class="dom-row-actions">
        ${d.live ? '' : `<button class="btn btn-sm" data-verify="${escapeHtml(d.domain)}">Check DNS</button>`}
        ${d.live && !d.isDefault ? `<button class="btn btn-ghost btn-sm" data-default="${escapeHtml(d.domain)}">Make default</button>` : ''}
        <button class="icon-btn danger" data-del="${escapeHtml(d.domain)}" title="Remove">✕</button>
      </span>
    </div>
    ${d.message ? `<div class="dom-hint">${escapeHtml(d.message)}</div>` : ''}
    ${d.checks?.length ? `<div class="dom-checks">${d.checks.map(checkRow).join('')}</div>` : ''}
    ${
      d.live
        ? `<div class="dom-settings">
             <div class="dom-hint">Links already shared on the main domain keep working, always.</div>
             <label class="field-label">Where the bare domain goes</label>
             <input class="mono" data-root="${escapeHtml(d.domain)}" value="${escapeHtml(d.rootRedirect || '')}"
                    placeholder="https://yourbrand.com (optional)" />
             <label class="field-label">Where an unknown short code goes</label>
             <input class="mono" data-nf="${escapeHtml(d.domain)}" value="${escapeHtml(d.notFoundRedirect || '')}"
                    placeholder="https://yourbrand.com/links (optional)" />
             <button class="btn btn-sm" data-save-redirects="${escapeHtml(d.domain)}">Save</button>
           </div>`
        : `<div class="dom-dns">
             ${(d.records || []).map(recordRow).join('')}
             <div class="dom-dns-note">DNS can take a few minutes to spread. Press Check DNS once both records are published.</div>
           </div>`
    }`
}

async function verifyDomain(domain, btn) {
  btn.disabled = true
  btn.textContent = 'Checking...'
  try {
    const res = await fetch('/api/domains/' + encodeURIComponent(domain) + '/verify', { method: 'POST' })
    const data = await res.json()
    if (!res.ok) {
      $('dom-err').textContent = data.error || 'Could not check that domain'
      return
    }
    $('dom-err').textContent = ''
    await loadDomains()
    if (data.state === 'active') window.toast(domain + ' is live')
  } catch {
    $('dom-err').textContent = 'Network error. Try again.'
  } finally {
    btn.disabled = false
    btn.textContent = 'Check DNS'
  }
}

async function patchDomain(domain, body) {
  const res = await fetch('/api/domains/' + encodeURIComponent(domain), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Could not save')
  return data
}

async function setDefault(domain) {
  $('dom-err').textContent = ''
  try {
    await patchDomain(domain, { isDefault: true })
    await loadDomains()
    window.toast('New links will use ' + domain)
  } catch (err) {
    $('dom-err').textContent = err.message
  }
}

async function saveRedirects(domain, btn) {
  const root = document.querySelector(`[data-root="${CSS.escape(domain)}"]`)?.value.trim() || ''
  const nf = document.querySelector(`[data-nf="${CSS.escape(domain)}"]`)?.value.trim() || ''
  $('dom-err').textContent = ''
  btn.disabled = true
  try {
    await patchDomain(domain, { rootRedirect: root, notFoundRedirect: nf })
    await loadDomains()
    window.toast('Saved')
  } catch (err) {
    $('dom-err').textContent = err.message
  } finally {
    btn.disabled = false
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
