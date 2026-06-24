const $ = (id) => document.getElementById(id)

function render(links) {
  $('empty').style.display = links.length ? 'none' : 'block'
  $('grid').innerHTML = links
    .map((l) => {
      const d = encodeURIComponent(l.shortUrl)
      const name = encodeURIComponent(l.slug)
      return `<div class="qr-card">
        <div class="qr-img"><img src="/api/qr?data=${d}&format=svg" alt="QR for ${l.slug}" /></div>
        <div class="qr-slug mono">/${l.slug}</div>
        <div class="qr-url">${l.shortUrl.replace(/^https?:\/\//, '')}</div>
        <div class="qr-card-actions">
          <a class="btn btn-ghost btn-sm" href="/api/qr?data=${d}&format=png&download=1&name=${name}">PNG</a>
          <a class="btn btn-ghost btn-sm" href="/api/qr?data=${d}&format=svg&download=1&name=${name}">SVG</a>
          <button class="btn btn-ghost btn-sm" data-print="${d}" data-target="${l.shortUrl}">Print</button>
        </div>
      </div>`
    })
    .join('')

  $('grid').querySelectorAll('[data-print]').forEach((b) => {
    b.onclick = () => {
      const w = window.open('', '_blank', 'width=420,height=520')
      w.document.write(
        `<title>QR ${b.dataset.target}</title><body style="font-family:sans-serif;text-align:center;padding:40px"><img src="/api/qr?data=${b.dataset.print}&format=svg" style="width:240px"/><p style="font-family:monospace">${b.dataset.target}</p></body>`,
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
  const res = await fetch('/api/links')
  if (res.status === 401) return (window.location.href = '/login')
  render((await res.json()).links)
})()
