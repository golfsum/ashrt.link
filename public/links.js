const $ = (id) => document.getElementById(id)

/** Inline SVG, so an action icon never renders as a missing-glyph box. */
const ICONS = {
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  qr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM19 19h2v2h-2z" stroke-linecap="round"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
}

let links = []
let campaigns = []
let editingSlug = null
let activeTag = ''
let cursor = 0
let hasMore = false
let searchTimer = null

/* -------------------------------- helpers -------------------------------- */

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c])
}

const num = (n) => Number(n || 0).toLocaleString()
const bare = (url) => String(url || '').replace(/^https?:\/\//, '')

function fmtDate(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function timeAgo(ts) {
  if (!ts) return 'never'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return d < 30 ? `${d}d ago` : fmtDate(ts)
}

const statusPill = (s) => `<span class="pill pill-${escapeHtml(s)}">${escapeHtml(s)}</span>`
const campaignName = (id) => campaigns.find((c) => c.id === id)?.name || null

function toast(msg) {
  const t = document.createElement('div')
  t.className = 'toast'
  t.textContent = msg
  document.body.appendChild(t)
  setTimeout(() => t.classList.add('show'), 10)
  setTimeout(() => {
    t.classList.remove('show')
    setTimeout(() => t.remove(), 300)
  }, 2000)
}

/* -------------------------------- rendering ------------------------------- */

function row(l) {
  const camp = campaignName(l.campaign)
  const meta = [
    camp ? `<span class="lt-chip">${escapeHtml(camp)}</span>` : '',
    ...(l.tags || []).map((t) => `<button class="lt-chip lt-tag" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`),
  ].join('')

  return `<div class="ltable-row">
    <span class="lt-main">
      <span class="lt-top">
        <a class="tl-slug" href="${escapeHtml(l.shortUrl)}" target="_blank" rel="noreferrer">/${escapeHtml(l.slug)}</a>
        ${l.status !== 'active' ? statusPill(l.status) : ''}
      </span>
      ${l.title ? `<span class="lt-name">${escapeHtml(l.title)}</span>` : ''}
      <span class="lt-dest" title="${escapeHtml(l.url)}">${escapeHtml(bare(l.url))}</span>
      ${meta ? `<span class="lt-meta">${meta}</span>` : ''}
    </span>
    <span class="lt-stat"><b>${num(l.clicks)}</b><em>clicks</em></span>
    <span class="lt-stat"><b>${num(l.visitors)}</b><em>visitors</em></span>
    <span class="lt-stat lt-stat-wide"><b>${timeAgo(l.lastClickAt)}</b><em>last click</em></span>
    <span class="lt-actions">
      <button class="icon-btn" data-copy="${escapeHtml(l.shortUrl)}" title="Copy link" aria-label="Copy link">${ICONS.copy}</button>
      <button class="icon-btn" data-qr="${escapeHtml(l.slug)}" title="QR code" aria-label="QR code">${ICONS.qr}</button>
      <a class="icon-btn" href="/link?slug=${encodeURIComponent(l.slug)}" title="Analytics" aria-label="Analytics">${ICONS.chart}</a>
      <button class="icon-btn" data-edit="${escapeHtml(l.slug)}" title="Edit" aria-label="Edit">${ICONS.edit}</button>
      <button class="icon-btn danger" data-del="${escapeHtml(l.slug)}" title="Delete" aria-label="Delete">${ICONS.trash}</button>
    </span>
  </div>`
}

function render() {
  const filtering = Boolean($('search').value.trim() || $('status').value || $('campaign').value || activeTag)

  $('empty').hidden = links.length > 0
  $('rows').closest('.table-card').hidden = links.length === 0
  if (!links.length) {
    $('empty-title').textContent = filtering ? 'Nothing matches those filters' : 'No links yet'
    $('empty-body').textContent = filtering
      ? 'Try a different search, or clear the filters.'
      : 'Create your first tracking link and it will appear here.'
    $('empty-create').hidden = filtering
  }

  $('rows').innerHTML = links.length
    ? `<div class="ltable-row ltable-head">
         <span>Link</span><span>Clicks</span><span>Visitors</span><span>Last click</span><span></span>
       </div>` + links.map(row).join('')
    : ''

  $('rows').querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => copy(b.dataset.copy, b)))
  $('rows').querySelectorAll('[data-qr]').forEach((b) => (b.onclick = () => openQr(b.dataset.qr)))
  $('rows').querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => openEdit(b.dataset.edit)))
  $('rows').querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => del(b.dataset.del)))
  $('rows').querySelectorAll('[data-tag]').forEach((b) => (b.onclick = () => setTag(b.dataset.tag)))

  $('more').hidden = !hasMore
  renderTagbar()
}

