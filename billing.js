import Stripe from 'stripe'

/**
 * Stripe billing for the paid plans (Pro, Business). Everything degrades
 * gracefully: if the secret key / price ids aren't set, billing is "disabled"
 * and the UI shows upgrade buttons as coming-soon instead of breaking.
 */

const SECRET = process.env.STRIPE_SECRET_KEY
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET

// Recurring Stripe Price ids per plan. STRIPE_PRICE_ID is kept as a Pro fallback
// for older setups.
const PRICES = {
  pro: process.env.STRIPE_PRICE_PRO || process.env.STRIPE_PRICE_ID || '',
  business: process.env.STRIPE_PRICE_BUSINESS || '',
}

const stripe = SECRET ? new Stripe(SECRET) : null

export const FREE_LINK_LIMIT = 25
export const PAID_PLANS = ['pro', 'business']

export function billingEnabled() {
  return Boolean(stripe && (PRICES.pro || PRICES.business))
}

export function planAvailable(plan) {
  return Boolean(stripe && PRICES[plan])
}

// Create a Checkout Session for a plan and return its hosted URL.
export async function createCheckoutUrl(user, baseUrl, plan = 'pro') {
  if (!planAvailable(plan)) throw new Error(`The ${plan} plan is not configured`)
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: PRICES[plan], quantity: 1 }],
    client_reference_id: user.id,
    customer_email: user.email,
    metadata: { plan },
    subscription_data: { metadata: { plan } },
    success_url: `${baseUrl}/dashboard?upgraded=${plan}`,
    cancel_url: `${baseUrl}/account`,
    allow_promotion_codes: true,
  })
  return session.url
}

// Open the Stripe customer portal so a subscriber can manage/cancel their plan.
export async function createPortalUrl(customerId, baseUrl) {
  if (!stripe) throw new Error('Billing is not configured')
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${baseUrl}/account`,
  })
  return session.url
}

// Verify and parse an incoming webhook. Throws if the signature is invalid.
export function parseWebhook(rawBody, signature) {
  if (!stripe || !WEBHOOK_SECRET) throw new Error('Webhook not configured')
  return stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET)
}
