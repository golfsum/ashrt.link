// Shared admin shell: nav, auth gate, fetch helpers, formatters.
//
// Nothing here is a security control. The server refuses admin API calls and
// even the admin pages themselves to anyone without the role; this file just
// keeps the UI honest about what it is showing.

;(function () {
  const NAV = [
    { id: 'overview', label: 'Overview', href: '/admin' },
    { id: 'funnel', label: 'Funnel', href: '/admin/funnel' },
    { id: 'users', label: 'Users', href: '/admin/users' },
    { id: 'links', label: 'Links', href: '/admin/links' },
    { id: 'billing', label: 'Billing', href: '/admin/billing' },
    { id: 'abuse', label: 'Abuse', href: '/admin/abuse' },
    { id: 'audit', label: 'Audit log', href: '/admin/audit' },
    { id: 'health', label: 'Health', href: '/admin/health' },
  ]

  const page = document.body.dataset.page || ''

  const bar = document.getElementById('adminbar')
  if (bar) {
    bar.innerHTML = `
      <div class="admin-bar-inner">
        <a class="admin-brand" href="/admin">
          <span class="admin-badge">ADMIN</span>
          ashrt<span class="dot">.link</span>
        </a>
        <nav class="admin-nav">
          ${NAV.map((n) => `<a href="${n.href}" class="${n.id === page ? 'active' : ''}">${n.label}</a>`).join('')}
        </nav>
        <div class="admin-who">
          <span id="admin-email">—</span>
          <a href="/dashboard" title="Back to your own dashboard">Exit</a>
        </div>
      </div>`
  }

  /* -------------------------------- helpers -------------------------------- */

  const $ = (id) => document.getElementById(id)

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c])
  }

  const num = (n) => Number(n || 0).toLocaleString()

  function timeAgo(ts) {
    if (!ts) return '—'
    const s = Math.floor((Date.now() - ts) / 1000)
    if (s < 60) return 'just now'
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    const d = Math.floor(h / 24)
    if (d < 30) return `${d}d ago`
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  const fmtDate = (ts) =>
    ts ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

  const statusPill = (status) =>
    `<span class="pill pill-${escapeHtml(status)}">${escapeHtml(status)}</span>`

  /** Shorten a destination for a table cell without hiding the domain. */
  function shortUrl(url, max = 52) {
    const bare = String(url || '').replace(/^https?:\/\//, '')
    return bare.length > max ? bare.slice(0, max) + '…' : bare
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    })
    if (res.status === 404 || res.status === 401) {
      // Either the session went away or the role did. Either way this page is
      // no longer ours to show.
      window.location.href = '/'
      throw new Error('not authorized')
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
    return data
  }

  function toast(msg, kind = '') {
    const t = document.createElement('div')
    t.className = 'toast' + (kind ? ' toast-' + kind : '')
    t.textContent = msg
    document.body.appendChild(t)
    setTimeout(() => t.classList.add('show'), 10)
    setTimeout(() => {
      t.classList.remove('show')
      setTimeout(() => t.remove(), 300)
    }, 2600)
  }

  /**
   * Confirmation for anything destructive. `typeToConfirm` demands the exact
   * text back, which is the difference between a misclick and an intention.
   */
  function confirmAction({ title, body, confirmLabel = 'Confirm', typeToConfirm = null, danger = true }) {
    return new Promise((resolve) => {
      const el = document.createElement('div')
      el.className = 'modal-backdrop show'
      el.innerHTML = `
        <div class="modal">
          <h3>${escapeHtml(title)}</h3>
          <p class="modal-body">${body}</p>
          ${typeToConfirm ? `<input id="cf-input" class="mono" placeholder="${escapeHtml(typeToConfirm)}" autocomplete="off" />` : ''}
          <div class="modal-actions">
            <button class="btn btn-ghost" data-cancel>Cancel</button>
            <button class="btn ${danger ? 'btn-danger' : ''}" data-ok ${typeToConfirm ? 'disabled' : ''}>${escapeHtml(confirmLabel)}</button>
          </div>
        </div>`
      document.body.appendChild(el)

      const ok = el.querySelector('[data-ok]')
      const input = el.querySelector('#cf-input')
      if (input) {
        input.addEventListener('input', () => {
          ok.disabled = input.value.trim() !== typeToConfirm
        })
        setTimeout(() => input.focus(), 50)
      }

      const close = (result) => {
        el.remove()
        resolve(result)
      }
      ok.addEventListener('click', () => close(true))
      el.querySelector('[data-cancel]').addEventListener('click', () => close(false))
      el.addEventListener('click', (e) => e.target === el && close(false))
    })
  }

  /** Ask for a short piece of text (a reason, a note, a domain). */
  function promptText({ title, label, placeholder = '', confirmLabel = 'Save', required = true }) {
    return new Promise((resolve) => {
      const el = document.createElement('div')
      el.className = 'modal-backdrop show'
      el.innerHTML = `
        <div class="modal">
          <h3>${escapeHtml(title)}</h3>
          <label class="field-label">${escapeHtml(label)}</label>
          <textarea id="pt-input" rows="3" placeholder="${escapeHtml(placeholder)}"></textarea>
          <div class="modal-actions">
            <button class="btn btn-ghost" data-cancel>Cancel</button>
            <button class="btn" data-ok ${required ? 'disabled' : ''}>${escapeHtml(confirmLabel)}</button>
          </div>
        </div>`
      document.body.appendChild(el)

      const ok = el.querySelector('[data-ok]')
      const input = el.querySelector('#pt-input')
      if (required) input.addEventListener('input', () => (ok.disabled = !input.value.trim()))
      setTimeout(() => input.focus(), 50)

      const close = (result) => {
        el.remove()
        resolve(result)
      }
      ok.addEventListener('click', () => close(input.value.trim()))
      el.querySelector('[data-cancel]').addEventListener('click', () => close(null))
      el.addEventListener('click', (e) => e.target === el && close(null))
    })
  }

  /** Resolves once we know an admin is looking at this page. */
  window.adminReady = (async () => {
    try {
      const res = await fetch('/auth/me', { cache: 'no-store' })
      if (!res.ok) throw new Error('anon')
      const { user } = await res.json()
      if (user.role !== 'admin') throw new Error('not admin')
      const who = document.getElementById('admin-email')
      if (who) who.textContent = user.email
      return user
    } catch {
      window.location.href = '/'
      return null
    }
  })()

  window.Admin = { $, api, escapeHtml, num, timeAgo, fmtDate, statusPill, shortUrl, toast, confirmAction, promptText }

})()
