# ashrt.link product pass

Three phases: the safety work that had to exist before the free tracker is
pushed at search traffic, the admin tools needed to operate it, and the
repositioning itself.

- **Phase 1**: validation, rate limits, link status, reports, bot filtering, the
  owner index.
- **Phase 2**: `/admin` with users, links, an abuse queue and an audit log.
- **Phase 3**: the homepage as a link tracker, the dashboard redesign, SEO
  infrastructure, and two honesty fixes.
- **Phase 4**: funnel instrumentation and the `/admin/funnel` report.
- **Phase 5**: Links, Analytics and Campaigns rebuilt, admin billing, custom
  domain routing.

Pricing is unchanged.

## Why this went first

Guest link creation was already live in production. `POST /api/links` had no auth
check and no rate limit, so anyone could script unlimited link creation against
the real service today. The plan treated anonymous links as a thing to build;
they were already shipped, in the unsafe form.

Alongside that, three things would have broken under the traffic the SEO plan is
designed to attract:

- `store.byOwner()` called `HGETALL` on **every link in the system** on every
  dashboard load, every `/api/links` call, and every free-plan cap check.
- `/api/links` then issued one `PFCOUNT` per link on top of that.
- Nothing distinguished a person from a Slack link-preview fetch, so the click
  counts the whole product promises were inflated by every share.

## Deploying

Order matters, but there is no flag day: the app keeps using the old read path
until the migration sets a flag at the very end.

1. **Set `ADMIN_EMAILS`** in Vercel to your email. This grants the admin role on
   your next sign-in, writes it to your user record, and can then be removed.
2. **Deploy.** Everything is backward compatible: old link records are hydrated
   with defaults on read, and existing API keys keep working.
3. **Dry-run the migration** against production and read the output:
   ```
   npm run migrate:dry
   ```
4. **Apply it:**
   ```
   npm run migrate
   ```
   It is additive and idempotent. It creates index keys, backfills field
   defaults, and indexes API keys by hash. It deletes nothing and rewrites no
   click data. Running it twice is harmless.

The last thing it does is set `ownerIndexBuilt=1`, which is what switches reads
from the full scan to the index. Until then, everything works the old way.

## What is now enforced

**Destination validation** (`lib/urls.js`) runs on every create and again on
every redirect. Refused: non-http(s) schemes, private and loopback IPs in every
encoding the URL parser canonicalizes (`http://2130706433/`, `http://0x7f000001/`,
`http://127.1/` all resolve to 127.0.0.1 before we look), cloud metadata
endpoints, IPv6 unique-local and link-local and IPv4-mapped forms, internal
hostnames, embedded credentials, infrastructure ports, control characters, and
links back to ourselves.

**Rate limits** (`lib/ratelimit.js`) are declared in one table; routes name a
limit and never inline a number. Guests are limited on two axes: 5/hour per
browser (a signed guest cookie) and 20/hour per IP as a ceiling. The per-IP
number is deliberately loose, because offices and mobile carriers put many real
people behind one address and locking them out of the first useful action is
worse than the abuse it would stop.

Quota is spent only when a link is actually created. A mistyped URL does not cost
a guest one of their five. A separate attempt limit keeps probing the validator
from being free.

**Link status** is now a real field: `active`, `flagged`, `disabled`, `expired`.
Disabled and expired return 410. Flagged serves a warning interstitial showing
the destination rather than forwarding silently.

**Reports** (`/report`, no account needed) flag a link for review once three
*distinct* reporters complain. Reports never disable a link on their own — that
would hand anyone a takedown button for a competitor's link.

**Blocked domains** are re-checked at redirect time, so blocking a domain kills
every link already pointing at it, not just new ones.

**Bot traffic** is classified and counted separately. Slack, Twitter/X, Discord,
Telegram, WhatsApp, LinkedIn, iMessage, search crawlers, AI crawlers, uptime
monitors, scanners, headless browsers and HTTP clients no longer appear as
visitors.

**Admin** authorization is server-side only, via a role on the user record.
Admin routes answer 404 rather than 403, so probing does not confirm the surface
exists. Every admin mutation is written to an audit log.

## Two real bugs found while testing

- **A revoked API key silently degraded to anonymous.** If your key was rotated
  or mistyped, `POST /api/links` fell through to the guest path and returned 200.
  Your integration would look healthy while its links landed in no account. It
  now returns 401.
