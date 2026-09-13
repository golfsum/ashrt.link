const $ = (id) => document.getElementById(id)

// Landing pages embed the same tool but not the pricing table, so every
// optional element is addressed defensively rather than assumed.
const on = (id, ev, fn) => $(id)?.addEventListener(ev, fn)
let user = null
let lastLink = null

async function init() {
  try {
    const res = await fetch('/auth/me')
    if (res.ok) user = (await res.json()).user
  } catch {
    /* anonymous is the normal case here */
  }

  if ($('nav')) $('nav').innerHTML = user
    ? `<a href="/dashboard">Dashboard</a><a href="/account">Account</a>`
    : `<a href="/login">Log in</a><a class="btn btn-sm" href="/signup">Get started</a>`

  // Custom aliases need an account. Show the field either way so people can see
  // what an account gets them, but say so plainly rather than hiding it.
  if ($('alias')) {
    if (user) {
      if ($('alias-lock')) $('alias-lock').textContent = ''
      $('alias').disabled = false
    } else {
      $('alias').disabled = true
      $('alias').placeholder = 'Free account required'
    }
  }

  renderPlans()
}

/**
 * The pricing block, rendered from /api/plans like every other place prices
 * appear. There is no hand-written table on this page: when the homepage kept
 * its own copy it was the first thing to go stale after a price change.
 */
async function renderPlans() {
  const target = $('home-plans')
  if (!target || !window.Plans) return
  try {
    const data = await Plans.load()
    const me = await Plans.whoami()
    target.innerHTML = data.plans
      // Six lines a card on the homepage; /pricing has the full comparison.
      .map((p) => Plans.card(p, { user: me, interval: Plans.interval, data, limit: 6, blurb: false }))
      .join('')
    Plans.wire(document)
  } catch {
    target.innerHTML =
      '<p class="pricing-sub">Could not load the plans just now. <a href="/pricing">See pricing</a>.</p>'
  }
}

function utmValues() {
  const utm = {}
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
    const v = $(key)?.value.trim()
    if (v) utm[key] = v
  }
  return Object.keys(utm).length ? utm : undefined
}

/** Pages that do not show an error slot simply fall back to an alert. */
function setErr(text, extraHtml = '') {
  const el = $('err')
  if (!el) {
    if (text) window.alert(text)
    return
  }
  el.textContent = text
  if (extraHtml) el.innerHTML += extraHtml
}

async function create(e) {
  e?.preventDefault()
  const url = $('url').value.trim()
  if (!url) return

  setErr('')
  $('go').disabled = true
  // Each page words its own button ("Make the QR code", "Create a tracking
  // link"). Remember it rather than putting one page's wording on all of them.
  const goLabel = $('go').dataset.label || ($('go').dataset.label = $('go').textContent)
  $('go').textContent = 'Creating...'

  try {
    const body = { url, utm: utmValues() }
    const alias = $('alias')?.value.trim()
    if (user && alias) body.alias = alias

    const res = await fetch('/api/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()

    if (!res.ok) {
      setErr(
        data.error || 'Could not create that link',
        data.needsAccount
          ? ' <a href="/signup">Create a free account</a>'
          : data.needsUpgrade
            ? ' <a href="/account">See plans</a>'
            : '',
      )
      return
    }

    lastLink = data
    if (!user && data.manageToken) window.GuestLinks.add(data)

    $('result-link').textContent = data.shortUrl.replace(/^https?:\/\//, '')
    $('result-link').href = data.shortUrl
    $('result-clicks').textContent = '0 clicks so far'

    // A guest's analytics live behind their management token; a signed-in user
    // already has the link in their dashboard.
    $('result-stats').href = user
      ? `/link?slug=${encodeURIComponent(data.slug)}`
      : data.manageUrl || '#'

    if (data.expiresInDays && !user) {
      $('result-expiry').textContent = `Kept for ${data.expiresInDays} days`
      $('result-save').hidden = false
      $('result-save').href = `/signup?claim=${encodeURIComponent(data.manageToken)}`
    } else {
      $('result-expiry').textContent = ''
      $('result-save').hidden = true
    }

    $('result').hidden = false
    $('url').value = ''
    $('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' })

    // On a page whose whole purpose is the code, showing the link and making
    // people press one more button to see it is a strange way to answer the
    // thing they came for.
    if (document.body.dataset.autoQr) openQr()
  } catch {
    setErr('Network error. Try again.')
  } finally {
    $('go').disabled = false
    $('go').textContent = goLabel
  }
}

function openQr() {
  if (!lastLink) return
  const d = encodeURIComponent(lastLink.shortUrl)
  $('qr-preview').innerHTML = `<img src="/api/qr?data=${d}&format=svg" alt="QR code" />`
  $('qr-target').textContent = lastLink.shortUrl
  $('qr-png').href = `/api/qr?data=${d}&format=png&download=1&name=${encodeURIComponent(lastLink.slug)}`
  $('qr-svg').href = `/api/qr?data=${d}&format=svg&download=1&name=${encodeURIComponent(lastLink.slug)}`
  $('qr-modal').classList.add('show')
}

on('create-form', 'submit', create)

on('more-toggle', 'click', () => {
  const adv = $('advanced')
  adv.hidden = !adv.hidden
  $('more-toggle').textContent = adv.hidden ? 'Add a campaign or UTM tags' : 'Hide options'
})

on('result-copy', 'click', () => {
  navigator.clipboard?.writeText($('result-link').href).catch(() => {})
  $('result-copy').textContent = 'Copied'
  setTimeout(() => ($('result-copy').textContent = 'Copy'), 1200)
})

on('result-qr', 'click', openQr)
on('qr-close', 'click', () => $('qr-modal').classList.remove('show'))
on('qr-modal', 'click', (e) => e.target === $('qr-modal') && $('qr-modal').classList.remove('show'))


init()

// The related row is the same on every landing page, so drop the link to the
// page you are already on rather than maintaining a per-page list.
;(() => {
  const here = location.pathname.replace(/\/$/, '') || '/'
  document.querySelectorAll('.related-links a').forEach((a) => {
    if (new URL(a.href, location.origin).pathname.replace(/\/$/, '') === here) a.remove()
  })
  const row = document.querySelector('.related')
  if (row && !row.querySelectorAll('.related-links a').length) row.remove()
})()

// Any example short link in the copy is rendered from the server's configured
// domain, so a sample never reads as "localhost:4000/abc123" on a live page.
;(async () => {
  const samples = document.querySelectorAll('[data-sample-link]')
  if (!samples.length) return
  try {
    const { displayBase } = await (await fetch('/api/config')).json()
    if (!displayBase) return
    samples.forEach((el) => {
      const code = el.dataset.sampleLink || el.textContent.split('/').pop() || 'a1b2c3'
      el.textContent = `${displayBase}/${code}`
    })
  } catch {
    // Leave the static example in place rather than blanking it.
  }
})()
