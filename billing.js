import Stripe from 'stripe'

/**
 * Stripe billing for the paid plans.
 *
 * The plan catalogue — names, prices, which Stripe id belongs to which plan and
 * interval — lives in lib/plans.js. This file knows how to talk to Stripe and
 * nothing about what anything costs, so a price can never be right here and
 * wrong on the pricing page.
 *
 * Everything degrades gracefully: with no secret key or no price ids, billing
 * is "disabled" and the UI says a plan is not available yet rather than sending
 * somebody to a checkout that will fail.
 */

import { PAID_PLANS, PLANS, stripePriceId, priceOf } from './lib/plans.js'

const SECRET = process.env.STRIPE_SECRET_KEY
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET

const stripe = SECRET ? new Stripe(SECRET) : null

export { PAID_PLANS, FREE_LINK_LIMIT } from './lib/plans.js'

/** Every purchasable (plan, interval) pair that is actually configured. */
export function availability() {
  const out = {}
  for (const plan of PAID_PLANS) {
    out[plan] = {
      monthly: Boolean(stripe && stripePriceId(plan, 'monthly')),
      annual: Boolean(stripe && stripePriceId(plan, 'annual')),
    }
  }
  return out
}

export function billingEnabled() {
  return Object.values(availability()).some((a) => a.monthly || a.annual)
}

/** Can this plan be bought at all (on either interval)? */
export function planAvailable(plan, interval) {
  const a = availability()[plan]
  if (!a) return false
  return interval ? Boolean(a[interval]) : a.monthly || a.annual
}

/**
 * Create a Checkout Session for a plan and return its hosted URL.
 *
 * The interval is part of the price id, not a separate field, so asking for
 * annual billing on a plan with no annual price is a refusal here rather than a
 * silent fall back to the monthly price — which would charge somebody a
 * different amount than the button they pressed.
 */
export async function createCheckoutUrl(user, baseUrl, plan = 'pro', interval = 'monthly') {
  if (!PAID_PLANS.includes(plan)) throw new Error(`Unknown plan ${plan}`)
  const price = stripe ? stripePriceId(plan, interval) : ''
  if (!price) throw new Error(`The ${plan} plan is not configured for ${interval} billing`)

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    client_reference_id: user.id,
    ...(user.stripeCustomerId ? { customer: user.stripeCustomerId } : { customer_email: user.email }),
    metadata: { plan, interval },
    subscription_data: { metadata: { plan, interval } },
    success_url: `${baseUrl}/account?upgraded=${plan}`,
    cancel_url: `${baseUrl}/account?checkout=cancelled`,
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

/**
 * Which plan a Stripe price id belongs to.
 *
 * Used by the webhook: the subscription is the source of truth for what
 * somebody is paying for, and reading it from the price rather than from our
 * own metadata means a plan changed inside the Stripe dashboard still lands
 * correctly on the account.
 */
export function planForPrice(priceId) {
  if (!priceId) return null
  for (const plan of PAID_PLANS) {
    for (const interval of ['monthly', 'annual']) {
      if (stripePriceId(plan, interval) === priceId) return { plan, interval }
    }
  }
  return null
}

/** Monthly price of a plan, for the admin revenue estimate. */
export const monthlyPrice = (plan) => priceOf(plan)?.monthly ?? 0

export { PLANS }
