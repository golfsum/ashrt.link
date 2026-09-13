/**
 * Plan rendering, in one place.
 *
 * The homepage, the pricing page and the account page all show the same three
 * plans. When each of them had its own copy of the table, two of the three were
 * always out of date — so there is one copy, it reads from /api/plans, and
 * every number on it is the number the server enforces.
 *
 * Nothing here decides what anything costs. It decides how to draw what the
 * server said, and where each button goes.
 */
;(function () {
  const state = { data: null, user: undefined, interval: 'monthly' }

  const esc = (s) =>
    String(s == null ? '' : s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    )

  /** One fetch per page load, shared by every widget on it. */
  async function load() {
    if (state.data) return state.data
    const res = await fetch('/api/plans', { cache: 'no-store' })
    if (!res.ok) throw new Error('plans')
    state.data = await res.json()
    return state.data
  }

  /** Who is looking. Undefined until asked; null means nobody is signed in. */
  async function whoami() {
    if (state.user !== undefined) return state.user
    try {
      const res = await fetch('/auth/me', { cache: 'no-store' })
      state.user = res.ok ? (await res.json()).user : null
    } catch {
      state.user = null
    }
    return state.user
  }

  /** Is annual billing actually configured for anything? */
  const annualOffered = (data) =>
    Object.values(data.available || {}).some((a) => a && a.annual)

  /**
   * What this person's button should say and do.
   *
   * The four cases that matter: not signed in, on this plan already, on a
   * smaller plan, on a bigger one. Sending somebody who is already signed in
   * back through signup is the bug this exists to prevent.
   */
  function cta(plan, { user, interval, data }) {
    const current = user ? user.plan || 'free' : null
    const order = (data.plans || []).map((p) => p.id)
    const buyable = plan.id === 'free' || (data.available?.[plan.id] || {})[interval]

    if (plan.id === 'free') {
      if (!user) return { label: 'Start free', href: '/signup' }
      if (current === 'free') return { label: 'Your current plan', current: true }
      // A paid subscriber choosing Free is cancelling, and cancelling happens
      // in Stripe's portal, where the dates and the refund rules are theirs.
      return { label: 'Switch to Free', action: 'portal' }
    }

    if (!buyable) {
      return {
        label: interval === 'annual' ? 'Annual billing coming soon' : 'Not available yet',
        disabled: true,
      }
    }
    // Signed out: sign up first, carrying the choice so checkout opens straight
    // after, rather than dropping somebody on a dashboard to find it again.
    if (!user) return { label: plan.ctaLabel, href: `/signup?plan=${plan.id}` }
    if (current === plan.id) return { label: 'Your current plan', current: true }
    if (order.indexOf(plan.id) < order.indexOf(current)) {
      return { label: `Switch to ${plan.label}`, action: 'portal' }
    }
    return { label: plan.ctaLabel, action: 'checkout', plan: plan.id }
  }

  function ctaHtml(c, { featured }) {
    const cls = `btn ${featured ? '' : 'btn-ghost'} price-cta`
    if (c.current) return `<span class="${cls} price-cta-current" aria-disabled="true">${esc(c.label)}</span>`
    if (c.disabled) return `<button class="${cls}" disabled>${esc(c.label)}</button>`
    if (c.href) return `<a class="${cls}" href="${esc(c.href)}">${esc(c.label)}</a>`
    return `<button class="${cls}" data-plan-action="${esc(c.action)}" data-plan="${esc(c.plan || '')}">${esc(c.label)}</button>`
  }

  /** Price line for a card, in the interval being shown. */
  function priceHtml(plan, interval) {
    if (!plan.paid) return `<div class="plan-price">$0<span>/mo</span></div>`
    if (interval === 'annual') {
      return `<div class="plan-price">${esc(plan.price.perMonthOnAnnualLabel)}<span>/mo</span></div>
        <div class="plan-price-note">${esc(plan.price.annualLabel)} billed yearly · save ${plan.price.savingPercent}%</div>`
    }
    return `<div class="plan-price">${esc(plan.price.monthlyLabel)}<span>/mo</span></div>
      <div class="plan-price-note">Billed monthly, cancel any time</div>`
  }

  /**
   * A plan card. `limit` caps the feature list so the homepage can stay short
   * without keeping a second, shorter, hand-written list of its own.
   */
  function card(plan, opts) {
    const c = cta(plan, opts)
    const points = (plan.highlights || []).slice(0, opts.limit || 99)
    return `<article class="plan${plan.featured ? ' plan-featured' : ''}">
      ${plan.featured ? '<div class="plan-badge">Most popular</div>' : ''}
      <div class="plan-name">${esc(plan.label)}</div>
      ${priceHtml(plan, opts.interval)}
      ${opts.blurb === false ? '' : `<p class="plan-blurb">${esc(plan.blurb)}</p>`}
      <ul class="plan-points">${points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      ${ctaHtml(c, { featured: plan.featured })}
    </article>`
  }

  /** The monthly / annual switch. Absent entirely when there is no annual price. */
  function toggleHtml(data) {
    if (!annualOffered(data)) return ''
    const pro = (data.plans || []).find((p) => p.id === 'pro')
    const save = pro ? pro.price.savingPercent : 0
    return `<div class="billing-toggle" role="group" aria-label="Billing period">
        <button data-interval="monthly" class="${state.interval === 'monthly' ? 'active' : ''}">Monthly</button>
        <button data-interval="annual" class="${state.interval === 'annual' ? 'active' : ''}">Yearly${save ? ` · save ${save}%` : ''}</button>
      </div>`
  }

  /** Start a checkout, or open the portal, from any card on any page. */
  async function wire(root) {
    root.querySelectorAll('[data-plan-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.planAction
        const label = btn.textContent
        btn.disabled = true
        btn.textContent = 'Opening...'
        try {
          const res =
            action === 'portal'
              ? await fetch('/api/billing/portal', { method: 'POST' })
              : await fetch('/api/billing/checkout', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ plan: btn.dataset.plan, interval: state.interval }),
                })
          const data = await res.json()
          if (data.url) {
            window.location.href = data.url
            return
          }
          btn.textContent = label
          btn.disabled = false
          const note = root.querySelector('[data-plan-error]')
          if (note) note.textContent = data.error || 'Could not open checkout just now.'
        } catch {
          btn.textContent = label
          btn.disabled = false
        }
      })
    })

    root.querySelectorAll('[data-interval]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.interval = btn.dataset.interval
        root.dispatchEvent(new CustomEvent('plans:interval', { bubbles: true }))
      })
    })
  }

  window.Plans = {
    load,
    whoami,
    card,
    cta,
    ctaHtml,
    toggleHtml,
    wire,
    esc,
    annualOffered,
    get interval() {
      return state.interval
    },
    set interval(v) {
      state.interval = v
    },
  }
})()
