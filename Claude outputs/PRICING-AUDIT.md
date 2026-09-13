# Pricing, limits and entitlements — audit and rebuild

_ashrt.link · 13 September 2026 · 292 tests passing_

## What this changed, in one paragraph

There is now exactly one place that knows what a plan is: `lib/plans.js`. Prices, Stripe
price ids, every numeric limit, every feature flag, the button labels, the comparison
table and the "in every plan" list all come from it. The homepage, the pricing page, the
billing page, the admin revenue report and `billing.js` no longer hold pricing of their
own — they read `/api/plans`, which renders the same object the server gates requests
with. The old hand-written tables (a `.plans-3` block in `index.html`, `FEATURE_LABELS` /
`BLURBS` in `pricing.js`, `PLANS` in `account.js`, `PLAN_PRICES` in `server.js`) are gone.

## The plans

| | Free | Pro | Business |
| --- | --- | --- | --- |
| Price | $0 | **$9/mo** | **$29/mo** |
| Annual | — | $86/yr ($7.17/mo, 20% off) | $278/yr ($23.17/mo, 20% off) |
| New links / 30 days | 10 | 250 | 2,500 |
| Links kept | Unlimited, forever | Unlimited, forever | Unlimited, forever |
| Campaigns | 1 | 25 | Unlimited |
| Custom domains | 0 | 1 | 5 |
| API requests / day | 25 | 1,000 | 10,000 |
| Analytics history | 30 days | 400 days | 730 days |
| QR downloads / month | 10 | 250 | 2,500 |
| Destination rollback | 1 (undo) | 10 | 50 |
| Bulk import rows | — | 250 | 1,000 |
| Smart routing rules / link | — | 5 | 20 |

Room above Business is deliberate: links, domains, API quota, history, QR and bulk rows
are all finite there, so a Scale/Agency tier has something to sell. A test asserts this
(`business leaves somewhere to go`), as well as that every allowance strictly increases
as you pay — the check that stops Pro from making Business pointless again.

## Feature matrix

Every row below is generated from `lib/plans.js`. The homepage, pricing page and billing
page columns say "from /api/plans" because that is literally where they get it: none of
those pages contains a number of its own, so they cannot disagree with this table.

| Feature | Free | Pro | Business | Backend enforced | Homepage | Pricing | Billing |
| --- | --- | --- | --- | --- | --- | --- | --- |
| New links per 30 days | 10 | 250 | 2,500 | `POST /api/links` → `hit('create:user:month')` | ✓ | ✓ | ✓ meter |
| Links kept and redirecting | Unlimited | Unlimited | Unlimited | nothing caps stored links (asserted) | ✓ | ✓ | ✓ |
| Custom short codes | ✓ | ✓ | ✓ | `can(user,'customAlias')` on create | ✓ | ✓ | — |
| Change a destination after sharing | ✓ | ✓ | ✓ | `PATCH /api/links/:slug`, all plans | — | ✓ | — |
| Destinations you can roll back to | 1 | 10 | 50 | `historyDepth()` on read; `/revert` refuses deeper | ✓ | ✓ | — |
| Direct redirect, no ads | ✓ | ✓ | ✓ | the redirect is a 302, all plans | — | ✓ | — |
| Link expiry | — | ✓ | ✓ | `requireFeature('expiry')` | ✓ | ✓ | — |
| Scheduled go-live | — | ✓ | ✓ | `requireFeature('scheduling')` | ✓ | ✓ | — |
| Rows per bulk import | — | 250 | 1,000 | `rowCap` in `POST /api/links/bulk` | ✓ | ✓ | — |
| Smart routing rules per link | — | 5 | 20 | `sanitizeRules(..., { max })` | ✓ | ✓ | — |
| Custom branded domains | — | 1 | 5 | `requireFeature` + `requireHeadroom('domains')` | ✓ | ✓ | ✓ meter |
| QR code for every link | ✓ | ✓ | ✓ | `GET /api/qr`, all plans | ✓ | ✓ | — |
| Branded QR (colours, logo, shapes) | — | ✓ | ✓ | `requireFeature('brandedQr')` on `/api/qr` and `/api/qr/style` | ✓ | ✓ | — |
| QR downloads per month | 10 | 250 | 2,500 | `hit('qr:month')` on `?download` | ✓ | ✓ | ✓ meter |
| Clicks, unique visitors, referrers | ✓ | ✓ | ✓ | recorded on every click | — | ✓ | — |
| Country, device, browser, OS | ✓ | ✓ | ✓ | recorded on every click | — | ✓ | — |
| Bot and link-preview filtering | ✓ | ✓ | ✓ | `lib/bots.js` on every click | — | ✓ | — |
| Analytics history | 30 days | 400 days | 730 days | `withinRetention()` on `/api/stats` and link stats | ✓ | ✓ | ✓ |
| Campaigns | 1 | 25 | Unlimited | `requireHeadroom('campaigns')` | ✓ | ✓ | ✓ meter |
| UTM builder | ✓ | ✓ | ✓ | accepted on create, all plans | ✓ | ✓ | — |
| Tags | ✓ | ✓ | ✓ | accepted on create, all plans | ✓ | ✓ | — |
| CSV export | — | ✓ | ✓ | `requireFeature('csvExport')` on `/api/export` | ✓ | ✓ | — |
| API requests per day | 25 | 1,000 | 10,000 | `hit('api:day')`, planKey `apiPerDay` | ✓ | ✓ | ✓ meter |
| Destination health monitoring | — | ✓ | ✓ | `requireFeature`; the cron only checks entitled accounts | ✓ | ✓ | — |
| Webhooks | — | — | ✓ | `requireFeature('webhooks')` | ✓ | ✓ | — |

