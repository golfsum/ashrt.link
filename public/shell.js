// Shared app shell: sidebar nav, auth gating, user footer, logout, toasts.
// Each app page sets <body data-page="..."> and includes <aside id="sidebar">.

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: '▦', href: '/dashboard' },
  { id: 'links', label: 'Links', icon: '🔗', href: '/links' },
  { id: 'analytics', label: 'Analytics', icon: '📈', href: '/analytics' },
  { id: 'qr', label: 'QR Codes', icon: '▣', href: '/qr' },
  { id: 'campaigns', label: 'Campaigns', icon: '◎', href: '/campaigns' },
  { id: 'api', label: 'API', icon: '⌘', href: '/developers' },
  { id: 'billing', label: 'Billing', icon: '▤', href: '/account' },
  { id: 'settings', label: 'Settings', icon: '⚙', href: '/settings' },
]

const page = document.body.dataset.page || ''
const sidebar = document.getElementById('sidebar')

if (sidebar) {
  const navHtml = NAV.map((n) => {
    const active = n.id === page ? ' active' : ''
    const href = n.soon ? '#' : n.href
    const soon = n.soon ? ' data-soon' : ''
    const badge = n.soon ? ' <span class="soon-badge">Soon</span>' : ''
    return `<a href="${href}"${soon} class="${active.trim()}"><span class="ic">${n.icon}</span> ${n.label}${badge}</a>`
  }).join('')

  sidebar.innerHTML = `
    <a class="brand" href="/">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="#14141b" stroke="#2a2a38" />
        <path d="M13 19l6-6M12.5 14.5l-2 2a3.5 3.5 0 0 0 5 5l2-2M19.5 17.5l2-2a3.5 3.5 0 0 0-5-5l-2 2"
          fill="none" stroke="#818cf8" stroke-width="2" stroke-linecap="round" />
      </svg>
      ashrt<span class="dot">.link</span>
    </a>
    <nav class="side-nav">${navHtml}</nav>
    <div class="sidebar-foot">
      <div class="su"><div id="su-name" class="su-name">—</div><div id="su-plan" class="su-plan">Free</div></div>
      <a id="logout" href="#" class="su-logout" title="Log out">⏻</a>
    </div>`

  sidebar.addEventListener('click', (e) => {
    const soon = e.target.closest('[data-soon]')
    if (soon) {
      e.preventDefault()
      window.toast('That section is coming soon')
      return
    }
    if (e.target.closest('#logout')) {
      e.preventDefault()
      fetch('/auth/logout', { method: 'POST' }).then(() => (window.location.href = '/'))
    }
  })
}

window.toast = function (msg) {
  const t = document.createElement('div')
  t.className = 'toast'
  t.textContent = msg
  document.body.appendChild(t)
  setTimeout(() => t.classList.add('show'), 10)
  setTimeout(() => {
    t.classList.remove('show')
    setTimeout(() => t.remove(), 300)
  }, 1800)
}

function guestTokens() {
  try {
    const rows = JSON.parse(localStorage.getItem('ashrt_guest_links') || '[]')
    return Array.isArray(rows) ? rows.map((r) => r?.token).filter(Boolean).slice(0, 20) : []
  } catch {
    return []
  }
}

function clearGuestTokens() {
  try { localStorage.removeItem('ashrt_guest_links') } catch {}
}

async function claimGuestLinksIfVerified(user) {
  if (!user?.emailVerified) return
  const tokens = guestTokens()
  if (!tokens.length) return
  try {
    const res = await fetch('/api/guest/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokens }),
    })
    if (res.ok) clearGuestTokens()
  } catch {}
}

function showVerificationBanner(user) {
  if (!user?.verificationRequired || document.getElementById('verify-email-banner')) return
  const bar = document.createElement('div')
  bar.id = 'verify-email-banner'
  bar.style.cssText = 'position:sticky;top:0;z-index:50;display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;padding:10px 16px;background:#2a2105;border-bottom:1px solid #6b5310;color:#fef3c7;font:600 13px Inter,system-ui,sans-serif;text-align:center'
  bar.innerHTML = `<span>Verify ${String(user.email || '').replace(/[&<>\"]/g, '')} before creating permanent links or using account features.</span><button id="resend-verification" style="border:1px solid #a9861b;background:#f59e0b;color:#111827;border-radius:8px;padding:6px 10px;font-weight:800;cursor:pointer">Resend email</button>`
  document.body.prepend(bar)
  const btn = document.getElementById('resend-verification')
  btn.onclick = async () => {
    btn.disabled = true
    btn.textContent = 'Sending...'
    try {
      const res = await fetch('/api/verification/resend', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      window.toast(res.ok ? 'Verification email sent' : data.error || 'Could not send verification email')
    } catch {
      window.toast('Could not send verification email')
    } finally {
      btn.disabled = false
      btn.textContent = 'Resend email'
    }
  }
}

// Resolves to the signed-in user, or redirects to /login. Pages await this.
window.shellReady = (async () => {
  let user = null
  try {
    const res = await fetch('/auth/me', { cache: 'no-store' })
    if (res.ok) user = (await res.json()).user
  } catch {}
  if (!user) {
    window.location.href = '/login'
    return null
  }
  window.ME = user
  const nm = document.getElementById('su-name')
  const pl = document.getElementById('su-plan')
  if (nm) nm.textContent = user.email
  if (pl) {
    pl.textContent = user.plan === 'business' ? 'Business' : user.plan === 'pro' ? 'Pro' : 'Free'
    if (user.plan === 'pro' || user.plan === 'business') pl.classList.add('pro')
  }
  showVerificationBanner(user)
  claimGuestLinksIfVerified(user)
  if (new URLSearchParams(location.search).get('verified') === '1') window.toast('Email verified')
  return user
})()
