const $ = (id) => document.getElementById(id)

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

async function load() {
  const res = await fetch('/api/campaigns')
  if (res.status === 401) return (window.location.href = '/login')
  const list = (await res.json()).campaigns
  $('empty').style.display = list.length ? 'none' : 'block'
  $('grid').innerHTML = list
    .map(
      (c) => `<div class="camp-card">
        <div class="camp-head">
          <div class="camp-name">${escapeHtml(c.name)}</div>
          <button class="icon-btn danger" data-del="${c.id}" title="Delete">✕</button>
        </div>
        <div class="camp-stats">
          <div><div class="cs-val">${c.links.toLocaleString()}</div><div class="cs-lbl">Links</div></div>
          <div><div class="cs-val">${c.clicks.toLocaleString()}</div><div class="cs-lbl">Clicks</div></div>
          <div><div class="cs-val">${c.visitors.toLocaleString()}</div><div class="cs-lbl">Visitors</div></div>
        </div>
      </div>`,
    )
    .join('')
  $('grid').querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => del(b.dataset.del)))
}

async function del(id) {
  if (!confirm('Delete this campaign? Links stay, but lose their campaign tag.')) return
  await fetch('/api/campaigns/' + id, { method: 'DELETE' })
  await load()
}

function openModal() {
  $('c-name').value = ''
  $('c-err').textContent = ''
  $('modal').classList.add('show')
  $('c-name').focus()
}
function closeModal() {
  $('modal').classList.remove('show')
}
async function save() {
  const name = $('c-name').value.trim()
  if (!name) return
  $('c-save').disabled = true
  try {
    const res = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const data = await res.json()
    if (!res.ok) {
      $('c-err').textContent = data.error || 'Could not create'
      return
    }
    closeModal()
    await load()
  } finally {
    $('c-save').disabled = false
  }
}

$('create').addEventListener('click', openModal)
$('c-cancel').addEventListener('click', closeModal)
$('c-save').addEventListener('click', save)
$('c-name').addEventListener('keydown', (e) => e.key === 'Enter' && save())
$('modal').addEventListener('click', (e) => e.target === $('modal') && closeModal())

;(async () => {
  const user = await window.shellReady
  if (!user) return
  await load()
})()