Every "—" in the Free column is refused by the server with a 402 that names the plan that
includes it, and `test/entitlements.test.js` calls each of those endpoints directly as a
free account to prove it. Frontend hiding is never the control.

## Every pricing CTA, and where it goes

All plan buttons are rendered by one component (`public/plans-ui.js`), so there is a
single place that decides where a button points. What it decides:

| Situation | Button | Goes to |
| --- | --- | --- |
| Signed out, Free card | Start free | `/signup` |
| Signed out, Pro card | Choose Pro | `/signup?plan=pro` → after signup, `/account?upgrade=pro` → Pro checkout opens |
| Signed out, Business card | Choose Business | `/signup?plan=business` → same, for Business |
| Signed in, own plan | Your current plan | inert |
| Signed in, higher plan | Choose Pro / Choose Business | `POST /api/billing/checkout` with that plan **and the selected interval** |
| Signed in, lower plan | Switch to Pro / Switch to Free | `POST /api/billing/portal` (Stripe portal owns downgrades and dates) |
| Plan has no Stripe price | Not available yet | disabled, no request |
| Annual chosen, no annual price | Annual billing coming soon | disabled, no request |

Where those buttons appear: `/` (homepage pricing block), `/pricing`, `/account`. Nowhere
else renders a plan button. Signed-in users are never sent through signup again — that is
what the `whoami()` check in the component is for.

Secondary CTAs (feature gates and limit messages), all pointing at `/account`:

| Page | Text | Trigger |
| --- | --- | --- |
| Dashboard | `N of 10 links used this period` / `2 links left this period · See plans` | usage meter, always visible |
| Dashboard | quick-create error + `See plans` | 402 from create |
| Links | `Routing is on the paid plans · See plans` | smart routing panel |
| Links | edit / import errors + `See plans` | 402 from PATCH or bulk |
| Campaigns | error + `See plans` | 402 from create |
| QR codes | `Upgrade to Pro` | branded-QR banner |
| Settings | `Upgrade to Pro` | custom-domains panel |
| API | `Webhooks are part of the Business plan · See plans` | webhook panel |
| Homepage / footers | `Every limit, in detail`, `Pricing` | → `/pricing` |

## Downgrade policy (paid → Free)

Nothing is deleted, ever, by a plan change. Verified by test:

- Existing short links keep redirecting, including links on a verified custom domain.
- QR codes keep resolving (they encode the short link, not the destination).
- Campaigns, tags, routing rules, destination history and click history are all kept.
- Analytics history is *windowed*, not destroyed: the record keeps 730 days on every
  plan, and each plan shows what it sells. Upgrading reveals history that was already
  there rather than starting the clock again — also tested.
- What stops is adding new paid things, and creating beyond the Free allowance.

The one-line version, which is on the pricing page and the billing page in the user's own
words: *changing plan never removes anything you have already made.*

## Usage UX

`GET /api/usage/summary` is the single source for every meter, and it reads the same
counters the limiter enforces with — reading it never spends any of it. The billing page
shows links, QR downloads, campaigns, domains and API requests against their limits with
reset times; the dashboard shows a one-line allowance under the quick-create box that
turns to a warning at 10% remaining and to "you have created 10 of 10 … links you have
already made keep working" at the limit.

## Things worth your attention

1. **Free dropped from 50 links/30 days to 10.** Existing free accounts that have already
   created more than 10 in the current window will hit the limit immediately. That is the
   intended direction, but it is a live change to people mid-window, so it is worth
   deciding whether you want it on the same deploy as everything else.
2. **Annual billing is built but not switched on.** The code reads
   `STRIPE_PRICE_PRO_ANNUAL` and `STRIPE_PRICE_BUSINESS_ANNUAL`; if they are unset, the
   monthly/annual toggle does not render at all and nothing advertises annual. Creating
   those Stripe prices is an action against your billing account, so I have not done it.
   The intended figures are $86/yr and $278/yr.
3. **"QR codes per month" is metered as QR *downloads*.** A code is drawn on every page
   view, so metering renders would bill somebody for scrolling. Downloads are what the
   plan sells and what the copy says.
4. **Conversion tracking is not built.** The entitlement exists and Business passes it,
   but it is listed in `UNRELEASED_FEATURES`, so it appears nowhere on the pricing page,
   the homepage or `/api/plans`. Delete that one line the day it ships and every surface
   picks it up. I would rather ship a Business tier with one fewer bullet than a pricing
   page that promises something that does not exist.
5. **Scheduled go-live was missing and is now built**, because Pro advertises it: a link
   with a `startsAt` can be printed today and starts forwarding at its time, with a
   "not live yet" page before then rather than a broken link.
6. **Storage retention went from 400 to 730 days** so Business can honestly sell two
   years. Privacy page updated to match.

## Still yours to do

- Create/confirm the Stripe prices and set `STRIPE_PRICE_PRO` and `STRIPE_PRICE_BUSINESS`
  (and the `_ANNUAL` pair if you want annual). Until they are set, the buttons say
  "Not available yet" rather than opening a broken checkout.
- `CRON_SECRET` in Vercel — health checks refuse to run without it.
