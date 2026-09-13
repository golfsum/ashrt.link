/**
 * QR rendering.
 *
 * The `qrcode` package produces the module matrix; everything visual is drawn
 * here, because the package only knows how to draw plain squares and a QR code
 * that has to look like it belongs on a poster needs more than that.
 *
 * Rules that are not negotiable, whatever the styling:
 *
 *   - The three finder patterns keep their shape and their 1:1:3:1:1 ratio.
 *     Rounding their corners is fine; changing their proportions is not, and
 *     that is what makes a "designed" QR code fail to scan.
 *   - The quiet zone stays. Four modules is the specification's number, and it
 *     is the first thing people delete to make the code look bigger.
 *   - A logo only goes in the middle, only up to a fraction of the area, and
 *     only at error-correction level H, which can lose 30% of the code and
 *     still read. Anything else prints something that scans on the designer's
 *     phone and nowhere else.
 *
 * Output is SVG. A browser turns it into a PNG at whatever resolution the
 * person asks for, which is better than picking one server-side and is how the
 * high-resolution export works without a rasteriser on the server.
 */

import QRCode from 'qrcode'

export const MODULE_STYLES = ['square', 'rounded', 'dots']
export const EYE_STYLES = ['square', 'rounded', 'circle']
export const EC_LEVELS = ['L', 'M', 'Q', 'H']

/** The specification's quiet zone, in modules. */
const QUIET = 4

/** How much of the code a centre logo may cover. */
const MAX_LOGO_RATIO = 0.22

const clampHex = (value, fallback) => {
  const hex = String(value || '').replace('#', '')
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : fallback
}

/**
 * The matrix, plus where the finder patterns are.
 *
 * A logo forces level H: the point of the logo is that the code still reads
 * with part of it covered, and only H has the redundancy for that.
 */
export function buildMatrix(text, { ecLevel = 'M', logo = false } = {}) {
  const level = logo ? 'H' : EC_LEVELS.includes(ecLevel) ? ecLevel : 'M'
  const qr = QRCode.create(String(text), { errorCorrectionLevel: level })
  const size = qr.modules.size
  const data = qr.modules.data
  return {
    size,
    level,
    version: qr.version,
    at: (x, y) => x >= 0 && y >= 0 && x < size && y < size && data[y * size + x] === 1,
  }
}

/** Is this module part of one of the three finder patterns? */
function inFinder(x, y, size) {
  const near = (cx, cy) => x >= cx && x < cx + 7 && y >= cy && y < cy + 7
  return near(0, 0) || near(size - 7, 0) || near(0, size - 7)
}

/** One data module, drawn in the chosen style. */
function modulePath(x, y, style) {
  // Nearly the full module. Smaller dots look better on screen and decode
  // worse: a scanner samples the centre of each module and a thin dot loses
  // contrast the moment the code is printed small or photographed at an angle.
  if (style === 'dots') return `M${x + 0.5} ${y + 0.02}a0.48 0.48 0 1 0 0.001 0z`
  if (style === 'rounded') return `M${x + 0.12} ${y}h0.76a0.12 0.12 0 0 1 0.12 0.12v0.76a0.12 0.12 0 0 1 -0.12 0.12h-0.76a0.12 0.12 0 0 1 -0.12 -0.12v-0.76a0.12 0.12 0 0 1 0.12 -0.12z`
  return `M${x} ${y}h1v1h-1z`
}

/**
 * One finder pattern: a 7x7 ring with a 3x3 centre.
 *
 * Drawn as whole shapes rather than module by module so the ring stays
 * unbroken. A scanner looks for this ratio before it looks at anything else.
 */
function finder(cx, cy, style, color) {
  if (style === 'circle') {
    return (
      `<circle cx="${cx + 3.5}" cy="${cy + 3.5}" r="3" fill="none" stroke="${color}" stroke-width="1"/>` +
      `<circle cx="${cx + 3.5}" cy="${cy + 3.5}" r="1.5" fill="${color}"/>`
    )
  }
  const r = style === 'rounded' ? 1.6 : 0
  const ri = style === 'rounded' ? 0.7 : 0
  return (
    `<rect x="${cx + 0.5}" y="${cy + 0.5}" width="6" height="6" rx="${r}" fill="none" stroke="${color}" stroke-width="1"/>` +
    `<rect x="${cx + 2}" y="${cy + 2}" width="3" height="3" rx="${ri}" fill="${color}"/>`
  )
}

