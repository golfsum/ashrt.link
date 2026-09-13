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

## Phase 6: a number that disagreed with a list

The report was one sentence: *"19 free links used but can't see what they are or
any info on them."* That is not a display bug. It means two parts of the system
were counting different things and neither could show its work.

### What was actually wrong

Links live in one Redis hash. Several indexes point at them: an owner set per
account, a recency sorted set for admin paging. The record is the truth — a link
exists because its record exists — and the indexes are only how a dashboard
finds it quickly.

Three faults let those drift apart and stay that way:

1. **The quota counted the index, the list read the records.** `countByOwner`
   was `SCARD` on the owner set; `byOwner` fetched the records behind those
   slugs and kept the ones that were really there. A slug stranded in the set
   with no record counted against the plan limit while appearing nowhere.
2. **Index writes were fire-and-forget.** Both `add` and `remove` ended with
   `pipeline(cmds).catch(() => {})`. A lost `SREM` on delete strands a slug
   forever; a lost `SADD` on create makes a live link invisible to its owner.
   Either way, nothing was logged, so nothing could be investigated later.
3. **A pipeline can fail without throwing.** Upstash returns per-command errors
   inside a successful HTTP response, which the client mapped to `null`. The
   "safe" version of the retry would still have missed exactly this case.

### The fix

**The quota now counts what you can see.** `countByOwner` delegates to
`byOwner`. They cannot disagree because they are the same read.

**Index writes are checked.** `writeIndexes` retries a failed pipeline command
by command, distinguishes the two failure modes above, and if anything is still
lost it says so loudly and names the tool that repairs it. Every index command
used here answers with a count, so a `null` result is always an error and never
data.

**Reading a dashboard heals the index it read.** Stale entries are dropped as
they are found. But only the provably dead ones: a slug whose record is gone, or
whose record now belongs to someone else. A record that exists and cannot be
parsed keeps its index entry and gets logged, because unindexing a link that
still redirects is the failure this whole area exists to prevent.

**The admin user list counts records too.** It was `SCARD` as well, which meant
an admin could see "19 links" for an account whose own detail page listed six —
the same disagreement, one level up. It is now two round-trips regardless of
page size: one `HKEYS` for which links exist, one pipelined `SMEMBERS` per
account on the page.

### Being able to answer the question

The user's question — *what are those links?* — needed a direct answer, so
`lib/integrity.js` compares records against every index and both the command
line and the browser run that same code:

- `npm run doctor` prints every account's real links with short code, clicks,
  created date and destination, flags any that are `(hidden: not indexed)`, and
  says what it would fix. `--user you@example.com` narrows it; `--repair`
  applies.
- `/admin/health` does the same in the browser, so fixing production does not
  require copying database credentials onto a laptop. The rebuild asks you to
  type `repair`, and lands in the audit log as `system.reindex` with what it
  changed.

Repair writes index entries and nothing else. No link, destination, click count
or account is modified, and nothing is deleted — which is what makes it safe to
expose as a button.

### Tests

Nine regressions, run against the KV path rather than the file backend, because
the file backend keeps no index and so cannot reproduce any of this:

- the quota equals the visible list when the index is inflated
- a dashboard read heals stale entries and keeps live ones
- deletion leaves nothing behind in any index
- an index write that fails once is retried and lands
- an index write that keeps failing is reported, the link record survives, and
  the quota still matches the list mid-breakage
- an unreadable record keeps its index entry
- a link that changed hands leaves the old owner's index
- the admin list and the account detail page report the same number
- `ZRANGE key 0 -1` returns everything, which is what the repair path reads

The fake KV in `test/helpers/fake-kv.js` grew `ZRANGE`, `HKEYS`, `HEXISTS`, real
Redis negative-index semantics, and failure injection, so a command that works
in production is not silently unsupported in tests — and so a test can make a
write fail on purpose.

## Phase 7: toward a real alternative

The plan this works from is in `ROADMAP.md`: what already exists, what is half
built, what is missing, and the order.

### Custom domains, switched on

The routing has been real since phase 5. What was missing was everything around
it, so the feature stayed behind a flag. Three separate questions get confused
constantly, so `lib/domains.js` keeps them apart and answers each one:

1. **Does this account control the domain?** A TXT record we ask for.
2. **Does it point here?** A CNAME, or an A record for an apex domain, which
   cannot be a CNAME. Getting that wrong is the most common reason a custom
   domain never comes up, so the instructions differ by domain shape.
3. **Will HTTPS work?** The platform issues the certificate.