- **Telegram was being counted as Twitter.** Telegram's user-agent is literally
  `TelegramBot (like TwitterBot)`, and the looser pattern matched first.

## Performance, measured

Against a KV backend with an account of 40 links, counting Redis round-trips:

| Request | Before | After |
|---|---|---|
| `GET /api/links` | 41 | 4 |
| `GET /api/stats` | 8, plus a full-system scan | 8 |
| `POST /api/links` | full-system scan for the cap check | 2 |
| Redirect (human) | 4–6 | 4 |
| Redirect (bot) | 4–6 | 3 |

The structural change matters more than the numbers: these no longer scale with
the total number of links in the system, only with the user's own.

## Privacy

Raw IP addresses are not stored anywhere. Visitor identity is an HMAC of IP plus
user-agent, salted with `SESSION_SECRET` and truncated: enough to count a repeat
visitor, not enough to identify one. Per-day history on a link record is capped
at 400 days so it cannot grow without bound.

The privacy policy was updated in phase 3 to describe this accurately.

## Tests

```
npm test        # 134 tests
```

Covers URL validation against the full attack battery, plan entitlements, bot
classification, and integration tests for ownership, admin authorization, guest
tokens, API keys, reports, CSRF and noindex. The admin suite additionally
asserts that no admin response can leak a key or a password hash, and that a
normal user cannot reach any admin read *or write*.

The admin UI was also driven end to end in a real browser: disabling a link
through the reason prompt and confirming it then returns 410 to a visitor, the
type-the-slug delete guard, search filtering, suspending an account, and the
audit log showing the right email, actor and reason.

`test/helpers/fake-kv.js` is a small in-memory Upstash stand-in, so the KV code
path — the one that actually runs in production — is tested rather than only the
local file backend.

## Phase 2: the admin dashboard

Reachable at `/admin` once your account has the role. Five pages.

**Overview** — accounts (total, today, this week, by plan, suspended, admins),
links by status, clicks across the service with a date range, and a "needs
attention" list that links straight into the abuse queue.

**Users** — searchable by email, name or account id; filterable by plan,
suspended or admin. Each row carries that account's link and click totals. The
detail page shows their links, campaigns, API usage and internal notes, and
offers: suspend, restore, disable API, revoke key, add note, promote, demote.

**Links** — every link on the service, searchable by short code or destination,
filterable by status and by guest vs account. Suspicious destinations are tinted
and carry their signal chips (`impersonates:paypal`, `throwaway-host`,
`credential-language`), so a phishing link stands out in a list of hundreds.

**Abuse** — reports grouped by the link they concern, sorted by number of
distinct reporters. Three people reporting one URL is one decision, not three,
and grouping also stops a coordinated pile-on from looking like independent
complaints. Plus flagged links and the blocked-domain list.

**Audit log** — every privileged action in plain language, with who did it, the
reason they gave, and the account resolved to an email rather than an id.

### Admin safety decisions

- Authorization is server-side on every request, from a role on the user record.
  `ADMIN_EMAILS` only bootstraps the first admin, is read server-side only, and
  can be removed once the role is written.
- The admin routes answer **404, not 403**, and the admin *pages* are gated
  before the static file server sees them. Probing does not confirm `/admin`
  exists.
- **There is no delete-account button.** Suspension is reversible, takes effect
  on the next request, and leaves the evidence in place.
- Deleting a link requires typing the short code back. Disabling is offered
  first everywhere, because it is reversible.
- An admin cannot suspend or demote their own account.
- Admin responses never contain an API key, a key hash, or a password hash, and
  there is a test that fails if one ever appears.
- Notes are stripped of tag characters before storage and escaped on render.
- Reports still never disable anything on their own.

## Known gaps, deliberately left

- **Custom domains are built but switched off.** The routing, verification and
  scoping all work and are tested. `CUSTOM_DOMAINS=1` turns them on, once a
  domain is also pointed at the deployment at the hosting level.
- **No Safe Browsing / reputation provider.** The suspicion scorer is heuristic
  (brand impersonation, throwaway hosts, shortener chaining, punycode,
  credential language). It is triage, not a verdict.
- **Admin overview scans accounts, not links.** Plan distribution and link
  status counts walk their collections (capped at 5000 links). Fine while
  accounts are far fewer than links; if account count ever approaches link
  count, it needs the same index treatment links got.