/**
 * Should this module be cleared for the logo?
 *
 * The hole is square and centred, and its size is capped: past roughly a fifth
 * of the code even level H starts to fail on a bad print or a low camera.
 */
function logoHole(size, ratio) {
  const span = Math.floor(size * Math.min(ratio, MAX_LOGO_RATIO))
  const half = Math.floor(span / 2)
  const mid = Math.floor(size / 2)
  // One module of padding so the logo never touches live modules.
  return { from: mid - half - 1, to: mid + half + 1 }
}

/**
 * Render to SVG.
 *
 * @param {string} text                  what the code encodes
 * @param {object} opts
 * @param {string} [opts.dark]           module colour
 * @param {string} [opts.light]          background, or 'transparent'
 * @param {string} [opts.style]          square | rounded | dots
 * @param {string} [opts.eyeStyle]       square | rounded | circle
 * @param {string} [opts.ecLevel]        L | M | Q | H
 * @param {string} [opts.logo]           a data: URI to place in the centre
 * @param {string} [opts.caption]        text under the code, e.g. "Scan me"
 * @param {boolean} [opts.frame]         draw a border around the whole thing
 * @param {number} [opts.size]           pixel size of the square code area
 */
export function renderSvg(text, opts = {}) {
  const dark = clampHex(opts.dark, '#0A0A0A')
  const transparent = opts.light === 'transparent'
  const light = transparent ? 'none' : clampHex(opts.light, '#FFFFFF')
  const style = MODULE_STYLES.includes(opts.style) ? opts.style : 'square'
  const eyeStyle = EYE_STYLES.includes(opts.eyeStyle) ? opts.eyeStyle : 'square'
  const caption = String(opts.caption || '').trim().slice(0, 40)
  const frame = Boolean(opts.frame)
  const px = Math.min(Math.max(Number(opts.size) || 512, 96), 2048)

  const logo = typeof opts.logo === 'string' && opts.logo.startsWith('data:image/') ? opts.logo : null
  const m = buildMatrix(text, { ecLevel: opts.ecLevel, logo: Boolean(logo) })

  const captionBand = caption ? 3 : 0
  const framePad = frame ? 1 : 0
  const span = m.size + QUIET * 2 + framePad * 2
  const height = span + captionBand

  const hole = logo ? logoHole(m.size, Number(opts.logoRatio) || 0.2) : null
  const off = QUIET + framePad

  const cells = []
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.at(x, y)) continue
      if (inFinder(x, y, m.size)) continue
      if (hole && x >= hole.from && x <= hole.to && y >= hole.from && y <= hole.to) continue
      cells.push(modulePath(x + off, y + off, style))
    }
  }

  const eyes =
    finder(off, off, eyeStyle, dark) +
    finder(off + m.size - 7, off, eyeStyle, dark) +
    finder(off, off + m.size - 7, eyeStyle, dark)

  const logoPx = hole ? hole.to - hole.from + 1 - 1 : 0
  const logoImg = logo
    ? `<rect x="${off + hole.from}" y="${off + hole.from}" width="${hole.to - hole.from + 1}" height="${hole.to - hole.from + 1}" rx="1" fill="${transparent ? '#FFFFFF' : light}"/>` +
      `<image href="${logo}" x="${off + hole.from + 0.5}" y="${off + hole.from + 0.5}" width="${logoPx}" height="${logoPx}" preserveAspectRatio="xMidYMid meet"/>`
    : ''

  const frameRect = frame
    ? `<rect x="0.5" y="0.5" width="${span - 1}" height="${height - 1}" rx="2" fill="none" stroke="${dark}" stroke-width="0.6"/>`
    : ''

  const captionText = caption
    ? `<text x="${span / 2}" y="${span + 1.9}" text-anchor="middle" font-family="Inter, system-ui, -apple-system, Segoe UI, sans-serif" font-size="1.9" font-weight="600" fill="${dark}">${escapeXml(caption)}</text>`
    : ''

  const scale = px / span
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(px)}" height="${Math.round(height * scale)}" ` +
    // crispEdges keeps square modules sharp at any size, but it is exactly
    // wrong for rounded corners and dots, which need anti-aliasing.
    `viewBox="0 0 ${span} ${height}" shape-rendering="${style === 'square' && eyeStyle === 'square' ? 'crispEdges' : 'geometricPrecision'}">` +
    (transparent ? '' : `<rect width="${span}" height="${height}" fill="${light}"/>`) +
    frameRect +
    `<path fill="${dark}" d="${cells.join('')}"/>` +
    eyes +
    logoImg +
    captionText +
    '</svg>'
  )
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[c])
}
