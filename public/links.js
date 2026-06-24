const $ = (id) => document.getElementById(id)
let links = []
let campaignList = []
let editingSlug = null

async function loadCampaigns() {
  try {
    campaignList = (await (await fetch('/api/campaigns')).json()).campaigns || []
  } catch {
    campaignList = []
  }
  $('m-campaign').innerHTML =
    '<option value="">No campaign</option>' +
    campaignList.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}
const shortLabel = (url) => url.replace(/^https?:\/\//, '')
function fmtDate(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

async function load() {
  const res = await fetch('/api/links')
  if (res.status === 401) return (window.location.href = '/login')
  links = (await res.json()).links
  render()
}

function visible() {
  const q = $('search').value.trim().toLowerCase()
  let list = links.filter((l) => !q || l.slug.toLowerCase().includes(q) || l.url.toLowerCase().includes(q))
  const sort = $('sort').value
  if (sort === 'clicks') list.sort((a, b) => (b.clicks || 0) - (a.clicks || 0))
  else if (sort === 'visitors') list.sort((a, b) => (b.visitors || 0) - (a.visitors || 0))
  else list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return list
}

function render() {
  const list = visible()
  $('empty').style.display = list.length ? 'none' : 'block'
  $('rows').innerHTML = list
    .map(
      (l) => `
      <div class="ltable-row">
        <span class="lt-short"><a class="tl-slug" href="${l.shortUrl}" target="_blank" rel="noreferrer">/${l.slug}</a></span>
        <span class="lt-dest" title="${escapeHtml(l.url)}">${escapeHtml(shortLabel(l.url))}</span>
        <span class="num">${(l.clicks || 0).toLocaleString()}</span>
        <span class="num">${(l.visitors || 0).toLocaleString()}</span>
        <span class="lt-date">${fmtDate(l.createdAt)}</span>
        <span><span class="status-pill">Active</span></span>
        <span class="lt-actions">
          <button class="icon-btn" data-copy="${l.shortUrl}" title="Copy">⧉</button>
          <button class="icon-btn" data-qr="${l.slug}" title="QR code">▣</button>
          <a class="icon-btn" href="/link?slug=${encodeURIComponent(l.slug)}" title="Analytics">📈</a>
          <button class="icon-btn" data-edit="${l.slug}" title="Edit">✎</button>
          <button class="icon-btn danger" data-del="${l.slug}" title="Delete">✕</button>
        </span>
      </div>`,
    )
    .join('')

  $('rows').querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => copy(b.dataset.copy, b)))
  $('rows').querySelectorAll('[data-qr]').forEach((b) => (b.onclick = () => openQr(b.dataset.qr)))
  $('rows').querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => openEdit(b.dataset.edit)))
  $('rows').querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => del(b.dataset.del)))
}

function copy(text, btn) {
  navigator.clipboard?.writeText(text).catch(() => {})
  if (btn) {
    const old = btn.textContent
    btn.textContent = '✓'
    setTimeout(() => (btn.textContent = old), 1000)
  }
}

async function del(slug) {
  if (!confirm(`Delete /${slug}? This can't be undone.`)) return
  await fetch('/api/links/' + slug, { method: 'DELETE' })
  await load()
}

/* ------------------------------ create / edit ----------------------------- */

function openCreate() {
  editingSlug = null
  $('modal-title').textContent = 'Create a link'
  $('m-save').textContent = 'Create'
  $('m-url').value = ''
  $('m-alias').value = ''
  $('m-alias').style.display = ''
  $('m-campaign').value = ''
  $('m-err').textContent = ''
  $('modal').classList.add('show')
  $('m-url').focus()
}
function openEdit(slug) {
  const l = links.find((x) => x.slug === slug)
  if (!l) return
  editingSlug = slug
  $('modal-title').textContent = `Edit /${slug}`
  $('m-save').textContent = 'Save'
  $('m-url').value = l.url
  $('m-alias').style.display = 'none' // alias (slug) can't change
  $('m-campaign').value = l.campaign || ''
  $('m-err').textContent = ''
  $('modal').classList.add('show')
  $('m-url').focus()
}
function closeModal() {
  $('modal').classList.remove('show')
}
async function save() {
  const url = $('m-url').value.trim()
  if (!url) return
  $('m-save').disabled = true
  try {
    const campaign = $('m-campaign').value || null
    let res
    if (editingSlug) {
      res = await fetch('/api/links/' + editingSlug, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, campaign }),
      })
    } else {
      res = await fetch('/api/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, alias: $('m-alias').value.trim() || undefined, campaign }),
      })
    }
    const data = await res.json()
    if (!res.ok) {
      $('m-err').textContent = data.error || 'Something went wrong'
      return
    }
    closeModal()
    await load()
  } finally {
    $('m-save').disabled = false
  }
}

/* ---------------------------------- QR ------------------------------------ */

function openQr(slug) {
  const l = links.find((x) => x.slug === slug)
  if (!l) return
  const data = encodeURIComponent(l.shortUrl)
  $('qr-preview').innerHTML = `<img src="/api/qr?data=${data}&format=svg" alt="QR code for ${l.slug}" />`
  $('qr-target').textContent = l.shortUrl
  $('qr-png').href = `/api/qr?data=${data}&format=png&download=1&name=${encodeURIComponent(l.slug)}`
  $('qr-svg').href = `/api/qr?data=${data}&format=svg&download=1&name=${encodeURIComponent(l.slug)}`
  $('qr-modal').dataset.slug = slug
  $('qr-modal').classList.add('show')
}
function printQr() {
  const img = $('qr-preview').innerHTML
  const target = $('qr-target').textContent
  const w = window.open('', '_blank', 'width=420,height=520')
  w.document.write(
    `<title>QR ${target}</title><body style="font-family:sans-serif;text-align:center;padding:40px">${img}<p style="font-family:monospace">${target}</p></body>`,
  )
  w.document.close()
  w.focus()
  w.print()
}

/* --------------------------------- wire up -------------------------------- */

$('create-link').addEventListener('click', openCreate)
$('m-cancel').addEventListener('click', closeModal)
$('m-save').addEventListener('click', save)
$('m-url').addEventListener('keydown', (e) => e.key === 'Enter' && save())
$('m-alias').addEventListener('keydown', (e) => e.key === 'Enter' && save())
$('modal').addEventListener('click', (e) => e.target === $('modal') && closeModal())
$('search').addEventListener('input', render)
$('sort').addEventListener('change', render)
$('qr-close').addEventListener('click', () => $('qr-modal').classList.remove('show'))
$('qr-print').addEventListener('click', printQr)
$('qr-modal').addEventListener('click', (e) => e.target === $('qr-modal') && $('qr-modal').classList.remove('show'))

;(async () => {
  const user = await window.shellReady
  if (!user) return
  await loadCampaigns()
  await load()
})()
