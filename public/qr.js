const $ = (id) => document.getElementById(id)

let links = []
let entitled = false
let style = null
let saved = null

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c])
}

/**
 * The URL for one link's code.
 *
 * Addressed by short code rather than by URL, so the server decides which host
 * the code encodes (a branded domain, when the account has one) and adds the
 * marker that tells a scan apart from a click.
 */
const codeUrl = (slug, extra = {}) =>
  '/api/qr?' + new URLSearchParams({ slug, ...extra }).toString()

/* -------------------------------- the grid -------------------------------- */

function render() {
  $('empty').hidden = links.length > 0
  $('grid').innerHTML = links
    .map(
      (l) => `<div class="qr-card">
        <div class="qr-img"><img src="${codeUrl(l.slug, { v: String(version) })}" alt="QR code for ${escapeHtml(l.slug)}" loading="lazy" /></div>
        <div class="qr-slug mono">/${escapeHtml(l.slug)}</div>
        <div class="qr-url">${escapeHtml(String(l.shortUrl).replace(/^https?:\/\//, ''))}</div>
        ${
          l.scans
            ? `<div class="qr-scans">${Number(l.scans).toLocaleString()} scan${l.scans === 1 ? '' : 's'}</div>`
            : '<div class="qr-scans qr-scans-none">No scans yet</div>'
        }
        <div class="qr-card-actions">
          <button class="btn btn-ghost btn-sm" data-png="${escapeHtml(l.slug)}">PNG</button>
          <a class="btn btn-ghost btn-sm" href="${codeUrl(l.slug, { download: '1', name: l.slug })}">SVG</a>
          <button class="btn btn-ghost btn-sm" data-print="${escapeHtml(l.slug)}">Print</button>
        </div>
      </div>`,
    )
    .join('')

  $('grid').querySelectorAll('[data-png]').forEach((b) => (b.onclick = () => downloadPng(b.dataset.png, b)))
  $('grid').querySelectorAll('[data-print]').forEach((b) => (b.onclick = () => printCode(b.dataset.print)))
}

/** Bumped whenever the style changes, so browsers do not show the old code. */
let version = 0

/* ------------------------------- downloading ------------------------------ */

/**
 * PNG, rendered from the SVG in the browser.
 *
 * The styled code is drawn as SVG on the server; turning it into a PNG here
 * means any resolution is available without a rasteriser on the server, and the
 * high-resolution export people need for print is just a bigger canvas.
 */
async function downloadPng(slug, btn, px = 1024) {
  const label = btn.textContent
  btn.disabled = true
  btn.textContent = '…'
  try {
    const res = await fetch(codeUrl(slug, { size: String(px) }))
    const svg = await res.text()
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)

    const img = new Image()
    img.decoding = 'sync'
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = reject
      img.src = url
    })

    const canvas = document.createElement('canvas')
    canvas.width = img.width || px
    canvas.height = img.height || px
    const ctx = canvas.getContext('2d')
    // A transparent background stays transparent; anything else was already
    // painted into the SVG.
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    URL.revokeObjectURL(url)

    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = `${slug}.png`
    a.click()
  } catch {
    window.toast('Could not build the PNG. The SVG download always works.')
  } finally {
    btn.disabled = false
    btn.textContent = label
  }
}

function printCode(slug) {
  const w = window.open('', '_blank', 'width=420,height=560')
  if (!w) return
  w.document.write(
    `<title>QR ${escapeHtml(slug)}</title>
     <body style="font-family:system-ui,sans-serif;text-align:center;padding:40px">
       <img src="${codeUrl(slug, { size: '600' })}" style="width:260px" />
       <p style="font-family:monospace">/${escapeHtml(slug)}</p>
     </body>`,
  )
  w.document.close()
  w.focus()
  setTimeout(() => w.print(), 400)
}

/* -------------------------------- the editor ------------------------------ */

