const $ = (id) => document.getElementById(id)

const ICONS = {
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>',
  restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
}

let campaigns = []
let links = []
let editingId = null
let showArchived = false
let openCampaign = null

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c])
}

const num = (n) => Number(n || 0).toLocaleString()
const bare = (u) => String(u || '').replace(/^https?:\/\//, '')

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

function card(c) {
  // Clicks per link says more than clicks alone: a campaign with 8 links and
  // 4,000 clicks is not the same as one link that got lucky.
  const perLink = c.links ? Math.round(c.clicks / c.links) : 0
  return `<div class="camp-card ${c.archived ? 'camp-archived' : ''} ${openCampaign === c.id ? 'camp-open' : ''}" data-open="${escapeHtml(c.id)}">
    <div class="camp-head">
      <div class="camp-name">
        ${escapeHtml(c.name)}
        ${c.archived ? '<span class="pill pill-expired">archived</span>' : ''}
      </div>
      <div class="camp-actions">
        <button class="icon-btn" data-rename="${escapeHtml(c.id)}" title="Rename" aria-label="Rename">${ICONS.edit}</button>
        <button class="icon-btn" data-archive="${escapeHtml(c.id)}" title="${c.archived ? 'Unarchive' : 'Archive'}" aria-label="${c.archived ? 'Unarchive' : 'Archive'}">${c.archived ? ICONS.restore : ICONS.archive}</button>
        <button class="icon-btn danger" data-del="${escapeHtml(c.id)}" title="Delete" aria-label="Delete">${ICONS.trash}</button>
      </div>
    </div>
    <div class="camp-stats">
      <div><div class="cs-val">${num(c.links)}</div><div class="cs-lbl">Links</div></div>
      <div><div class="cs-val">${num(c.clicks)}</div><div class="cs-lbl">Clicks</div></div>
      <div><div class="cs-val">${num(c.visitors)}</div><div class="cs-lbl">Visitors</div></div>
      <div><div class="cs-val">${num(perLink)}</div><div class="cs-lbl">Per link</div></div>
    </div>
  </div>`
}

function render() {
  const visible = campaigns.filter((c) => showArchived || !c.archived)
  const archivedCount = campaigns.filter((c) => c.archived).length

  $('empty').hidden = campaigns.length > 0
  $('grid').hidden = campaigns.length === 0

  const totalClicks = visible.reduce((s, c) => s + (c.clicks || 0), 0)
  $('summary').textContent = campaigns.length
    ? `${num(visible.length)} campaign${visible.length === 1 ? '' : 's'} · ${num(totalClicks)} clicks`
    : 'Group links so you can compare them.'

  $('toggle-archived').hidden = archivedCount === 0
  $('toggle-archived').textContent = showArchived ? 'Hide archived' : `Show archived (${archivedCount})`

  // Busiest first: the campaign you care about is the one doing something.
  $('grid').innerHTML = [...visible].sort((a, b) => (b.clicks || 0) - (a.clicks || 0)).map(card).join('')

  $('grid').querySelectorAll('[data-rename]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); openRename(b.dataset.rename) }))
  $('grid').querySelectorAll('[data-archive]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); toggleArchive(b.dataset.archive) }))
  $('grid').querySelectorAll('[data-del]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); del(b.dataset.del) }))
  $('grid').querySelectorAll('[data-open]').forEach((el) => (el.onclick = () => openDetail(el.dataset.open)))

  renderDetail()
}

/** The links inside one campaign, ranked, so you can see which pulled. */
function renderDetail() {
  if (!openCampaign) return ($('detail').hidden = true)
  const c = campaigns.find((x) => x.id === openCampaign)
  if (!c) return ($('detail').hidden = true)

  const inCampaign = links.filter((l) => l.campaign === c.id).sort((a, b) => (b.clicks || 0) - (a.clicks || 0))
  const best = inCampaign[0]?.clicks || 0

  $('detail').hidden = false
  $('detail-name').textContent = c.name
  $('detail-analytics').href = `/analytics?campaign=${encodeURIComponent(c.id)}`
  $('detail-links').innerHTML = inCampaign.length
    ? inCampaign
        .map(
          (l) => `<div class="camp-link">
            <div class="camp-link-main">
              <a class="tl-slug" href="/link?slug=${encodeURIComponent(l.slug)}">/${escapeHtml(l.slug)}</a>
              <span class="tl-url">${escapeHtml(l.title || bare(l.url))}</span>
            </div>
            <div class="camp-link-bar">
              <div class="bar-track"><div class="bar-fill" style="width:${best ? (l.clicks / best) * 100 : 0}%"></div></div>
            </div>
            <div class="camp-link-nums">
              <span><b>${num(l.clicks)}</b> clicks</span>
              <span><b>${num(l.visitors)}</b> visitors</span>
            </div>
          </div>`,
        )
        .join('')
    : `<div class="chart-empty">
         No links in this campaign yet. Assign one from the
         <a href="/links">Links</a> page.
       </div>`
}

function openDetail(id) {
  openCampaign = openCampaign === id ? null : id
  render()
  if (openCampaign) $('detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

/* --------------------------------- actions -------------------------------- */

function openCreate() {
  editingId = null
  $('modal-title').textContent = 'New campaign'
  $('c-save').textContent = 'Create'
  $('c-name').value = ''
  $('c-err').textContent = ''
  $('modal').classList.add('show')
  $('c-name').focus()
}

function openRename(id) {
  const c = campaigns.find((x) => x.id === id)
  if (!c) return
  editingId = id
  $('modal-title').textContent = 'Rename campaign'
  $('c-save').textContent = 'Save'
  $('c-name').value = c.name
  $('c-err').textContent = ''
  $('modal').classList.add('show')
  $('c-name').select()
}

const closeModal = () => $('modal').classList.remove('show')

async function save() {
  const name = $('c-name').value.trim()
  if (!name) return
  $('c-save').disabled = true
  try {
    const res = await fetch(editingId ? '/api/campaigns/' + encodeURIComponent(editingId) : '/api/campaigns', {
      method: editingId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const data = await res.json()
    if (!res.ok) {
      $('c-err').textContent = data.error || 'Could not save that'
      if (data.needsUpgrade) $('c-err').innerHTML += ' <a href="/account">See plans</a>'
      return
    }
    closeModal()
    toast(editingId ? 'Renamed' : 'Campaign created')
    await load()
  } finally {
    $('c-save').disabled = false
  }
}

async function toggleArchive(id) {
  const c = campaigns.find((x) => x.id === id)
  if (!c) return
  await fetch('/api/campaigns/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived: !c.archived }),
  })
  toast(c.archived ? 'Unarchived' : 'Archived')
  await load()
}

async function del(id) {
  const c = campaigns.find((x) => x.id === id)
  if (!c) return
  // Deleting a campaign must not read as deleting its links.
  const msg = c.links
    ? `Delete "${c.name}"?\n\nIts ${c.links} link${c.links === 1 ? '' : 's'} are kept and keep working. They just lose this grouping.\n\nArchiving keeps the grouping and hides it instead.`
    : `Delete "${c.name}"?`
  if (!confirm(msg)) return
  await fetch('/api/campaigns/' + encodeURIComponent(id), { method: 'DELETE' })
  if (openCampaign === id) openCampaign = null
  toast('Campaign deleted')
  await load()
}

/* --------------------------------- loading -------------------------------- */

async function load() {
  const [cRes, lRes] = await Promise.all([fetch('/api/campaigns'), fetch('/api/links?limit=500')])
  if (cRes.status === 401) return (window.location.href = '/login')
  campaigns = (await cRes.json()).campaigns || []
  links = (await lRes.json()).links || []
  render()
}

$('new-campaign').addEventListener('click', openCreate)
$('empty-create').addEventListener('click', openCreate)
$('c-cancel').addEventListener('click', closeModal)
$('c-save').addEventListener('click', save)
$('c-name').addEventListener('keydown', (e) => e.key === 'Enter' && save())
$('modal').addEventListener('click', (e) => e.target === $('modal') && closeModal())
$('toggle-archived').addEventListener('click', () => {
  showArchived = !showArchived
  render()
})
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeModal())

;(async () => {
  const user = await window.shellReady
  if (!user) return
  await load()
})()
