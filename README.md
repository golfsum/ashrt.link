# ashrt.link

A small, fast URL shortener with accounts and click stats. Sign up, paste a long
URL, get a short `ashrt.link/abc123`, and watch the clicks add up. Each user has
their own links, dashboard, and API key. It also powers the short links in
Schedlytics.

## What you get

- **Accounts** — email + password, or sign in with Google / GitHub
- A per-user dashboard to create links and read their stats
- Custom aliases (or an auto-generated short code)
- Click counts, last-clicked time, and a 7-day sparkline per link
- A **personal API key** per user so other apps (like Schedlytics) can create
  links on that account

## Run it

```bash
cp .env.example .env     # set SESSION_SECRET (and optionally OAuth creds)
npm install
npm start                # http://localhost:4000
```

Open `http://localhost:4000`, click **Get started**, and create an account.
Locally it stores everything in JSON files (`.links.json`, `.users.json`) — no
database needed.

## Pages

| Path | What |
|------|------|
| `/` | Public landing page + quick shortener (funnels to sign up) |
| `/signup`, `/login` | Create an account / log in (email-password or OAuth) |
| `/dashboard` | Your links and stats (requires login) |
| `/account` | Your profile and personal API key |

## API

The redirect (`GET /:slug`) is public. Everything else needs **either** a
session cookie (dashboard) **or** an `x-api-key` header with your personal API
key (from `/account`).

| Method | Route | Body | Notes |
|--------|-------|------|-------|
| POST | `/api/links` | `{ "url": "...", "alias": "optional", "source": "optional" }` | Creates a link owned by you |
| GET | `/api/links` | | Your links: `{ totalLinks, totalClicks, links: [...] }` |
| DELETE | `/api/links/:slug` | | Removes one of your links |
| GET | `/api/account` | | Your profile + API key |
| POST | `/api/account/rotate-key` | | Issues a new API key |
| GET | `/:slug` | | 302 redirect, counts the click (public) |

```bash
curl -X POST https://www.ashrt.link/api/links \
  -H "x-api-key: ak_YOUR_PERSONAL_KEY" -H "Content-Type: application/json" \
  -d '{"url":"example.com/a/very/long/path"}'
```

## Use it from Schedlytics

Each Schedlytics user gets their own ashrt.link account, opens `/account`, and
copies their personal API key into the Schedlytics backend `.env`:

```
ASHRT_API_URL=https://www.ashrt.link
ASHRT_API_KEY=ak_that-users-personal-key
```

Every short link Schedlytics mints then belongs to that user and shows up in
their dashboard with its click stats.

## Deploying to Vercel

This repo is Vercel-ready (`vercel.json` + `api/index.js` run the whole app as
one serverless function). Steps:

1. Import the repo. Framework Preset **Other**; `vercel.json` already pins the
   (no-op) build command, output directory, and clean URLs.
2. **Storage** tab → Create → **KV / Upstash**. Vercel injects `KV_REST_API_URL`
   and `KV_REST_API_TOKEN`; `store.js` switches from local files to KV
   automatically (Vercel's filesystem is read-only, so this is required).
3. **Environment Variables** (Production):
   - `SESSION_SECRET` — a long random string (signs login cookies)
   - `BASE_URL` — your canonical domain, e.g. `https://www.ashrt.link`
   - *(optional, for social login)* `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
     and/or `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`
4. **Domains** → add `ashrt.link` and `www.ashrt.link`; pick one as canonical and
   point `BASE_URL` at it.

### OAuth callback URLs

When creating the OAuth apps, set the redirect/callback to match `BASE_URL`:

- Google: `https://www.ashrt.link/auth/google/callback`
- GitHub: `https://www.ashrt.link/auth/github/callback`

Leave a provider's env vars blank and its button simply doesn't show.