A check now reports which of the three is outstanding, tells the difference
between "no record" and "points somewhere else", and says what to do next.
"Pending" with no detail is how a five-minute DNS task becomes a support
ticket.

With `VERCEL_TOKEN` and `VERCEL_PROJECT_ID` set, a verified domain is attached
to the project automatically and its certificate state is read back, so a
customer's domain goes live without anyone touching a dashboard. Without them
everything else still works and the domain waits in a state that names the
manual step, which now also appears in the admin overview so nobody waits on us
silently.

Two things a branded host needed and did not have:

- **A root redirect.** Someone typing the bare domain used to land on our
  marketing site, on their company's domain. The account chooses where it goes.
- **A 404 fallback.** An unknown short code showed our error page on their
  domain. It can now go to their own site instead. Scoping still applies first:
  another account's code is scoped out and then sent to the fallback, never
  resolved.

Both are validated exactly like a link destination, so a branded host cannot
reach anything a short link could not.

The feature ships on. `CUSTOM_DOMAINS=0` turns it off for a deployment that
cannot serve branded hosts, and says so rather than silently accepting domains.

### Pricing that answers the actual complaint

Custom domains moved from Business to **Pro**. A branded domain is the first
thing someone paying for a link tool wants, and putting it two tiers up is the
complaint we are answering.

The bigger change: **the allowance is on creation, not on links you already
published**. No plan caps stored links any more. Free gets 50 new links every 30
days, Pro 5,000, Business 25,000. A link already out in the world keeps working
and stops counting once its window passes, so nobody has to delete last
quarter's links to publish this week's, and nothing breaks on a downgrade.

Running out of allowance is a 402 that says which limit was reached and when it
resets, not a 429 telling someone to try again shortly. A rejected URL costs
nothing, so a typo never spends allowance.

### Destinations you can change with your eyes open

A short link is often printed, scheduled, or handed to someone else, so changing
where it points changes something already out in the world.

- The last ten destinations are kept, with when and who.
- The edit dialog says how many clicks the link has had in the last 30 days
  before the change, because that is the number that makes it a decision.
- Any previous destination can be restored, and restoring re-validates it: a
  domain that was fine six weeks ago may be on the blocklist now, and "it was
  allowed before" is not a reason to serve it today.

### Analytics: when, and out

**Time of day and day of week**, in UTC, as two small fixed-size maps on the
record. They cost nothing to keep, need no per-click rows, and answer "when
should I post". Every hour is drawn, including the empty ones, because a quiet
morning is the finding. Clicks recorded before this existed have no breakdown,
and the panel says so rather than showing a confident empty chart.

**CSV export** in three shapes: links with totals, clicks per link per day, and
campaign totals. There is no per-click export because there are no per-click
rows, which is what keeps this cheap to run and keeps us from holding a log of
who went where. Values that would execute as spreadsheet formulas are
neutralised, and an export contains only the requesting account's own data.

### Tests

