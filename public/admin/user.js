const { $, api, num, escapeHtml, timeAgo, fmtDate, statusPill, shortUrl, toast, confirmAction, promptText } = window.Admin
const id = new URLSearchParams(location.search).get('id')
let data = null

function actionButton(label, action, opts = {}) {
  return `<button class="btn btn-sm ${opts.danger ? 'btn-danger' : 'btn-ghost'}" data-action="${action}">${escapeHtml(label)}</button>`
}

function render() {
  const u = data.user
  const suspended = u.status === 'suspended'

  const actions = [
    suspended ? actionButton('Restore account', 'restore') : actionButton('Suspend account', 'suspend', { danger: true }),
    u.apiDisabled ? actionButton('Re-enable API', 'enable-api') : actionButton('Disable API', 'disable-api'),
    actionButton('Revoke API key', 'revoke-key', { danger: true }),
    actionButton('Add note', 'note'),
    u.role === 'admin' ? actionButton('Remove admin', 'demote', { danger: true }) : actionButton('Make admin', 'promote'),
  ].join('')

  $('panel').innerHTML = `
    <div class="admin-head">
      <div>
        <h1>${escapeHtml(u.email)}</h1>
        <p class="admin-sub">
          ${escapeHtml(u.name || '')} ·
          <span class="mono">${escapeHtml(u.id)}</span> ·
          joined ${fmtDate(u.createdAt)} via ${escapeHtml(u.provider)}
        </p>
      </div>
      <div class="admin-pills">
        <span class="pill pill-plan-${escapeHtml(u.plan)}">${escapeHtml(u.plan)}</span>
        ${statusPill(u.status)}
        ${u.role === 'admin' ? '<span class="pill pill-admin">admin</span>' : ''}
      </div>
    </div>

    ${suspended ? `<div class="admin-alert">
      Suspended ${timeAgo(u.suspendedAt)}${u.suspendedReason ? `: ${escapeHtml(u.suspendedReason)}` : ''}.
      They cannot sign in or use their API key.
    </div>` : ''}

    <div class="admin-kpis">
      <div class="card metric"><div class="label">Links</div><div class="value">${num(u.links)}</div></div>
      <div class="card metric"><div class="label">Clicks</div><div class="value">${num(u.clicks)}</div>
        <div class="metric-sub">${num(u.botClicks)} bot hits excluded</div></div>
      <div class="card metric"><div class="label">Campaigns</div><div class="value">${num(u.campaigns)}</div></div>
      <div class="card metric"><div class="label">API calls</div><div class="value">${num(u.apiCallsThisMonth)}</div>
        <div class="metric-sub">this month</div></div>
    </div>

    <section class="panel-card">
      <div class="panel-head"><h2>Actions</h2></div>
      <div class="admin-actions">${actions}</div>
      <p class="admin-hint">
        Suspension is reversible and takes effect immediately. There is no delete
        button here on purpose: removing an account would take its links and click
        history with it.
      </p>
    </section>

    ${(u.flaggedLinks || u.disabledLinks) ? `<div class="admin-alert admin-alert-warn">
      ${num(u.flaggedLinks)} flagged and ${num(u.disabledLinks)} disabled link(s) on this account.
    </div>` : ''}

    <section class="panel-card">
      <div class="panel-head">
        <h2>Account</h2>
      </div>
      <div class="kv">
        <div><span>Plan</span><span>${escapeHtml(u.plan)}</span></div>
        <div><span>Subscription</span><span>${escapeHtml(u.subscriptionStatus || 'none')}</span></div>
        <div><span>Stripe customer</span><span class="mono">${escapeHtml(u.stripeCustomerId || '—')}</span></div>
        <div><span>API key</span><span>${u.hasApiKey ? `present, created ${fmtDate(u.apiKeyCreatedAt)}` : 'none'}${u.apiDisabled ? ' (disabled)' : ''}</span></div>
        <div><span>Sign-in</span><span>${escapeHtml(u.provider)}</span></div>
      </div>
      <p class="admin-hint">The API key itself is never shown here, only whether one exists.</p>
    </section>

    <section class="panel-card">
      <div class="panel-head"><h2>Links</h2><span class="head-note">${num(data.links.length)} shown</span></div>
      <div class="atable atable-links-sm">
        ${data.links.length
          ? data.links.map((l) => `<div class="atable-row">
              <span class="at-main">
                <a class="tl-slug" href="/admin/links?q=${encodeURIComponent(l.slug)}">/${escapeHtml(l.slug)}</a>
                <span class="at-sub">${escapeHtml(shortUrl(l.url))}</span>
              </span>
              ${statusPill(l.status)}
              <span class="num">${num(l.clicks)}</span>
              <span class="at-date">${fmtDate(l.createdAt)}</span>
            </div>`).join('')
          : '<div class="chart-empty">No links on this account.</div>'}
      </div>
    </section>

    <section class="panel-card">
      <div class="panel-head"><h2>Internal notes</h2></div>
      <div id="notes">
        ${(u.notes || []).length
          ? [...u.notes].reverse().map((n) => `<div class="note-row">
              <div class="note-meta">${escapeHtml(n.byEmail || 'admin')} · ${timeAgo(n.at)}</div>
              <div class="note-text">${escapeHtml(n.text)}</div>
            </div>`).join('')
          : '<div class="chart-empty">No notes yet.</div>'}
      </div>
    </section>`

  $('panel').querySelectorAll('[data-action]').forEach((b) => (b.onclick = () => act(b.dataset.action)))
}

const NEEDS_REASON = { suspend: 'Why is this account being suspended?', note: 'Note', flag: 'Flag' }
const CONFIRMS = {
  suspend: { title: 'Suspend this account?', body: 'They will be signed out and their API key will stop working. This is reversible.' },
  'revoke-key': { title: 'Revoke this API key?', body: 'Any integration using the current key will break immediately. A new key is issued to the account.' },
  demote: { title: 'Remove admin access?', body: 'They will lose access to every admin page and action.' },
  promote: { title: 'Grant admin access?', body: 'They will be able to suspend accounts, disable links and see every account on the service.', danger: false },
}

async function act(action) {
  const confirmSpec = CONFIRMS[action]
  if (confirmSpec && !(await confirmAction({ confirmLabel: 'Yes, continue', ...confirmSpec }))) return

  let reason
  if (NEEDS_REASON[action]) {
    reason = await promptText({
      title: action === 'note' ? 'Add an internal note' : 'Reason',
      label: NEEDS_REASON[action],
      placeholder: 'Recorded in the audit log',
    })
    if (reason === null) return
  }

  try {
    await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: { action, reason } })
    toast('Done')
    await load()
  } catch (e) {
    toast(e.message, 'error')
  }
}

async function load() {
  data = await api(`/api/admin/users/${encodeURIComponent(id)}`)
  render()
}

;(async () => {
  if (!(await window.adminReady)) return
  if (!id) return (window.location.href = '/admin/users')
  await load()
})()