## Phase 3: repositioning, dashboard, SEO

### The homepage is now the tool

`<h1>Free Link Tracker</h1>`, and the input is the next thing on the page.
Nothing sits between the headline and the box. Paste a URL, get a short link
with Copy, View analytics and QR beside it, and a line saying it is kept for 30
days unless you save it.

Below that: how tracking works, what the product does, and five FAQs written to
answer what people actually ask before using one of these (what can you see
about a click, will link previews inflate my count, how is this different from a
shortener).

### Dashboard

The quick-create field is directly under **Good morning, ND**, as you asked. No
modal, no click before you can do anything. "More options" expands custom link,
name, campaign and UTM fields in place.

A new account no longer gets a screen of empty panels. Until there is a link,
the whole lower half is replaced by a three-step onboarding card; the moment
there is data, the normal dashboard takes its place.

The **Campaigns KPI was hardcoded to `'0'`** and never loaded anything. It was
one of the four headline numbers on the page and it was fake. It reads the real
count now.

### Percentage changes, where they are honest

Clicks and links get a period-over-period percentage, but only when the previous
period had at least 10 events. Below that the card says "62 in the last 7 days"
instead, because 1 to 3 clicks is "+200%" and that is noise wearing a signal's
clothing.

Unique visitors and campaigns get no percentage at all, and this is not
laziness: unique visitors are counted in a HyperLogLog, which has no time
dimension to slice, and campaigns have no per-day history. There is no honest
number to show, so there is no number.

### SEO

- `sitemap.xml` generated from a list of public pages, and it **omits any page
  whose file does not exist**, so it can never advertise a 404. A test walks
  every URL in it and fails if one does not return 200.
- Canonical, Open Graph and Twitter tags on every public page. Titles and
  descriptions written for the target intent.
- Structured data: `WebApplication` on the homepage, `BreadcrumbList` and
  `FAQPage` on the landing pages. No invented reviews or ratings. A test parses
  every JSON-LD block and fails on malformed JSON.
- Two landing pages, `/utm-link-tracker` and `/qr-code-tracking`, each covering a
  genuinely different job rather than swapping a keyword. Both embed the real
  working tool near the top, not a screenshot of one.
- No `/free-link-tracker` page. The homepage already targets that term; a second
  page would compete with it.

Adding a page to `public/` now automatically reserves its alias, because
`RESERVED` is derived from the directory. That closes the collision hazard where
a user could claim `utm-link-tracker` and later have a new static file silently
shadow their working link.

### Two honesty fixes

**Custom domains are switched off.** The form collected a domain and printed DNS
instructions telling people to point a CNAME at Vercel. Nothing resolved a link
by `Host`, nothing registered the domain, nothing verified ownership: following
those instructions achieved nothing. The endpoint now returns 503 with a plain
explanation, the settings page says it is not available, and domains people
already added are kept and surfaced. Set `CUSTOM_DOMAINS=1` when the routing
exists and the plan gate takes over.

**The privacy policy now matches the code.** It previously described a URL
shortener that counted clicks. It now documents what is actually collected and
stored: the country, device, browser, OS and referrer per click; the salted
one-way HMAC used to tell a repeat visitor from a new one; that raw IP addresses
are stored nowhere; the guest cookie and what it does and does not contain; the
retention windows (30 days for guest links, 400 days of per-day history); and a
section on what the product cannot tell you about a visitor, because link
tracking is routinely assumed to do more than it does.

## Phase 4: does search traffic become users

The repositioning in phase 3 is a bet. This is the measurement. It answers one
question at `/admin/funnel`, as a single number at the top of the page:

> **7.0%** of search visitors created an account (11 from 157 arrivals in 30 days)

Below it: the five-stage funnel from arrival to subscription, visitors and
signups over time, and three breakdowns showing where visitors, signups and
subscribers each came from. Search sources are tinted differently from direct
and referral, so the thing being tested is readable at a glance.

### How it is counted

**Server-side wherever the event is server-observable.** A signup, a link
creation, a checkout and a subscription are all things the server watches
happen, so they are counted there. No beacon to be blocked by an extension,
dropped on a fast bounce, or forged. Only three events go through the browser
endpoint: starting to type in the tracker, clicking upgrade, and beginning a
signup form. Those are interactions the server genuinely cannot see.