function renderTagbar() {
  const tags = [...new Set(links.flatMap((l) => l.tags || []))].sort()
  if (!tags.length && !activeTag) return ($('tagbar').innerHTML = '')
  $('tagbar').innerHTML =
    (activeTag ? `<button class="lt-chip lt-chip-active" data-clear>Tag: ${escapeHtml(activeTag)} ✕</button>` : '') +
    tags
      .filter((t) => t !== activeTag)
      .map((t) => `<button class="lt-chip" data-tagbar="${escapeHtml(t)}">${escapeHtml(t)}</button>`)
      .join('')
  $('tagbar').querySelectorAll('[data-tagbar]').forEach((b) => (b.onclick = () => setTag(b.dataset.tagbar)))
  $('tagbar').querySelector('[data-clear]')?.addEventListener('click', () => setTag(''))
}

function setTag(tag) {
  activeTag = activeTag === tag ? '' : tag
  load()
}

/* --------------------------------- loading -------------------------------- */

async function loadCampaigns() {
  try {
    campaigns = (await (await fetch('/api/campaigns')).json()).campaigns || []
  } catch {
    campaigns = []
  }
  const options = '<option value="">No campaign</option>' +
    campaigns.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('')
  $('m-campaign').innerHTML = options
  $('campaign').innerHTML =
    '<option value="">Any campaign</option>' +
    campaigns.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('')
}

async function load({ append = false } = {}) {
  const params = new URLSearchParams()
  const q = $('search').value.trim()
  if (q) params.set('q', q)
  if ($('status').value) params.set('status', $('status').value)
  if ($('campaign').value) params.set('campaign', $('campaign').value)
  if (activeTag) params.set('tag', activeTag)
  params.set('sort', $('sort').value)
  params.set('limit', '50')
  params.set('cursor', append ? cursor : 0)

  const res = await fetch('/api/links?' + params)
  if (res.status === 401) return (window.location.href = '/login')
  const data = await res.json()

  links = append ? [...links, ...data.links] : data.links
  cursor = data.nextCursor ?? 0
  hasMore = data.nextCursor !== null

  const shown = data.total === data.totalLinks ? '' : ` (${num(data.total)} shown)`
  $('summary').textContent =
    `${num(data.totalLinks)} link${data.totalLinks === 1 ? '' : 's'} · ${num(data.totalClicks)} total clicks${shown}`
  render()
}

/* ------------------------------- create/edit ------------------------------ */

function resetModal() {
  $('m-url').value = ''
  $('m-alias').value = ''
  $('m-title').value = ''
  $('m-tags').value = ''
  $('m-campaign').value = ''
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign']) $(k).value = ''
  $('m-err').textContent = ''
}

function openCreate() {
  editingSlug = null
  resetModal()
  $('modal-title').textContent = 'Create a link'
  $('m-save').textContent = 'Create'
  $('alias-field').hidden = false
  $('m-utm-wrap').hidden = false
  $('modal').classList.add('show')
  $('m-url').focus()
}

function openEdit(slug) {
  const l = links.find((x) => x.slug === slug)
  if (!l) return
  editingSlug = slug
  resetModal()
  $('modal-title').textContent = `Edit /${slug}`
  $('m-save').textContent = 'Save'
  $('m-url').value = l.url
  $('m-title').value = l.title || ''
  $('m-tags').value = (l.tags || []).join(', ')
  $('m-campaign').value = l.campaign || ''
  // The short code is part of every copy of the link already shared, so it
  // cannot change. UTM tags are already baked into the destination above.
  $('alias-field').hidden = true
  $('m-utm-wrap').hidden = true
  $('modal').classList.add('show')
  $('m-url').focus()
}

