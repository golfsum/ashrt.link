import Stripe from 'stripe'

/**
 * Stripe billing for the Pro plan. Everything degrades gracefully: if
 * STRIPE_SECRET_KEY / STRIPE_PRICE_ID aren't set, billing is "disabled" and the
 * UI shows an upgrade button as coming-soon instead of breaking.
 */

const SECRET = process.env.STRIPE_SECRET_KEY
const PRICE_ID = process.env.STRIPE_PRICE_ID
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET

const stripe = SECRET ? new Stripe(SECRET) : null

export const FREE_LINK_LIMIT = 25

export function billingEnabled() {
  return Boolean(stripe && PRICE_ID)
}

// Create a Checkout Session for a Pro subscription and return its hosted URL.
export async function createCheckoutUrl(user, baseUrl) {
  if (!billingEnabled()) throw new Error('Billing is not configured')
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: PRICE_ID, quantity: 1 }],
    client_reference_id: user.id,
    customer_email: user.email,
    success_url: `${baseUrl}/dashboard?upgraded=1`,
    cancel_url: `${baseUrl}/account`,
    allow_promotion_codes: true,
  })
  return session.url
}

// Verify and parse an incoming webhook. Throws if the signature is invalid.
export function parseWebhook(rawBody, signature) {
  if (!stripe || !WEBHOOK_SECRET) throw new Error('Webhook not configured')
  return stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET)
}