function fillControls() {
  $('fg').value = style.dark || '#0A0A0A'
  $('transparent').checked = style.light === 'transparent'
  $('bg').value = style.light === 'transparent' ? '#FFFFFF' : style.light || '#FFFFFF'
  $('bg').disabled = $('transparent').checked
  $('style').value = style.style || 'square'
  $('eyeStyle').value = style.eyeStyle || 'square'
  $('caption').value = style.caption || ''
  $('frame').checked = Boolean(style.frame)
  $('logo-clear').hidden = !style.logo
}

function readControls() {
  return {
    dark: $('fg').value,
    light: $('transparent').checked ? 'transparent' : $('bg').value,
    style: $('style').value,
    eyeStyle: $('eyeStyle').value,
    caption: $('caption').value.trim(),
    frame: $('frame').checked,
    logo: style.logo || null,
  }
}

/**
 * Preview, drawn by the same renderer that will serve the real thing.
 *
 * The controls are sent as overrides rather than saved first, so the preview is
 * the actual output and not an approximation of it, and nothing is written
 * until Save is pressed.
 */
let previewTimer = null
function schedulePreview() {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(updatePreview, 120)
}

async function updatePreview() {
  const slug = links[0]?.slug
  if (!slug) {
    $('preview').innerHTML = '<div class="chart-empty">Create a link to see its code</div>'
    $('preview-note').textContent = ''
    return
  }
  const next = readControls()
  const params = new URLSearchParams({
    slug,
    size: '320',
    color: next.dark.replace('#', ''),
    bg: next.light === 'transparent' ? 'transparent' : next.light.replace('#', ''),
    style: next.style,
    eyes: next.eyeStyle,
    caption: next.caption,
    frame: next.frame ? '1' : '0',
  })
  const res = await fetch('/api/qr?' + params.toString())
  $('preview').innerHTML = await res.text()
  $('preview-note').textContent = `Previewing /${slug}`
}

async function save() {
  const body = readControls()
  $('qr-err').textContent = ''
  $('save').disabled = true
  try {
    const res = await fetch('/api/qr/style', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, dark: body.dark.replace('#', ''), light: body.light === 'transparent' ? 'transparent' : body.light.replace('#', '') }),
    })
    const data = await res.json()
    if (!res.ok) {
      $('qr-err').textContent = data.error || 'Could not save'
      return
    }
    style = data.style
    saved = JSON.stringify(style)
    version++
    fillControls()
    render()
    await updatePreview()
    window.toast('Style saved')
  } catch {
    $('qr-err').textContent = 'Network error. Try again.'
  } finally {
    $('save').disabled = false
  }
}

function wireEditor() {
  for (const id of ['fg', 'bg', 'style', 'eyeStyle', 'caption', 'frame', 'transparent']) {
    $(id).addEventListener('input', () => {
      $('bg').disabled = $('transparent').checked
      schedulePreview()
    })
  }
  $('save').addEventListener('click', save)
  $('logo-pick').addEventListener('click', () => $('logo-file').click())
  $('logo-clear').addEventListener('click', () => {
    style.logo = null
    $('logo-clear').hidden = true
    schedulePreview()
  })
  $('logo-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    $('qr-err').textContent = ''
    if (file.size > 48 * 1024) {
      $('qr-err').textContent = 'That image is over 48KB. A small square mark works best.'
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      style.logo = String(reader.result)
      $('logo-clear').hidden = false
      $('qr-err').textContent = 'Press Save style to apply the logo.'
    }
    reader.readAsDataURL(file)
  })
}

/* --------------------------------- startup -------------------------------- */

;(async () => {
  const user = await window.shellReady
  if (!user) return

  const [linkRes, styleRes] = await Promise.all([fetch('/api/links?limit=200'), fetch('/api/qr/style')])
  if (linkRes.status === 401) return (window.location.href = '/login')

  links = (await linkRes.json()).links || []
  const styleData = await styleRes.json()
  style = styleData.style
  entitled = styleData.entitled
  saved = JSON.stringify(style)

  $('pro-banner').hidden = entitled
  $('editor').hidden = !entitled
  if (entitled) {
    fillControls()
    wireEditor()
    await updatePreview()
  }
  render()
})()