const closeModal = () => $('modal').classList.remove('show')

function utmValues() {
  const utm = {}
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign']) {
    const v = $(k).value.trim()
    if (v) utm[k] = v
  }
  return Object.keys(utm).length ? utm : undefined
}

async function save() {
  const url = $('m-url').value.trim()
  if (!url) return
  $('m-save').disabled = true
  $('m-err').textContent = ''

  const tags = $('m-tags').value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 10)
  const body = {
    url,
    title: $('m-title').value.trim() || undefined,
    campaign: $('m-campaign').value || null,
    tags,
  }
  if (!editingSlug) {
    if ($('m-alias').value.trim()) body.alias = $('m-alias').value.trim()
    body.utm = utmValues()
  }

  try {
    const res = await fetch(editingSlug ? '/api/links/' + encodeURIComponent(editingSlug) : '/api/links', {
      method: editingSlug ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) {
      $('m-err').textContent = data.error || 'Something went wrong'
      if (data.needsUpgrade) $('m-err').innerHTML += ' <a href="/account">See plans</a>'
      return
    }
    closeModal()
    toast(editingSlug ? 'Link updated' : 'Link created')
    await load()
  } catch {
    $('m-err').textContent = 'Network error. Try again.'
  } finally {
    $('m-save').disabled = false
  }
}

async function del(slug) {
  const l = links.find((x) => x.slug === slug)
  const clicks = l?.clicks || 0
  const warning = clicks
    ? `This deletes /${slug} and its ${num(clicks)} recorded click${clicks === 1 ? '' : 's'}. Anyone who already has the link will get a 404.`
    : `This deletes /${slug}. Anyone who already has the link will get a 404.`
  if (!confirm(warning + '\n\nThis cannot be undone.')) return
  await fetch('/api/links/' + encodeURIComponent(slug), { method: 'DELETE' })
  toast(`/${slug} deleted`)
  await load()
}

function copy(text, btn) {
  navigator.clipboard?.writeText(text).catch(() => {})
  const old = btn.innerHTML
  btn.innerHTML = ICONS.check
  btn.classList.add('icon-btn-ok')
  setTimeout(() => {
    btn.innerHTML = old
    btn.classList.remove('icon-btn-ok')
  }, 1000)
}

function openQr(slug) {
  const l = links.find((x) => x.slug === slug)
  if (!l) return
  const d = encodeURIComponent(l.shortUrl)
  $('qr-preview').innerHTML = `<img src="/api/qr?data=${d}&format=svg" alt="QR code for ${escapeHtml(slug)}" />`
  $('qr-target').textContent = l.shortUrl
  $('qr-png').href = `/api/qr?data=${d}&format=png&download=1&name=${encodeURIComponent(slug)}`
  $('qr-svg').href = `/api/qr?data=${d}&format=svg&download=1&name=${encodeURIComponent(slug)}`
  $('qr-modal').classList.add('show')
}

/* --------------------------------- wire up -------------------------------- */

$('create-link').addEventListener('click', openCreate)
$('empty-create').addEventListener('click', openCreate)
$('m-cancel').addEventListener('click', closeModal)
$('m-save').addEventListener('click', save)
$('m-url').addEventListener('keydown', (e) => e.key === 'Enter' && save())
$('modal').addEventListener('click', (e) => e.target === $('modal') && closeModal())

$('search').addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => load(), 250)
})
for (const id of ['status', 'campaign', 'sort']) $(id).addEventListener('change', () => load())
$('more').addEventListener('click', () => load({ append: true }))

$('qr-close').addEventListener('click', () => $('qr-modal').classList.remove('show'))
$('qr-modal').addEventListener('click', (e) => e.target === $('qr-modal') && $('qr-modal').classList.remove('show'))

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModal()
    $('qr-modal').classList.remove('show')
  }
})

;(async () => {
  const user = await window.shellReady
  if (!user) return
  await loadCampaigns()
  await load()
})()
