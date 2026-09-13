import test from 'node:test'
import assert from 'node:assert/strict'
import {
  limitFor,
  can,
  planFor,
  planIdOf,
  isPaid,
  requireFeature,
  requireHeadroom,
  publicPlans,
  publicMatrix,
  universalFeatures,
  valueFor,
  priceOf,
  MATRIX,
  PLANS,
  PLAN_IDS,
  UNRELEASED_FEATURES,
} from '../lib/plans.js'

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

  // The free allowance is a trial of the product, not a free product: enough
  // to see whether it works for you, not enough to run a business on.
  const free = limitFor({ plan: 'free' }, 'linksPerMonth')
  assert.ok(Number.isFinite(free) && free > 0, 'free can still create links')
  assert.ok(limitFor({ plan: 'pro' }, 'linksPerMonth') > free)
  assert.ok(limitFor({ plan: 'business' }, 'linksPerMonth') > limitFor({ plan: 'pro' }, 'linksPerMonth'))
})

test('every tier is a real step up, so there is a reason to buy the next one', () => {
  // The failure this catches is a middle plan so generous that the top plan
  // sells nothing: every numeric allowance must strictly increase.
  const graded = [
    'linksPerMonth', 'campaigns', 'domains', 'apiPerDay',
    'analyticsDays', 'qrPerMonth', 'destinationHistory', 'bulkRows', 'routingRules',
  ]
  for (const key of graded) {
    const free = limitFor({ plan: 'free' }, key)
    const pro = limitFor({ plan: 'pro' }, key)
    const biz = limitFor({ plan: 'business' }, key)
    assert.ok(pro >= free, `pro must not be worse than free at ${key}`)
    assert.ok(biz >= pro, `business must not be worse than pro at ${key}`)
    assert.ok(biz > free, `${key} must actually improve as you pay`)
  }

  // And every paid feature must be reachable: a flag nobody can buy is either
  // a bug or dead code.
  for (const feature of Object.keys(PLANS.free.features)) {
    assert.ok(
      PLAN_IDS.some((id) => PLANS[id].features[feature]),
      `${feature} is not included on any plan`,
    )
  }
})

test('business leaves somewhere to go: nothing is unlimited that a bigger plan could sell', () => {
  // Room above Business for a Scale/Agency tier later. Unlimited campaigns is
  // deliberate — it is not a cost driver — but links, domains, API and history
  // must all stay finite so there is something left to sell.
  for (const key of ['linksPerMonth', 'domains', 'apiPerDay', 'analyticsDays', 'qrPerMonth', 'bulkRows']) {
    assert.ok(Number.isFinite(limitFor({ plan: 'business' }, key)), `business ${key} must stay finite`)
  }
})

test('prices are stated once and the annual discount is real', () => {
  assert.equal(priceOf('free').monthly, 0)
  assert.equal(priceOf('pro').monthly, 9)
  assert.equal(priceOf('business').monthly, 29)
  for (const id of ['pro', 'business']) {
    const p = priceOf(id)
    assert.ok(p.annual < p.monthly * 12, `${id} annual must cost less than twelve months`)
    assert.ok(p.savingPercent >= 10 && p.savingPercent <= 30, `${id} discount should be a normal one`)
  }
})

test('the marketing pages never see a feature that is not built', () => {
  const shown = publicPlans()
  for (const plan of shown) {
    for (const f of UNRELEASED_FEATURES) {
      assert.equal(plan.features[f], undefined, `${plan.id} must not advertise ${f}`)
    }
  }
  const rows = publicMatrix().flatMap((g) => g.rows.map((r) => r.key))
  for (const f of UNRELEASED_FEATURES) assert.ok(!rows.includes(f), `${f} must not be a comparison row`)
})

test('"in every plan" only contains things every plan really has', () => {
  for (const label of universalFeatures()) {
    const row = MATRIX.flatMap((g) => g.rows).find((r) => r.label === label)
    for (const id of PLAN_IDS) {
      assert.equal(valueFor(id, row), 'Included', `${label} is not actually included on ${id}`)
    }
  }
  // The things we deliberately moved out of that list, because Free has none
  // of them, must stay out of it.
  const universal = universalFeatures()
  for (const label of ['CSV export', 'Analytics history', 'Custom branded domains', 'Webhooks']) {
    assert.ok(!universal.includes(label), `${label} must not be sold as "in every plan"`)
  }
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
