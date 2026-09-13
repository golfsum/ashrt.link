import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderSvg, buildMatrix, MODULE_STYLES, EYE_STYLES } from '../lib/qr.js'

/**
 * QR codes.
 *
 * A QR code is printed on things, so the failure mode is expensive: a code that
 * looks fine in a browser and does not scan is a reprint. Two kinds of check
 * here — the structural invariants that keep a code scannable, and the product
 * rules around what gets encoded and who can style it.
 *
 * The decode check itself (every style through a real rasteriser and a QR
 * decoder) is scripts/qr-scan-check.mjs, which needs a browser.
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), 'ashrt-qr-'))
process.env.ASHRT_DATA_DIR = DATA_DIR
process.env.SESSION_SECRET = 'qr-test-secret-0123456789'
process.env.BASE_URL = 'http://localhost:4999'

let request, app, users, ratelimit, abuse, store

before(async () => {
  request = (await import('supertest')).default
  app = (await import('../server.js')).default
  ;({ users, store } = await import('../store.js'))
  ratelimit = await import('../lib/ratelimit.js')
  abuse = await import('../lib/abuse.js')
})

after(() => rmSync(DATA_DIR, { recursive: true, force: true }))
beforeEach(() => {
  ratelimit._resetMemory()
  abuse._clearCache()
})

let seq = 0
async function signup(plan = 'free') {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: `q${++seq}@example.com`, password: 'a-good-password' })
  assert.equal(res.status, 200)
  const u = await users.getById(res.body.user.id)
  u.plan = plan
  await users.update(u)
  return { cookie: res.headers['set-cookie'], id: res.body.user.id }
}

const TEXT = 'https://www.ashrt.link/aB3xY9z'

/** SVG comes back as bytes, not as parsed text. */
const svgOf = (res) => (typeof res.text === 'string' ? res.text : Buffer.from(res.body).toString('utf8'))
const PNG_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/* ------------------------------- rendering -------------------------------- */

test('the quiet zone is never dropped', () => {
  // Four modules on every side. It is the first thing people remove to make a
  // code look bigger, and it is why the code then stops scanning.
  const { size } = buildMatrix(TEXT, {})
  const svg = renderSvg(TEXT, {})
  const viewBox = svg.match(/viewBox="0 0 (\d+) (\d+)"/)
  assert.equal(Number(viewBox[1]), size + 8)
})

test('every module style still draws all three finder patterns', () => {
  for (const style of MODULE_STYLES) {
    for (const eyeStyle of EYE_STYLES) {
      const svg = renderSvg(TEXT, { style, eyeStyle })
      const shapes = eyeStyle === 'circle' ? svg.match(/<circle/g) : svg.match(/<rect[^>]*stroke=/g)
      assert.ok(shapes && shapes.length >= 3, `${style}+${eyeStyle} must keep three finders`)
    }
  }
})

test('a logo forces the error correction that makes it survivable', () => {
  // Level H can lose 30% of the code. Anything less prints something that
  // scans on the designer's phone and nowhere else.
  assert.equal(buildMatrix(TEXT, { ecLevel: 'L', logo: true }).level, 'H')
  assert.equal(buildMatrix(TEXT, { ecLevel: 'L', logo: false }).level, 'L')
})

test('a logo clears the modules underneath it rather than covering them', () => {
  const without = renderSvg(TEXT, { ecLevel: 'H' })
  const withLogo = renderSvg(TEXT, { logo: PNG_PIXEL })
  const count = (svg) => (svg.match(/M\d/g) || []).length
  assert.ok(count(withLogo) < count(without), 'the hole is real, not painted over')
  assert.ok(withLogo.includes('<image href="data:image/png;base64,'))
})

test('a caption cannot inject markup', () => {
  const svg = renderSvg(TEXT, { caption: '<script>alert(1)</script>' })
  assert.ok(!svg.includes('<script>'))
  assert.ok(svg.includes('&lt;script&gt;'))
})

test('an unknown style falls back rather than rendering nothing', () => {
  const svg = renderSvg(TEXT, { style: 'hexagons', eyeStyle: 'stars', ecLevel: 'Z' })
  assert.ok(svg.startsWith('<svg'))
  assert.ok(svg.includes('<path'))
})

/* --------------------------------- the API -------------------------------- */

test('a code encodes the short link, not the destination', async () => {
  const { cookie } = await signup()
  const made = await request(app).post('/api/links').set('Cookie', cookie).send({ url: 'example.com/very/long' })
  const res = await request(app).get(`/api/qr?slug=${made.body.slug}`).set('Cookie', cookie)
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /image\/svg/)
  // The destination is what changes; the code must not contain it.
  assert.ok(!svgOf(res).includes('very/long'))
})

