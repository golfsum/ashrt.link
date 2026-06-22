import express from 'express'
import cors from 'cors'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import dotenv from 'dotenv'
import { store } from './store.js'

dotenv.config()

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 4000
// On Vercel, VERCEL_URL is the deployment host; otherwise use BASE_URL or localhost.
const BASE_URL =
  process.env.BASE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`)
const API_KEY = process.env.API_KEY || ''

const app = express()
app.use(express.json())
app.use(cors())

const RESERVED = new Set(['api', 'index.html', 'styles.css', 'app.js', 'favicon.svg', 'health', 'robots.txt'])

const shortUrl = (slug) => `${BASE_URL}/${slug}`
const withUrl = (l) => ({ ...l, shortUrl: shortUrl(l.slug) })
const randomSlug = () => crypto.randomBytes(4).toString('base64url').slice(0, 6)

function normalize(input) {
  const t = String(input || '').trim()
  if (!t) return ''
  return /^https?:\/\//i.test(t) ? t : `https://${t}`
}

function requireKey(req, res, next) {
  if (!API_KEY) return next()
  if (req.get('x-api-key') === API_KEY) return next()
  res.status(401).json({ error: 'Wrong or missing API key' })
}

/* --------------------------------- API ----------------------------------- */

app.get('/api/health', (_req, res) => res.json({ ok: true, store: store.driver, keyRequired: Boolean(API_KEY) }))

app.post('/api/links', requireKey, async (req, res) => {
  const url = normalize(req.body?.url)
  if (!url) return res.status(400).json({ error: 'Give me a URL to shorten' })

  let slug = String(req.body?.alias || '').trim()
  if (slug) {
    if (!/^[a-zA-Z0-9_-]{2,32}$/.test(slug)) {
      return res.status(400).json({ error: 'Aliases use letters, numbers, dashes (2 to 32 chars)' })
    }
    if (RESERVED.has(slug) || (await store.exists(slug))) {
      return res.status(409).json({ error: 'That alias is taken' })
    }
  } else {
    do {
      slug = randomSlug()
    } while (RESERVED.has(slug) || (await store.exists(slug)))
  }

  const link = await store.add({ slug, url, source: req.body?.source || 'dashboard' })
  res.json(withUrl(link))
})

app.get('/api/links', requireKey, async (_req, res) => {
  const links = await store.all()
  const totalClicks = links.reduce((s, l) => s + (l.clicks || 0), 0)
  res.json({ totalLinks: links.length, totalClicks, links: links.map(withUrl) })
})

app.delete('/api/links/:slug', requireKey, async (req, res) => {
  await store.remove(req.params.slug)
  res.json({ ok: true })
})

/* ------------------------------- dashboard ------------------------------- */

app.use(express.static(join(__dirname, 'public')))

/* ------------------------------- redirect -------------------------------- */

app.get('/:slug', async (req, res) => {
  const link = await store.recordClick(req.params.slug)
  if (!link) {
    return res
      .status(404)
      .type('html')
      .send(
        '<body style="font-family:system-ui;background:#0b0b0f;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="margin:0;font-size:48px">404</h1><p style="color:#9aa">That short link does not exist.</p><a href="/" style="color:#8b8bff">Make one</a></div></body>',
      )
  }
  res.redirect(302, link.url)
})

// Run a normal server locally; on Vercel the app is imported by api/index.js.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  app.listen(PORT, () => {
    console.log(`\n  ashrt.link running at ${BASE_URL}`)
    console.log(`  store: ${store.driver}   API key required: ${API_KEY ? 'yes' : 'no'}\n`)
  })
}

export default app
