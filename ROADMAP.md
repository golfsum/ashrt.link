# ashrt.link: audit and plan

Written against the code as it stands, not against a wish list. Every claim
below was checked in the repository.

---

## 1. What already exists and works

**Links.** Creation with random or custom alias, guest creation with no account
(30-day TTL, claimable), destination editing, per-link name, tags, campaign
assignment, UTM parameters, search, filter and sort. Redirect is a single 302
with no interstitial and no ads. Disabled and expired links answer 410 with an
explanation instead of a dead end.

**Analytics.** Clicks, unique visitors (HyperLogLog, so a repeat visitor counts
once), daily series, referrers, countries, devices, browsers, operating systems,
last-click time. Bot and link-preview traffic is classified by service and kept
in its own dimension, never mixed into human totals. Scoping to a link, a
campaign, or a date window re-aggregates from cached per-link stats, so it costs
no extra database round-trip.

**QR codes.** Generated from the short link, so the destination can change after
printing. PNG and SVG download, print sheet, foreground colour on paid plans.

**Accounts and billing.** Password and OAuth sign-in, HMAC-signed stateless
session cookie, Stripe Checkout, customer portal and webhooks, three plans
(free / pro $9 / business $29) with every limit and feature gate read from one
module and enforced server-side.

**API.** Key authentication, per-plan daily quota, per-day usage record, rate
limiting, and a 401 (never a silent downgrade to anonymous) on a revoked key.

**Admin.** Overview, funnel, users, links, abuse queue, blocked domains, audit
log, billing, and storage health. Every action is authorised server-side,
answers 404 rather than 403 to a non-admin, and lands in the audit log.

**Abuse.** URL validation including obfuscated-IP canonicalisation and private
network blocking, domain blocklist re-checked on every redirect, user reports,
suspicion scoring with auto-flag, account and link suspension, rate limits on
every write path.

**SEO.** Generated sitemap, robots.txt, JSON-LD, two genuine landing pages
(`/utm-link-tracker`, `/qr-code-tracking`), noindex on every private surface.

---

## 2. What is partially implemented

| Area | Built | Missing |
|---|---|---|
| **Custom domains** | DNS TXT verification against real DNS, HMAC token scoped to the account, host routing, branded host serves only its owner's links and nothing else, suspended account stops serving | Off behind `CUSTOM_DOMAINS=1`; no SSL state; no root-domain redirect; no 404 fallback; needs the domain attached at Vercel, which the app cannot do |
| **Expiration** | `expiresAt` on the record, enforced at redirect, `expiry` entitlement flag defined | Nothing sets it but guest TTL; no UI, no start date, no timezone, no pause, no post-expiry destination |
| **QR** | Dynamic by construction, PNG/SVG, colour | Logo, module and eye styles, frames, CTA text, transparent background, high-resolution export; scans are not distinguished from clicks |
| **API** | Auth, quotas, usage | One key per account, no name, no last-used, no scopes; no webhooks; docs are a single page |
| **Destination editing** | Works | No history, no rollback, no warning when the link is heavily used |
| **Export** | — | No CSV anywhere |

---

## 3. What is missing entirely

Smart routing by country or device. Bulk creation. Destination health
monitoring. Conversion tracking. Comparison pages. Free standalone tools. The
content hub. A standalone pricing page (pricing lives in a homepage section).

---

## 4. Dependencies and risks

**No background worker.** The app is one serverless function on Vercel. Health
monitoring cannot poll from inside a request, so it needs Vercel Cron plus a
work queue with backoff, and it must never touch the redirect path.

**Every feature costs round-trips.** The redirect is currently four Redis
operations. Smart routing rules must live inside the link record that the
redirect already fetches, so evaluating them costs zero additional round-trips.
Anything that needs a second lookup on redirect is the wrong design.

**Geo depth is a hosting fact, not a code choice.** Country comes from
`x-vercel-ip-country`. City-level requires the matching Vercel header and raises
a privacy question, since city plus timestamp plus destination is close to
identifying. Country and region are the honest ceiling for now.

**Pricing changes touch live subscribers.** New tiers mean new Stripe prices.
Existing subscriptions must keep their current price and entitlements. Stripe
objects are an externally billed action and will not be created without an
explicit go-ahead.

**New routing is new attack surface.** Every destination in a routing rule, and
every row of a bulk import, has to pass the same validation as a normal link, or
the rule editor becomes an open-redirect bypass.

**Analytics storage grows with dimensions.** Hour-of-day and day-of-week are
cheap (two small maps per link). Per-click rows are not, and are what would make
this expensive to run. Keep aggregating.

---

## 5. Order of work

**P0 — done**

1. ~~Custom domains switched on properly~~: DNS and certificate diagnostics,
   root-domain redirect, 404 fallback, moved down to Pro, auto-attach when a
   platform token is configured.
2. ~~Destination history with rollback~~, and a traffic warning before a change.
3. ~~Entitlement restructure~~: the allowance is on creation, not on stored
   links. Stripe prices still a deliberate decision.
4. ~~QR editor~~: module and eye styles, logo, frame, caption, high-resolution
   export, and scans counted apart from clicks. Verified by decoding, not by
   looking.
5. ~~Analytics~~: hour and weekday, period comparison, CSV export.
6. ~~Product pages~~: /pricing, /qr-code-generator, /bitly-alternative, and the
   homepage pricing block corrected.

Two things were removed rather than shipped: `linkPassword` was an entitlement
no code enforced, and "scheduling" was on the homepage when only expiry exists.
Expiry itself was API-only and now has a control in the link editor.

**P1**

Scheduling and expiry UI. Bulk creation. Smart routing. Destination health
monitoring. Comparison pages. Free tools. API keys with scopes, webhooks, and
real documentation.

**P2**

Conversion tracking. Creator workflows. Teams and workspaces. Deeper
integrations.

---

## 6. Positioning this is built to support

No interstitial between a click and the destination. Analytics that are not
locked behind an enterprise tier. A free plan someone can actually run a project
on. Destinations that stay editable. Links that keep working after a downgrade.
Bot traffic named and separated instead of inflating the numbers.

Nothing in this plan copies a competitor's copy, markup or design. Feature
parity is the target; imitation is not.
