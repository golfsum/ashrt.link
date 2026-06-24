const $ = (id) => document.getElementById(id)

const PLANS = {
  pro: { label: 'Pro', price: '$9/mo', blurb: 'Unlimited links, advanced analytics, campaigns.' },
  business: { label: 'Business', price: '$29/mo', blurb: 'Custom domains, team accounts, white label.' },
}

let plan = 'free'

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)

async function load() {
  const [acc, billing] = await Promise.all([
    fetch('/api/account').then((r) => (r.ok ? r.json() : null)),
    fetch('/api/billing/status').then((r) => (r.ok ? r.json() : null)),
  ])
  if (!acc) return (window.location.href = '/login')
  const u = acc.user
  plan = u.plan || 'free'
  $('email').textContent = u.email
  $('provider').textContent = u.provider === 'password' ? 'Email & password' : cap(u.provider)
  $('plan').textContent = cap(plan)
  if (plan !== 'free') $('plan').classList.add('pro')

  renderPlans(billing)
}

function renderPlans(billing) {
  const note = $('billing-note')
  const wrap = $('plan-options')

  if (!billing || !billing.enabled) {
    note.textContent = "You're on the Free plan. Paid plans aren't available yet."
    wrap.innerHTML = ''
    return
  }
  if (plan !== 'free') {
    note.textContent = `You're on the ${cap(plan)} plan. Thanks for your support!`
    wrap.innerHTML = ''
    return
  }

  note.textContent = 'Upgrade for unlimited links and more.'
  wrap.innerHTML = ['pro', 'business']
    .filter((p) => billing.available[p])
    .map((p) => {
      const info = PLANS[p]
      return `<div class="po-row">
        <div><div class="po-name">${info.label} <span class="po-price">${info.price}</span></div>
          <div class="po-blurb">${info.blurb}</div></div>
        <button class="btn" data-plan="${p}">Upgrade</button>
      </div>`
    })
    .join('')

  wrap.querySelectorAll('[data-plan]').forEach((b) => (b.onclick = () => checkout(b.dataset.plan, b)))
}

async function checkout(p, btn) {
  btn.disabled = true
  btn.textContent = 'Loading...'
  try {
    const res = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: p }),
    })
    const data = await res.json()
    if (data.url) return (window.location.href = data.url)
    window.toast(data.error || 'Could not start checkout')
  } catch {
    window.toast('Could not start checkout')
  } finally {
    btn.disabled = false
    btn.textContent = 'Upgrade'
  }
}

;(async () => {
  const user = await window.shellReady
  if (!user) return
  await load()
})()