Thirty-two more, covering: apex versus subdomain instructions, a check that
changes nothing when it fails, the root redirect and 404 fallback (including
that the fallback cannot become a way to reach another account's link), brand
redirect validation, default-domain selection, the kill switch, the creation
allowance and that a bad URL does not spend it, destination history and its cap,
restore re-validation, and CSV escaping and scoping.

### QR codes that can go on a poster

The old implementation could draw a square code in one colour. What shipped now:

**A renderer of our own** (`lib/qr.js`). The `qrcode` package still produces the
module matrix; everything visual is drawn here, with three rules that do not
bend whatever the styling: the finder patterns keep their proportions (rounding
their corners is fine, changing the 1:1:3:1:1 ratio is what makes a "designed"
QR code fail), the four-module quiet zone stays, and a logo is only ever centred,
capped in size, and forces error-correction level H, which can lose 30% of the
code and still read.

Module styles (square, rounded, dots), corner styles (square, rounded, circle),
foreground and background colour, transparency, a caption, a frame, and a centre
logo. One saved style per account rather than one per code, because people want
their codes to look like each other, and because it keeps a base64 image out of
every link record.

**Verified by decoding, not by looking.** `scripts/qr-scan-check.mjs` renders
every combination, rasterises it in a real browser, and decodes the pixels with
a QR decoder. It immediately caught a real bug: dots drawn at 84% of a module
looked correct and did not decode. No unit test would have found that — the SVG
is perfectly valid either way. The dots are now 96%, and all twelve combinations
decode to the right URL, logo and caption included.

**PNG is rendered in the browser** from that SVG, so any resolution is available
(the download is 1024px) without putting a rasteriser in a serverless function.
The plain `format=png` endpoint stays for API callers.

**Scans are counted as scans.** Codes we generate carry an `s=qr` marker, read
at the redirect and never forwarded to the destination. A scan is still a click;
it is also now its own number, on the QR page per code and in analytics as a
share of all clicks. Codes printed before the marker existed count as ordinary
clicks, so the figure understates rather than inflates, which is the right
direction for it to be wrong in.

The logo upload accepts PNG, JPEG and WebP under 48KB and refuses SVG outright:
an SVG can carry script, and it would be served back inside our own SVG on our
own origin. That one route gets its own larger body parser rather than raising
the 64kb limit for everything.

### Pages that answer one question each

Four new public pages, each with a job no other page does:

- **`/pricing`** renders from `/api/plans`, so every number on it is the number
  the API enforces. A hand-written pricing table drifts from the code within a
  month and then quietly misrepresents what somebody is buying.
- **`/qr-code-generator`** makes a code without an account and shows it
  immediately rather than making you press one more button on a page whose whole
  purpose is the code. The writing is about static versus dynamic codes, the
  three reasons designed codes stop scanning, and print sizes.
- **`/bitly-alternative`** compares the two products with figures taken from
  Bitly's published pricing page, dated in the page itself, and a section saying
  plainly where Bitly is the better choice. A comparison with no date on it
  becomes a false claim on its own without anyone editing it, so a test asserts
  the date is there.
- The homepage pricing block was **wrong** — still advertising "up to 25 links"
  and "branded QR colors" — and now matches the plans.

Two claims were removed rather than written around. `linkPassword` was an
entitlement no code enforced, so the pricing page rendered a feature that did not
exist: the flag is deleted. "Scheduling" was on the homepage and only expiry
exists, so the word is gone. Expiry itself was API-only, which is a thin thing to
sell, so the link editor now has the control, gated by plan on the server.

New tests hold the set to its own standard: every public page needs a canonical,
valid structured data, a title and description unique across the site (duplicate
titles are the signature of thin keyword-swapped pages), at least two internal
links so nothing is an orphan, and a working tool rather than a picture of one.

## Phase 8: one link, several destinations

Smart routing: US visitors to the US store, iPhones to the App Store, everyone
else to the default. `lib/routing.js`.

**It costs nothing at redirect time.** The rules live inside the link record the
redirect has already fetched, so evaluating them is a loop over a short array
rather than another database round-trip. Anything needing a second lookup on the
redirect path would have been the wrong design.

Three properties the implementation is built around:

- **There is always a default.** A rule set that matches nothing still produces
  the destination the link was created with. Configuring a link can never turn
  it into a dead end.
- **First match wins, in the owner's order.** No scoring, no specificity
  ranking. If two rules could both match, the one listed first is the answer,
  which is legible from the list itself — and the editor says so on the page.
- **A rule destination is not a way around URL validation.** Every rule URL goes
  through the same check as the link's own, when it is saved and again when it
  is served. Without that, the rule editor is an open redirect with a form in
  front of it.

A rule whose destination is blocked later does not take the link down with it:
the visitor falls through to the link's own destination, and the click is
credited to the default rather than to the dead rule.

**Each rule is credited with the clicks it served**, so a rule can be judged on
its own traffic instead of a guess. The editor shows the count under each rule
and an "everyone else" line for the default.

A test caught a real bug in the sanitiser: country values were truncated to two
characters, so "UNITED STATES" became "UN" — a valid-looking code that would
have routed real traffic somewhere nobody chose. A wrong value is now rejected
and reported rather than quietly reshaped.

## Phase 9: importing links by the hundred

Bulk creation, up to 250 rows at a time, from a pasted list or a CSV.

The failure this is designed around is the half-done import: 200 rows in, 86
created, one bad row, and now somebody has to work out which 86 exist before
they dare try again. So:

- **The whole batch is judged before anything is written.** "Check the file"
  runs the same validation the real import will, writes nothing, and reports a
  verdict per row: ready, bad URL, short code in use, short code repeated in
  this file, empty. Each one says what is wrong with that row, not just that
  something is.
- **Every row keeps its verdict after the import too**, with the short code it
  got, so the result is a list you can act on rather than a count.
- **Running out of plan allowance stops the batch cleanly.** The allowance is
  spent one link at a time, so the run stops exactly at the limit rather than
  partway through a row, and everything past it comes back marked `over_quota`.
  Re-running after an upgrade cannot double-create what already exists.

A repeated destination is a warning, not a refusal: two campaigns pointing at
one page is normal. A repeated short code is a refusal, because only one of them
could ever work.

Every row goes through exactly the same URL validation as a single link, against
the live blocklist, and a suspicious destination is imported flagged and
audited rather than quietly. The CSV parser handles quoted cells; a plain list
of URLs is read positionally, and a header row containing `url` switches it to
named columns. A template is one click away.

## Phase 10: knowing when a destination breaks

A short link outlives the page it points at. The destination 404s, the domain
lapses, the certificate expires, and the link keeps sending people into the
wall. `lib/health.js` checks destinations on a schedule and says which ones
broke.

Three constraints shaped the design, and each one is load-bearing:

**Never on the redirect path.** A click must not wait for somebody else's
server. Checks run from a scheduled invocation (`vercel.json` calls
`/api/cron/health-check` every six hours); a click only ever reads what the last
check recorded.

**Do not hammer other people's sites.** A HEAD where possible, a six-second
timeout, one check per link per interval, and the interval depends on traffic:
twelve hours for a link clicked this week, a week for one nobody clicks, six
hours for one currently failing so a recovery is noticed quickly. Each run is
bounded and works through the most overdue first. The checker identifies itself
in its user agent, because an automated request that does not is the kind that
gets a whole IP range blocked.

**Fetching a user-supplied URL from our own server is an SSRF primitive.** The
destination passed validation when it was saved, but DNS can be repointed at a
private address afterwards and a redirect can lead anywhere. So redirects are
followed by hand rather than by the fetch client, and **every hop is validated
before it is requested**. A test proves that a destination redirecting to
`169.254.169.254` is refused and that the address is never contacted.

The endpoint itself is not open. Without `CRON_SECRET` set it refuses everyone,
and a wrong token gets a 404 rather than a 401, because an endpoint that makes
outbound requests on demand is a free proxy for whoever finds it. The comparison
is timing-safe.

Judgements the checker makes deliberately:

- **403 and 401 are not broken.** A members-only page refusing an automated
  request is working exactly as intended.
- **405 is not broken either.** Some servers refuse HEAD and serve GET perfectly
  well, so the check is retried once as a GET.
- **One failure is not an alarm.** Sites blip, and a checker that cries wolf
  gets ignored, which is worse than not having one. Two consecutive failures is
  the threshold, and the record keeps when it started failing and when it last
  worked.

The dashboard shows broken links at the top, with what went wrong and how many
clicks that link has had in the last 30 days, because that is what decides
whether it matters. The admin overview lists them service-wide, since an outage
on one popular destination shows up as many links at once.

There is no email alert yet, and the UI does not claim there is.

## Phase 11: API keys worth giving out

One key per account, rotated in place, is fine until the key is in three places
and rotating it breaks two of them — and until a script that only reads stats is
holding a credential that can delete every link.

**Several keys, each named and scoped.** Four scopes, deliberately few, because
a scope nobody understands gets granted "just in case" and then means nothing:
`links:read`, `links:write`, `analytics:read`, `qr:read`. A call outside a key's
scopes answers 403 naming the scope it needed. The check is applied **to the
route** rather than inside handlers, so a new endpoint cannot quietly inherit
full access by forgetting a line. Sessions are never scope-limited: someone
signed into their own dashboard has full access to their own account by
definition, and scoping that would be theatre.

**A key is shown once.** Keys are hashed at rest; the plaintext exists exactly
once, in the response that creates it. The account endpoint no longer returns a
key at all — an endpoint that hands one back on request makes the hashing
pointless. What is kept is a prefix, enough to tell two keys apart in a list and
not enough to use one.

**Accounts that predate this keep working**, and were not migrated: their single
key is *presented* as a key named "Default" with full scopes, so reading never
has to write and an account nobody touches again keeps authenticating forever.
Those accounts do still hold a key in the clear, so the page offers it once more
with the reason why, and replacing it removes it for good.

**Revoking means revoked.** The index entry goes with the key, because a revoked
key that is still indexed still authenticates — which is the entire failure the
button exists to prevent. The admin revoke action now clears *every* key on the
account rather than rotating one: it exists for a compromised account, and
leaving the others working would defeat it. The owner mints a replacement
themselves, because we cannot hand them one.

Last-used is recorded at most once an hour — useful enough to answer "is this
still in use before I revoke it", not useful enough to write the account record
on every call.

**Rate-limit headers on every key-authenticated response**
(`X-RateLimit-Limit`, `-Remaining`, `-Reset`). The quota was already enforced;
it was just invisible until you hit it, and a client that can see its remaining
budget can slow down.

The API page is now a reference: authentication, the scope table, every
endpoint, and what each status code means.