test('a code for our own link carries the scan marker', async () => {
  const { cookie } = await signup()
  const made = await request(app).post('/api/links').set('Cookie', cookie).send({ url: 'example.com/scan' })
  const withMarker = await request(app)
    .get(`/api/qr?data=${encodeURIComponent('http://localhost:4999/' + made.body.slug)}`)
    .set('Cookie', cookie)
  assert.equal(withMarker.status, 200)

  // And a scan of that URL is counted as a scan, not as a plain click.
  await request(app)
    .get(`/${made.body.slug}?s=qr`)
    .set('User-Agent', 'Mozilla/5.0 (iPhone) AppleWebKit/605 Mobile Safari/604')
  await request(app).get(`/${made.body.slug}`).set('User-Agent', 'Mozilla/5.0 Chrome/120 Safari/537.36')

  const stats = await store.linkSummary(made.body.slug)
  assert.equal(stats.channels.qr, 1)
  assert.equal(stats.channels.link, 1)
  assert.equal(stats.clicks, 2, 'a scan is still a click')
})

test('the scan marker never reaches the destination', async () => {
  const { cookie } = await signup()
  const made = await request(app).post('/api/links').set('Cookie', cookie).send({ url: 'example.com/dest' })
  const hit = await request(app)
    .get(`/${made.body.slug}?s=qr`)
    .set('User-Agent', 'Mozilla/5.0 Chrome/120 Safari/537.36')
  assert.equal(hit.headers.location, 'https://example.com/dest')
})

test('styling is a paid feature, enforced on the server', async () => {
  const free = await signup('free')
  const denied = await request(app).patch('/api/qr/style').set('Cookie', free.cookie).send({ style: 'dots' })
  assert.equal(denied.status, 402)

  // And even if the record somehow carried a style, a free account renders plain.
  const u = await users.getById(free.id)
  u.qr = { style: 'dots', dark: '#FF0000' }
  await users.update(u)
  const res = await request(app).get('/api/qr?data=' + encodeURIComponent(TEXT)).set('Cookie', free.cookie)
  const svg = svgOf(res)
  assert.ok(svg.includes('#0A0A0A'), 'the plan decides, not the record')
  assert.ok(!svg.includes('#FF0000'))
})

test('a paid account saves a style and every code uses it', async () => {
  const pro = await signup('pro')
  const saved = await request(app)
    .patch('/api/qr/style')
    .set('Cookie', pro.cookie)
    .send({ style: 'dots', eyeStyle: 'circle', dark: '1D4ED8', caption: 'Scan me', frame: true })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.style.style, 'dots')

  const res = await request(app).get('/api/qr?data=' + encodeURIComponent(TEXT)).set('Cookie', pro.cookie)
  const svg = svgOf(res)
  assert.ok(svg.includes('#1D4ED8'))
  assert.ok(svg.includes('Scan me'))
  assert.ok(svg.includes('<circle'), 'the circular eyes are drawn')
})

test('an SVG logo is refused', async () => {
  const pro = await signup('pro')
  // An SVG can carry script and would be served back inside our own SVG, on
  // our own origin.
  const res = await request(app)
    .patch('/api/qr/style')
    .set('Cookie', pro.cookie)
    .send({ logo: 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+' })
  assert.equal(res.status, 400)
})

test('an oversized logo is refused with the limit named', async () => {
  const pro = await signup('pro')
  const huge = 'data:image/png;base64,' + 'A'.repeat(60 * 1024)
  const res = await request(app).patch('/api/qr/style').set('Cookie', pro.cookie).send({ logo: huge })
  assert.equal(res.status, 413)
  assert.match(res.body.error, /\d+KB/)
})

test('a guest can only encode one of our own short links', async () => {
  const mine = await request(app).get('/api/qr?data=' + encodeURIComponent('http://localhost:4999/abc123'))
  assert.equal(mine.status, 200)

  const anything = await request(app).get('/api/qr?data=' + encodeURIComponent('https://someone-else.example/page'))
  assert.equal(anything.status, 401, 'not a free QR API for scripts to point at')
})

test('a code cannot be generated for another account by short code', async () => {
  const mine = await signup()
  const theirs = await signup()
  const made = await request(app).post('/api/links').set('Cookie', theirs.cookie).send({ url: 'example.com/private' })
  const res = await request(app).get(`/api/qr?slug=${made.body.slug}`).set('Cookie', mine.cookie)
  assert.equal(res.status, 404)
})
