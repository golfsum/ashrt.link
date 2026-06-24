// Tiny dependency-free chart renderers (SVG + HTML). window.Charts.*

function flag(code) {
  if (!code || code.length !== 2 || code === 'XX') return '🌐'
  try {
    return code.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)))
  } catch {
    return '🌐'
  }
}

// Line chart with a soft area fill. points: [{label, value}]
function line(el, points) {
  if (!points || !points.length) return empty(el)
  const W = 820, H = 240, pad = { l: 6, r: 6, t: 16, b: 22 }
  const max = Math.max(1, ...points.map((p) => p.value))
  const n = points.length
  const X = (i) => pad.l + (n === 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r))
  const Y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b)
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(p.value).toFixed(1)}`).join(' ')
  const area = `${path} L ${X(n - 1).toFixed(1)} ${H - pad.b} L ${X(0).toFixed(1)} ${H - pad.b} Z`

  let grid = ''
  for (let g = 0; g <= 3; g++) {
    const gy = (pad.t + (g / 3) * (H - pad.t - pad.b)).toFixed(1)
    grid += `<line x1="${pad.l}" y1="${gy}" x2="${W - pad.r}" y2="${gy}" class="grid"/>`
  }
  let labels = ''
  const step = Math.max(1, Math.ceil(n / 7))
  for (let i = 0; i < n; i += step) labels += `<text x="${X(i).toFixed(1)}" y="${H - 5}" class="ax">${points[i].label}</text>`

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="chart line-chart">
    <defs><linearGradient id="areaGrad" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="var(--accent)" stop-opacity="0.30"/>
      <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    <path d="${area}" fill="url(#areaGrad)"/>
    <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${labels}
  </svg>`
}

// Donut with center total and a legend. data: [{label, value, color}]
function donut(el, data) {
  const total = data.reduce((s, d) => s + d.value, 0)
  if (!total) return empty(el)
  const size = 160, r = 60, cx = size / 2, cy = size / 2, sw = 20
  const C = 2 * Math.PI * r
  let off = 0
  const segs = data
    .filter((d) => d.value > 0)
    .map((d) => {
      const frac = d.value / total
      const dash = `${(frac * C).toFixed(2)} ${(C - frac * C).toFixed(2)}`
      const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${d.color}" stroke-width="${sw}" stroke-dasharray="${dash}" stroke-dashoffset="${(-off * C).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`
      off += frac
      return seg
    })
    .join('')
  const legend = data
    .map(
      (d) =>
        `<div class="lg"><span class="sw" style="background:${d.color}"></span>${d.label}<b>${d.value}</b></div>`,
    )
    .join('')
  el.innerHTML = `<div class="donut-wrap">
    <svg viewBox="0 0 ${size} ${size}" class="donut">
      ${segs}
      <text x="${cx}" y="${cy - 1}" class="donut-total" text-anchor="middle">${total.toLocaleString()}</text>
      <text x="${cx}" y="${cy + 15}" class="donut-sub" text-anchor="middle">clicks</text>
    </svg>
    <div class="legend">${legend}</div>
  </div>`
}

// Horizontal bar list. data: [{label, value}]. opts.flag adds country flags.
function barList(el, data, opts = {}) {
  if (!data || !data.length) return empty(el)
  const max = Math.max(...data.map((d) => d.value))
  const total = data.reduce((s, d) => s + d.value, 0)
  el.innerHTML = data
    .map((d) => {
      const pct = total ? Math.round((d.value / total) * 100) : 0
      const w = max ? Math.max(3, Math.round((d.value / max) * 100)) : 0
      const label = opts.flag ? `${flag(d.label)} ${d.label}` : d.label
      return `<div class="bar-row">
        <div class="bar-top"><span class="bar-label">${label}</span><span class="bar-val">${d.value.toLocaleString()} <span class="bar-pct">${pct}%</span></span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${w}%"></div></div>
      </div>`
    })
    .join('')
}

function empty(el) {
  el.innerHTML = '<div class="chart-empty">No data yet</div>'
}

window.Charts = { line, donut, barList, flag }
