# ashrt.link

A small, fast URL shortener with click stats. Paste a long URL, get a short
`ashrt.link/abc123`, and watch the clicks add up. It powers the short links in
Schedlytics, but it works fine on its own.

## What you get

- A one-page dashboard to create links and read their stats
- Custom aliases (or an auto-generated short code)
- Click counts, last-clicked time, and a 7-day sparkline per link
- A clean API so other apps (like Schedlytics) can create links for you

## Run it

```bash
cp .env.example .env     # set a long random API_KEY
npm install
npm start                # http://localhost:4000
```

Open the dashboard, paste your `API_KEY` in the box at the top right, and start
shortening. The key is stored in your browser only.

## API

The redirect (`GET /:slug`) is public. Everything else needs the
`x-api-key` header.

| Method | Route | Body | Notes |
|--------|-------|------|-------|
| POST | `/api/links` | `{ "url": "...", "alias": "optional", "source": "optional" }` | Returns `{ slug, url, shortUrl, clicks, ... }` |
| GET | `/api/links` | | `{ totalLinks, totalClicks, links: [...] }` |
| DELETE | `/api/links/:slug` | | Removes a link |
| GET | `/:slug` | | 302 redirect, counts the click |

```bash
curl -X POST http://localhost:4000/api/links \
  -H "x-api-key: YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"url":"example.com/a/very/long/path"}'
```

## Use it from Schedlytics

In the Schedlytics backend `.env`, point it at this service:

```
ASHRT_API_URL=https://ashrt.link
ASHRT_API_KEY=the-same-key-you-set-here
```

Restart the Schedlytics backend. Now every short link it creates lives on
`ashrt.link` and shows up in this dashboard with its click stats.

## Deploying to Vercel

This repo is Vercel-ready (`vercel.json` + `api/index.js` run the whole app as
one function). Steps:

1. Import the repo in Vercel. Framework Preset: **Other**, no build command.
2. Storage tab > Create > **KV**. Vercel injects `KV_REST_API_URL` and
   `KV_REST_API_TOKEN`, and `store.js` switches from the local file to KV
   automatically (Vercel's filesystem is read-only, so this is required).
3. Environment Variables: `API_KEY=<long random string>` and
   `BASE_URL=https://ashrt.link`.
4. Add the `ashrt.link` domain to the project.

Locally it needs nothing: `npm start` uses a JSON file and `http://localhost:4000`.

To let Schedlytics mint links here, put the same `API_KEY` in the Schedlytics
backend as `ASHRT_API_KEY` (see that repo's DEPLOY.md).
