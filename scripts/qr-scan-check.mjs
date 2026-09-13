#!/usr/bin/env node
/**
 * Does every style still scan?
 *
 * Renders each combination, rasterises it in a real browser, and decodes the
 * pixels with jsQR. A styled QR code that does not decode is not a style, it is
 * a bug that reaches the printer, and no unit test catches it: the SVG is
 * perfectly valid either way.
 *
 * Not part of `npm test`, because it needs a browser and a decoder that the app
 * itself does not:
 *
 *     npm i --no-save playwright jsqr && npx playwright install chromium
 *     node scripts/qr-scan-check.mjs
 *
 * Run it after touching lib/qr.js. It has already caught one real regression:
 * dots drawn at 84% of a module looked right and did not decode.
 */
import pw from 'playwright'
import jsQR from 'jsqr'
import { renderSvg, MODULE_STYLES, EYE_STYLES } from '../lib/qr.js'

const { chromium } = pw
const TEXT = 'https://www.ashrt.link/aB3xY9z?s=qr'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 600, height: 600 } })

// A tiny logo to test the hole.
const LOGO =
  'data:image/svg+xml;base64,' +
  Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#4F46E5"/></svg>').toString('base64')

const cases = []
for (const style of MODULE_STYLES) for (const eyeStyle of EYE_STYLES) cases.push({ style, eyeStyle })
cases.push({ style: 'dots', eyeStyle: 'circle', logo: LOGO, label: 'dots+circle+logo' })
cases.push({ style: 'rounded', eyeStyle: 'rounded', logo: LOGO, caption: 'Scan me', frame: true, label: 'everything on' })
cases.push({ style: 'square', eyeStyle: 'square', dark: '1D4ED8', light: 'FEF3C7', label: 'coloured' })

let failed = 0
for (const c of cases) {
  const svg = renderSvg(TEXT, { ...c, size: 420 })
  await page.setContent(`<body style="margin:0">${svg}</body>`)
  const shot = await page.locator('svg').screenshot()
  const png = await page.evaluate(async (b64) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const cv = document.createElement('canvas')
    cv.width = img.width
    cv.height = img.height
    const ctx = cv.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, cv.width, cv.height)
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, cv.width, cv.height)
    return { w: cv.width, h: cv.height, data: Array.from(d.data) }
  }, shot.toString('base64'))

  const result = jsQR(new Uint8ClampedArray(png.data), png.w, png.h)
  const name = c.label || `${c.style}+${c.eyeStyle}`
  const ok = result?.data === TEXT
  if (!ok) failed++
  console.log(`${ok ? 'SCANS  ' : 'FAILS  '} ${name}${ok ? '' : '  -> got: ' + JSON.stringify(result?.data)}`)
}
console.log(failed ? `\n${failed} style(s) do not decode` : '\nevery style decodes to the right URL')
await browser.close()
process.exit(failed ? 1 : 0)