The client endpoint accepts an allowlist of exactly those three. A test posts
`signup_completed` and `subscription_started` to it and asserts the counters do
not move, because an endpoint that took any event name would let anyone inflate
the numbers the business is steered by.

**Bots never count.** The same classifier the redirect uses runs on page views
and on the client endpoint. In the seeded run above, 60 crawler hits produced
zero movement at the top of the funnel. Without this, crawler traffic would
inflate arrivals and make conversion look far worse than it is, which is the
specific way this kind of dashboard usually lies.

**Rates are withheld below 20 events in the stage above.** Two visitors and one
signup is not a 50% conversion rate. The row says so in words instead.

### What it deliberately does not do

There is no per-person event log. Every event is a daily tally plus a coarse
source bucket (`google`, `bing`, `social`, `direct`, `referral`, …). Raw
referrers are never stored: a referrer arrives, gets bucketed, and the URL is
dropped. There is nothing to join back to an individual and nothing to leak.

A test writes a visit carrying an internal URL, a query token and an IP, then
reads the stored file back and fails if any of it appears. The cost of this
design is that you cannot replay one person's journey. That is not a question
worth the privacy surface.

Signup attribution is stored once, on the user record, as `signupSource`. That
is what lets a subscription months later still be credited to the search visit
that started it.

## Phase 5: the rest of the app

### Links, Analytics and Campaigns

**Links** is now the working area it should be. Search across short code, name
and destination; filter by status and campaign; click any tag to filter by it.
Each row carries the name, destination, campaign and tags, with clicks, unique
visitors and last click. Create and edit take names, tags, campaign and UTM
parameters in one dialog. Deleting tells you how many recorded clicks go with it
before you confirm.

**Analytics** is a real report. Scope it to all links, one link or a campaign,
over 7, 30, 90 days or all time. Clicks, unique visitors, daily average, top
links, top destination domains, referrers, countries, devices, browsers and
operating systems. Bot and link-preview traffic gets its own panel, named by
service, so you can see what was excluded rather than just being told it was.
Narrowing the scope re-aggregates from cached per-link stats, so it is instant
and costs no extra round-trip.

**Campaigns** compare rather than just list. Each card shows links, clicks,
visitors and clicks-per-link, because a campaign with eight links and 4,000
clicks is not the same as one link that got lucky. Clicking a campaign ranks its
links against each other on one bar scale. Rename, archive and delete all work,
and deleting says plainly that the links survive and only lose the grouping.

### Admin billing

`/admin/billing` reports plan mix, subscription status, and the accounts that
need a person: payments failing, and paid plans with no Stripe customer behind
them, which means our records and Stripe's have drifted apart. Each row links
straight to that customer in Stripe.

MRR is plan price times active subscribers. It is labelled an estimate in the UI
*and in the API payload*, and the note says what it ignores: discounts,
proration, coupons, annual billing and tax. Stripe stays the source of truth;
this does not try to be a second ledger.

### Custom domains, actually built

The routing exists now and is tested:

- **Verification is a DNS TXT record**, checked server-side against real DNS.
  The token is an HMAC of account id and domain, so one account cannot use a
  record published for another. Nothing routes until it verifies.
- **A branded host serves only its owner's links.** Without that scoping, every
  customer's domain would serve every link on the service, and one person's
  domain could be used to launder someone else's destination.
- **A branded host serves nothing else.** The homepage, pricing, signup and
  dashboard all redirect to the canonical site, and the host asks not to be
  indexed. A test caught the bug here: `/signup` matches the short-code pattern,
  so a naive shape check handed a customer's domain our signup form. Reserved
  names are now excluded.
- **The canonical host keeps serving every link**, so turning a domain on or off
  never breaks links already shared.
- A suspended account stops serving its domain.

Still off by default: `CUSTOM_DOMAINS=1` enables it, because the domain also has
to be pointed at the deployment at the hosting level, which is outside the app.

### Two smaller fixes

**Example links no longer read as localhost.** `BASE_URL` used to fall through
to `VERCEL_URL` in production, which hands people links on a per-deploy
`*.vercel.app` host that changes every deploy. The canonical domain is now the
production default, and sample links in the copy render from server config
rather than whatever host happens to be serving.

**Action icons are inline SVG.** They were Unicode glyphs, which fall back to
empty boxes on any system without them.
