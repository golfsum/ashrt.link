const $ = (id) => document.getElementById(id)
const COLOR_KEY = 'ashrt_qr_color'
let links = []
let paid = false
let color = localStorage.getItem(COLOR_KEY) || '#0A0A0A'

// Build a /api/qr URL, adding the brand color only for paid users.
function qrUrl(shortUrl, format, download, name) {
  const params = new URLSearchParams({ data: shortUrl, format })
  if (download) {
    params.set('download', '1')
    params.set('name', name)
  }
  if (paid && color && color.toLowerCase() !== '#0a0a0a') params.set('color', color.replace('#', ''))
  return '/api/qr?' + params.toString()
}

function render() {
  $('empty').style.display = links.length ? 'none' : 'block'
  $('grid').innerHTML = links
    .map(
      (l) => `<div class="qr-card">
        <div class="qr-img"><img src="${qrUrl(l.shortUrl, 'svg')}" alt="QR for ${l.slug}" /></div>
        <div class="qr-slug mono">/${l.slug}</div>
        <div class="qr-url">${l.shortUrl.replace(/^https?:\/\//, '')}</div>
        <div class="qr-card-actions">
          <a class="btn btn-ghost btn-sm" href="${qrUrl(l.shortUrl, 'png', true, l.slug)}">PNG</a>
          <a class="btn btn-ghost btn-sm" href="${qrUrl(l.shortUrl, 'svg', true, l.slug)}">SVG</a>
          <button class="btn btn-ghost btn-sm" data-print="${l.shortUrl}">Print</button>
        </div>
      </div>`,
    )
    .join('')

  $('grid')
    .querySelectorAll('[data-print]')
    .forEach((b) => {
      b.onclick = () => {
        const w = window.open('', '_blank', 'width=420,height=520')
        w.document.write(
          `<title>QR ${b.dataset.print}</title><body style="font-family:sans-serif;text-align:center;padding:40px"><img src="${qrUrl(
            b.dataset.print,
            'svg',
          )}" style="width:240px"/><p style="font-family:monospace">${b.dataset.print}</p></body>`,
        )
        w.document.close()
        w.focus()
        setTimeout(() => w.print(), 300)
      }
    })
}

;(async () => {
  const user = await window.shellReady
  if (!user) return
  paid = ['pro', 'business'].includes(user.plan)
  if (paid) {
    $('pro-banner').style.display = 'none'
    $('brand-bar').style.display = 'flex'
    $('brand-color').value = color
    $('brand-color').addEventListener('input', (e) => {
      color = e.target.value
      localStorage.setItem(COLOR_KEY, color)
      render()
    })
    $('brand-reset').addEventListener('click', () => {
      color = '#0A0A0A'
      localStorage.setItem(COLOR_KEY, color)
      $('brand-color').value = color
      render()
    })
  }
  const res = await fetch('/api/links')
  if (res.status === 401) return (window.location.href = '/login')
  links = (await res.json()).links
  render()
})()
