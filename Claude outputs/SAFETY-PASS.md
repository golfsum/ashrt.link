# Safety pass: what changed and how to ship it

This is phase 1 of the ashrt.link product pass: the abuse, validation and scale
work that has to exist before the free tracker is pushed at search traffic.

Nothing here changes pricing, the dashboard layout, or the SEO positioning. Those
are later phases.

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

The privacy policy has **not** been updated to describe this. It should be before
launch — it currently does not match the implementation.

## Tests

```
npm test        # 67 tests
```

Covers URL validation against the full attack battery, plan entitlements, bot
classification, and integration tests for ownership, admin authorization, guest
tokens, API keys, reports, CSRF and noindex.

`test/helpers/fake-kv.js` is a small in-memory Upstash stand-in, so the KV code
path — the one that actually runs in production — is tested rather than only the
local file backend.

## Known gaps, deliberately left

- **Custom domains collect data and do nothing.** `/api/domains` stores a domain
  with `status: pending`, but nothing verifies it and the redirect handler does
  not resolve by `Host`. The plan says not to ship custom domains unless the
  redirect infrastructure supports them. It does not yet. The UI should say so
  or be hidden until it does.
- **No Safe Browsing / reputation provider.** The suspicion scorer is heuristic
  (brand impersonation, throwaway hosts, shortener chaining, punycode,
  credential language). It is triage, not a verdict.
- **`/admin` has an API but no UI yet.** `/api/admin/*` works and is gated; the
  interface is the next phase.
- **No sitemap.xml.** `robots.txt` references one. It belongs with the SEO phase.
