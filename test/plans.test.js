import test from 'node:test'
import assert from 'node:assert/strict'
import { limitFor, can, planFor, planIdOf, isPaid, requireFeature, publicPlans, PLANS } from '../lib/plans.js'

test('an unknown or missing plan falls back to free, never to a paid one', () => {
  assert.equal(planIdOf(undefined), 'free')
  assert.equal(planIdOf({}), 'free')
  assert.equal(planIdOf({ plan: 'enterprise' }), 'free')
  assert.equal(planIdOf({ plan: 'business' }), 'business')
})

test('guests get the guest entitlements, not the free plan', () => {
  assert.equal(planFor(null).id, 'guest')
  assert.equal(can(null, 'customAlias'), false)
  assert.equal(can({ plan: 'free' }, 'customAlias'), true)
})

test('paid features are off for free accounts', () => {
  assert.equal(can({ plan: 'free' }, 'brandedQr'), false)
  assert.equal(can({ plan: 'free' }, 'customDomains'), false)
  assert.equal(can({ plan: 'pro' }, 'brandedQr'), true)
  // A branded domain is the first thing a paying customer wants, so it sits at
  // the first paid tier rather than two tiers up.
  assert.equal(can({ plan: 'pro' }, 'customDomains'), true)
  assert.equal(can({ plan: 'business' }, 'customDomains'), true)
})

test('every plan allows more domains as it goes up', () => {
  assert.equal(limitFor({ plan: 'free' }, 'domains'), 0)
  assert.ok(limitFor({ plan: 'pro' }, 'domains') >= 1)
  assert.ok(limitFor({ plan: 'business' }, 'domains') > limitFor({ plan: 'pro' }, 'domains'))
})

test('the allowance is on creation, not on links you already published', () => {
  // No plan caps stored links. Someone who stops paying, or who has been on
  // free for two years, keeps every link they ever made working.
  for (const plan of ['free', 'pro', 'business']) {
    assert.equal(limitFor({ plan }, 'links'), Infinity, `${plan} must not cap stored links`)
  }

  const free = limitFor({ plan: 'free' }, 'linksPerMonth')
  assert.ok(Number.isFinite(free) && free >= 50, 'free is generous enough to actually use')
  assert.ok(limitFor({ plan: 'pro' }, 'linksPerMonth') > free)
  assert.ok(limitFor({ plan: 'business' }, 'linksPerMonth') > limitFor({ plan: 'pro' }, 'linksPerMonth'))
})

test('isPaid does not treat free or guest as paid', () => {
  assert.equal(isPaid(null), false)
  assert.equal(isPaid({ plan: 'free' }), false)
  assert.equal(isPaid({ plan: 'pro' }), true)
})

test('requireFeature asks guests to sign up and users to upgrade', () => {
  assert.equal(requireFeature(null, 'customDomains').status, 401)
  assert.equal(requireFeature({ plan: 'free' }, 'customDomains').status, 402)
  assert.equal(requireFeature({ plan: 'business' }, 'customDomains'), null)
})

test('publicPlans exposes no Infinity, which does not survive JSON', () => {
  const json = JSON.parse(JSON.stringify(publicPlans()))
  for (const p of json) {
    for (const v of Object.values(p.limits)) {
      assert.ok(v === null || typeof v === 'number', `${p.id} limit should be a number or null, got ${v}`)
    }
  }
})

test('every plan declares every feature, so none defaults to undefined', () => {
  const keys = Object.keys(PLANS.free.features)
  for (const [id, plan] of Object.entries(PLANS)) {
    for (const k of keys) {
      assert.equal(typeof plan.features[k], 'boolean', `${id} is missing feature ${k}`)
    }
  }
})
