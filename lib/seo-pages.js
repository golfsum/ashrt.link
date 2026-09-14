import { ALL_SEO_TOPICS, SEO_TOPICS } from './seo-data.js'

const SITE = 'https://www.ashrt.link'
const RELEASE_DATE = '2026-09-14'
const bySlug = new Map(ALL_SEO_TOPICS.map((p) => [p.slug, p]))
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c')

const HUB_TYPE = { features: 'feature', solutions: 'channel', guides: 'guide', alternatives: 'alternative' }
const TYPE_LABEL = {
  feature: 'Features', channel: 'Solutions', industry: 'Industries', guide: 'Guides', alternative: 'Alternatives', hub: 'Resources',
}

export const STATIC_PUBLIC_PATHS = [
  '/', '/pricing', '/utm-link-tracker', '/qr-code-tracking', '/qr-code-generator',
  '/bitly-alternative', '/report', '/privacy', '/terms',
]

export const SEO_PATHS = ALL_SEO_TOPICS.map((p) => `/${p.slug}`)
export const SEO_PAGE_COUNT = SEO_PATHS.length

export function seoPageForPath(path) {
  const clean = String(path || '').split('?')[0].replace(/^\/+|\/+$/g, '')
  return bySlug.get(clean) || null
}

function description(page) {
  const suffix = page.type === 'alternative'
    ? ' Compare the workflow, analytics, branding, and plan tradeoffs before switching.'
    : ' See practical setup steps, measurement ideas, and how ashrt.link handles it.'
  return `${page.angle}${suffix}`.slice(0, 158)
}

function metricsFor(page) {
  const s = `${page.slug} ${page.title}`.toLowerCase()
  const metrics = ['human clicks vs bot previews', 'unique visitors', 'referring sites and channels', 'country and device mix', 'clicks by day and time']
  if (/qr|print|offline|event/.test(s)) metrics.unshift('QR scans separated from ordinary link clicks')
  if (/utm|campaign|affiliate|influencer|social|email|newsletter|ads/.test(s)) metrics.unshift('campaign and UTM performance')
  if (/route|smart|geo|device/.test(s)) metrics.unshift('traffic served by each routing rule')
  if (/health|monitor/.test(s)) metrics.unshift('destination status and failure history')
  return [...new Set(metrics)].slice(0, 6)
}

function examplesFor(page) {
  const s = `${page.slug} ${page.title}`.toLowerCase()
  if (/restaurant/.test(s)) return ['menu QR code', 'reservation link', 'review request', 'seasonal offer']
  if (/real-estate/.test(s)) return ['property listing', 'open-house sign', 'agent flyer', 'buyer follow-up']
  if (/ecommerce|retail/.test(s)) return ['product launch', 'discount campaign', 'influencer placement', 'receipt QR code']
  if (/nonprofit/.test(s)) return ['donation page', 'volunteer signup', 'event registration', 'newsletter appeal']
  if (/education/.test(s)) return ['enrollment page', 'campus event', 'course resource', 'poster QR code']
  if (/healthcare/.test(s)) return ['public education page', 'appointment campaign', 'event registration', 'printed resource']
  if (/recruit/.test(s)) return ['job post', 'employee referral', 'career fair QR code', 'candidate resource']
  if (/event/.test(s)) return ['registration page', 'booth QR code', 'speaker link', 'post-event follow-up']
  if (/youtube/.test(s)) return ['video description', 'pinned comment', 'sponsor link', 'channel campaign']
  if (/instagram|tiktok|twitter|facebook|linkedin|social/.test(s)) return ['organic post', 'profile link', 'paid placement', 'creator campaign']
  if (/email|newsletter/.test(s)) return ['hero CTA', 'article link', 'sponsor placement', 'footer CTA']
  if (/sms|whatsapp|support/.test(s)) return ['reminder', 'status update', 'promotion', 'help article']
  if (/affiliate/.test(s)) return ['partner A', 'partner B', 'sidebar placement', 'newsletter placement']
  if (/influencer|creator|podcast/.test(s)) return ['creator A', 'creator B', 'episode placement', 'sponsor CTA']
  if (/qr|print|offline/.test(s)) return ['flyer', 'poster', 'packaging', 'table tent']
  return ['social post', 'email campaign', 'QR code', 'partner placement']
}

function related(page, limit = 8) {
  const pool = SEO_TOPICS.filter((p) => p.slug !== page.slug)
  const same = pool.filter((p) => p.type === page.type)
  const cross = pool.filter((p) => p.type !== page.type)
  return [...same.slice(0, Math.min(6, limit)), ...cross.slice(0, limit)].slice(0, limit)
}

function commonProductBlock() {
  return `<section class="seo-card seo-plans">
    <h2>Start free, then add capacity when you need it</h2>
    <p>The Free plan requires a verified account. It includes 10 new links per rolling 30 days, 30 days of analytics, a campaign, QR codes, editable destinations, custom short codes, bot filtering, and basic API access. Existing links keep working after their creation window passes.</p>
    <div class="seo-grid three">
      <div><h3>Free</h3><p><strong>$0</strong></p><p>For testing real campaigns with link analytics. Verified account required.</p></div>
      <div><h3>Pro</h3><p><strong>$9/mo</strong></p><p>250 new links, one branded domain, longer analytics, branded QR, bulk creation, routing, and health monitoring.</p></div>
      <div><h3>Business</h3><p><strong>$29/mo</strong></p><p>2,500 new links, five branded domains, higher API limits, webhooks, and larger operating limits.</p></div>
    </div>
    <p class="seo-actions"><a class="btn" href="/signup">Create a verified free account</a><a class="btn btn-ghost" href="/pricing">Compare plans</a></p>
  </section>`
}

function featureBody(page) {
  const metrics = metricsFor(page)
  const examples = examplesFor(page)
  return `
    <section class="article seo-article">
      <h2>What ${esc(page.title.toLowerCase())} should solve</h2>
      <p>${esc(page.angle)} The useful part is not making a URL shorter for its own sake. The useful part is keeping one manageable object between the campaign and the destination: something you can name, organize, measure, edit when plans change, and audit later.</p>
      <p>With ashrt.link, the public short URL is separate from the destination. That separation is what makes destination changes, campaign organization, QR codes, analytics, and safety controls possible without asking you to replace every link already shared.</p>

      <h2>A practical workflow</h2>
      <ol class="seo-steps">
        <li><strong>Create the destination deliberately.</strong> Add campaign tags before sharing so the destination analytics and the link analytics describe the same campaign.</li>
        <li><strong>Name and organize the link.</strong> Use a readable alias, campaign, and tags so somebody can find it months later without guessing from a random code.</li>
        <li><strong>Share one measurable URL.</strong> Use the same link where you want combined reporting, or distinct links where you need placement-level attribution.</li>
        <li><strong>Read the response, then change the campaign.</strong> Compare traffic sources, timing, devices, and placements instead of treating total clicks as the only useful number.</li>
      </ol>

      <h2>Data you can use</h2>
      <ul class="tick-list">${metrics.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
      <p>Preview bots are kept apart from human clicks. That matters because services such as social networks and messaging apps often fetch a URL automatically to build a preview. Mixing those requests into the campaign total makes small campaigns look stronger than they actually were.</p>

      <h2>Example ways to use it</h2>
      <p>Start with placements such as ${examples.map(esc).join(', ')}. Use one short link when you want one combined total. Use separate links when the question is “which placement worked?” That single decision makes the resulting report much easier to interpret.</p>

      <h2>What to avoid</h2>
      <ul class="tick-list"><li>Do not reuse one link across every channel if you need channel-level attribution.</li><li>Do not change a destination without checking recent traffic first; a link already in circulation may still be active.</li><li>Do not judge a campaign from raw clicks alone. Referrers, devices, geography, and timing explain why the total moved.</li><li>Do not use a shortener as a way to hide unsafe destinations. ashrt.link validates destinations and can disable risky links.</li></ul>
    </section>`
}

function channelBody(page) {
  const examples = examplesFor(page)
  const metrics = metricsFor(page)
  return `<section class="article seo-article">
    <h2>Measure the placement, not just the destination</h2>
    <p>${esc(page.angle)} A destination page can tell you that somebody arrived, but it often cannot tell you which exact post, message, printed piece, creator, or placement produced the visit. Trackable short links solve that by making the shared URL itself the measurement point.</p>
    <p>For ${esc(page.title.toLowerCase())}, create separate links for placements you want to compare. A useful naming scheme might distinguish ${examples.map(esc).join(', ')}. Keep the destination the same if the offer is the same; change only the tracking link so the reports stay comparable.</p>

    <h2>Recommended setup</h2>
    <ol class="seo-steps"><li>Create a campaign for the initiative, not for every individual link.</li><li>Add consistent UTM source, medium, and campaign values when the destination supports web analytics.</li><li>Create a distinct short link for each placement you want to compare.</li><li>Use readable aliases internally or publicly so the links remain recognizable.</li><li>Review performance after enough traffic has accumulated, then retire or redirect weak placements instead of deleting history.</li></ol>

    <h2>Metrics worth watching</h2>
    <ul class="tick-list">${metrics.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
    <p>The point is not to collect every possible dimension. It is to answer a campaign question with as little ambiguity as possible: which message produced the visit, what kind of visitor clicked, and when did the response happen?</p>

    <h2>Why a short link helps even when you already use analytics</h2>
    <p>Destination analytics and link analytics answer different questions. Destination analytics describes behavior after arrival. A short-link redirect describes the act of getting there. The link layer keeps working when the destination belongs to somebody else, when the destination changes, or when the campaign lives in print, SMS, a podcast, or another environment where conventional page tagging is incomplete.</p>
  </section>`
}

function industryBody(page) {
  const examples = examplesFor(page)
  return `<section class="article seo-article">
    <h2>Where short links fit</h2>
    <p>${esc(page.angle)} The best use cases are the ones where a URL has to move between channels or stay useful longer than the page it originally pointed at.</p>
    <p>For this kind of team, common placements include ${examples.map(esc).join(', ')}. Each can use a distinct link so performance is visible without rebuilding the destination page or maintaining a separate spreadsheet of opaque URLs.</p>

    <h2>A simple operating model</h2>
    <div class="seo-grid"><div><h3>One campaign</h3><p>Group related links under the same campaign name so reporting follows the initiative rather than the person who created the URL.</p></div><div><h3>One link per decision</h3><p>If two placements need to be compared, give them separate links. If they do not, use one link and keep the report simple.</p></div><div><h3>One branded domain</h3><p>For public-facing campaigns, a custom short domain makes the source recognizable and keeps the link consistent with the rest of the brand.</p></div><div><h3>One source of link truth</h3><p>Edit destinations and keep history in the link platform instead of changing URLs in many documents and posts.</p></div></div>

    <h2>What the dashboard can tell you</h2>
    <p>ashrt.link reports human clicks separately from preview bots, plus unique visitors, referrers, countries, devices, browsers, operating systems, and click timing. QR scans can be marked separately from ordinary clicks when the QR code is generated from the short link.</p>

    <h2>Safety matters more for public links</h2>
    <p>Public shorteners attract abuse because the final destination is not visible in the short URL. ashrt.link uses destination validation, blocklists, rate limits, abuse scoring, reports, account verification, and administrative suspension tools. Those controls protect legitimate customers too: a short-link domain that becomes known for malware is less useful to every real business sharing it.</p>
  </section>`
}

function guideBody(page) {
  const metrics = metricsFor(page)
  return `<section class="article seo-article">
    <h2>The short version</h2>
    <p>${esc(page.angle)} The reliable approach is to decide what you need to measure first, create a URL structure that preserves that distinction, and only then distribute the link. Tracking added after the campaign starts cannot recover placement information that was never encoded.</p>

    <h2>Step by step</h2>
    <ol class="seo-steps"><li><strong>Define the destination.</strong> Use the final page people should reach and confirm it works on the devices your audience will use.</li><li><strong>Define attribution.</strong> Add UTMs where appropriate and decide whether each channel or placement needs its own short link.</li><li><strong>Create the trackable link.</strong> Use a readable alias when the URL will be spoken, printed, or shown publicly.</li><li><strong>Test before distribution.</strong> Open the link, confirm the redirect, and test QR codes from the actual printed or displayed size.</li><li><strong>Review useful dimensions.</strong> Look beyond the total and compare ${metrics.slice(0,4).map(esc).join(', ')}.</li><li><strong>Keep the public URL stable.</strong> If the destination needs to change, edit the destination rather than replacing a link already in circulation.</li></ol>

    <h2>Common measurement mistakes</h2>
    <ul class="tick-list"><li>Using the same URL everywhere and later expecting channel-level attribution.</li><li>Counting social preview bots as people.</li><li>Using inconsistent UTM capitalization and spelling across a campaign.</li><li>Deleting an old short link instead of redirecting it to a useful replacement.</li><li>Changing a live destination without checking whether the link still receives traffic.</li></ul>

    <h2>How ashrt.link approaches it</h2>
    <p>Each short link keeps its destination, click data, campaign, tags, change history, and optional routing rules together. The Free plan is intentionally usable for real testing and requires a verified account. Higher plans add branded domains, longer analytics retention, routing, bulk workflows, monitoring, and automation rather than taking basic measurement away.</p>
  </section>`
}

function alternativeBody(page) {
  const competitor = page.title.replace(/ Alternative$| vs ashrt\.link$/i, '')
  return `<section class="article seo-article">
    <h2>What to compare before switching</h2>
    <p>${esc(page.angle)} This page does not assume that ${esc(competitor)} is the wrong tool. The right comparison is the workflow you actually need, the limits you will hit, and what becomes more expensive as usage grows.</p>
    <div class="cmp-scroll"><table class="cmp"><thead><tr><th>Decision</th><th>ashrt.link</th><th>Check on ${esc(competitor)}</th></tr></thead><tbody>
      <tr><td>Free analytics</td><td>30-day analytics on a verified Free account</td><td>History length, dimensions, and whether analytics require a paid tier</td></tr>
      <tr><td>Branded domain</td><td>Included on Pro at $9/month</td><td>Which plan first includes a custom domain and any domain limits</td></tr>
      <tr><td>Editable destinations</td><td>Supported, with destination history by plan</td><td>Redirect limits, history, and whether edits consume a quota</td></tr>
      <tr><td>QR codes</td><td>QR for links; paid styling and higher download limits</td><td>Dynamic vs static behavior, styling, exports, and scan analytics</td></tr>
      <tr><td>Routing</td><td>Country/device routing on Pro and Business</td><td>Rule types, limits, fallback behavior, and reporting</td></tr>
      <tr><td>API</td><td>Daily API allowance on each plan</td><td>Authentication, rate limits, webhooks, and bulk operations</td></tr>
    </tbody></table></div>

    <h2>Where ashrt.link is intentionally simpler</h2>
    <p>The product is aimed at individuals, creators, marketers, developers, agencies, and small teams that want direct redirects, useful analytics, editable destinations, branded domains, QR codes, and campaign organization without jumping immediately into enterprise pricing. It does not try to copy another product's interface or every enterprise feature.</p>

    <h2>Migration does not need to be all at once</h2>
    <p>Old short links on another provider can keep working. A practical migration is to create new campaign links in ashrt.link, move a branded domain only when you are ready, and leave historic links alone unless there is a reason to replace them. This avoids breaking links that are already in email archives, social posts, printed pieces, or documentation.</p>

    <h2>Verify current competitor details</h2>
    <p>Shortener plans change often. Before deciding, check ${esc(competitor)}'s current pricing and documentation for link quotas, analytics retention, custom-domain rules, QR features, API limits, and team features. Then compare those numbers with the live <a href="/pricing">ashrt.link pricing page</a>, which is rendered from the same plan configuration the application enforces.</p>
  </section>`
}

function hubBody(page) {
  const target = HUB_TYPE[page.slug]
  let list
  if (page.slug === 'solutions') list = SEO_TOPICS.filter((p) => p.type === 'channel' || p.type === 'industry')
  else list = SEO_TOPICS.filter((p) => p.type === target)
  return `<section class="article seo-article"><h2>Explore ${esc(page.title.toLowerCase())}</h2><p>${esc(page.angle)} These pages are grouped by search intent so you can jump directly to the workflow, industry, or question you are trying to solve.</p><div class="seo-link-grid">${list.map((p) => `<a href="/${p.slug}"><strong>${esc(p.title)}</strong><span>${esc(p.angle)}</span></a>`).join('')}</div></section>`
}

function bodyFor(page) {
  if (page.type === 'feature') return featureBody(page)
  if (page.type === 'channel') return channelBody(page)
  if (page.type === 'industry') return industryBody(page)
  if (page.type === 'guide') return guideBody(page)
  if (page.type === 'alternative') return alternativeBody(page)
  return hubBody(page)
}

function faqs(page) {
  const base = [
    { q: `Does ${page.title} work on the Free plan?`, a: 'Core link creation and analytics are available on the Free plan, which requires a verified account. Some features such as branded domains, smart routing, bulk creation, branded QR styling, and longer analytics retention require a paid plan.' },
    { q: 'Do short links add an advertising page before the destination?', a: 'No. Normal ashrt.link URLs redirect directly to the destination. A safety warning can appear only when a link has been flagged for review.' },
    { q: 'Can I change a destination after sharing the short link?', a: 'Yes. Destinations are editable. The amount of destination history available for rollback depends on the plan.' },
  ]
  if (page.type === 'alternative') base.unshift({ q: `Is ashrt.link a replacement for ${page.title.replace(/ Alternative$| vs ashrt\.link$/i, '')}?`, a: 'It can replace common short-link, QR, analytics, branded-domain, and campaign workflows, but you should compare any specialized integrations, enterprise controls, or deep-linking requirements you rely on before migrating.' })
  if (page.type === 'guide') base.unshift({ q: `What is the main goal of ${page.title.toLowerCase()}?`, a: page.angle })
  return base.slice(0, 4)
}

function header() {
  return `<header><a class="logo" href="/"><svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#14141b" stroke="#2a2a38"/><path d="M13 19l6-6M12.5 14.5l-2 2a3.5 3.5 0 0 0 5 5l2-2M19.5 17.5l2-2a3.5 3.5 0 0 0-5-5l-2 2" fill="none" stroke="#818cf8" stroke-width="2" stroke-linecap="round"/></svg>ashrt<span class="dot">.link</span></a><nav class="nav"><a href="/features">Features</a><a href="/solutions">Solutions</a><a href="/guides">Guides</a><a href="/pricing">Pricing</a><a class="btn btn-sm" href="/signup">Start free</a></nav></header>`
}

export function renderSeoPage(page) {
  const canonical = `${SITE}/${page.slug}`
  const faq = faqs(page)
  const rel = related(page)
  const label = TYPE_LABEL[page.type] || 'Resources'
  const schema = {
    '@context': 'https://schema.org', '@type': page.type === 'guide' ? 'TechArticle' : 'WebPage',
    name: page.title, description: description(page), url: canonical, dateModified: RELEASE_DATE,
    publisher: { '@type': 'Organization', name: 'ashrt.link', url: SITE },
  }
  const breadcrumb = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'ashrt.link', item: `${SITE}/` },
    { '@type': 'ListItem', position: 2, name: label, item: `${SITE}/${page.type === 'guide' ? 'guides' : page.type === 'alternative' ? 'alternatives' : page.type === 'feature' ? 'features' : 'solutions'}` },
    { '@type': 'ListItem', position: 3, name: page.title, item: canonical },
  ] }
  const faqSchema = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })) }
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>${esc(page.title)} | ashrt.link</title><meta name="description" content="${esc(description(page))}"/><link rel="canonical" href="${canonical}"/><link rel="icon" type="image/svg+xml" href="/favicon.svg"/><meta property="og:type" content="article"/><meta property="og:site_name" content="ashrt.link"/><meta property="og:url" content="${canonical}"/><meta property="og:title" content="${esc(page.title)} | ashrt.link"/><meta property="og:description" content="${esc(description(page))}"/><meta name="twitter:card" content="summary"/><meta name="twitter:title" content="${esc(page.title)} | ashrt.link"/><meta name="twitter:description" content="${esc(description(page))}"/><link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"/><link rel="stylesheet" href="/styles.css"/><style>.seo-hero{padding:44px 0 28px}.seo-kicker{color:var(--accent);font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.08em}.seo-hero h1{font-size:46px;line-height:1.06;margin:10px 0 14px;letter-spacing:-.035em}.seo-hero p{font-size:18px;line-height:1.65;color:var(--muted);max-width:760px}.seo-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}.seo-actions a{text-decoration:none}.seo-card{margin:28px 0;background:var(--panel);border:1px solid var(--border);border-radius:18px;padding:24px}.seo-card h2{margin-bottom:10px}.seo-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin:18px 0}.seo-grid.three{grid-template-columns:repeat(3,1fr)}.seo-grid>div{background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:16px}.seo-grid h3{margin-bottom:6px}.seo-article{line-height:1.75}.seo-article h2{margin-top:36px}.seo-steps{padding-left:22px}.seo-steps li{margin:12px 0}.seo-link-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin:18px 0}.seo-link-grid a{display:flex;flex-direction:column;gap:5px;padding:16px;border:1px solid var(--border);border-radius:12px;text-decoration:none;background:var(--bg)}.seo-link-grid strong{color:var(--text)}.seo-link-grid span{color:var(--muted);font-size:13px;line-height:1.5}.seo-faq details{border-top:1px solid var(--border);padding:14px 0}.seo-faq summary{cursor:pointer;font-weight:700}.seo-faq p{margin-top:8px;color:var(--muted);line-height:1.65}.seo-related a{display:inline-block;margin:4px 8px 4px 0}.crumbs{padding-top:8px}@media(max-width:760px){.seo-hero h1{font-size:35px}.seo-grid,.seo-grid.three,.seo-link-grid{grid-template-columns:1fr}.nav a:not(.btn){display:none}}</style><script type="application/ld+json">${json(schema)}</script><script type="application/ld+json">${json(breadcrumb)}</script><script type="application/ld+json">${json(faqSchema)}</script></head><body><div class="wrap">${header()}<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> <span>/</span> <a href="/${page.type === 'guide' ? 'guides' : page.type === 'alternative' ? 'alternatives' : page.type === 'feature' ? 'features' : 'solutions'}">${label}</a> <span>/</span> <span>${esc(page.title)}</span></nav><main><section class="seo-hero"><div class="seo-kicker">${label}</div><h1>${esc(page.title)}</h1><p>${esc(page.angle)}</p><div class="seo-actions"><a class="btn btn-lg" href="/signup">Start with a verified free account</a><a class="btn btn-ghost btn-lg" href="/pricing">See pricing</a></div></section>${bodyFor(page)}${page.type === 'hub' ? '' : commonProductBlock()}<section class="seo-card seo-faq"><h2>Frequently asked questions</h2>${faq.map((x) => `<details><summary>${esc(x.q)}</summary><p>${esc(x.a)}</p></details>`).join('')}</section><section class="related seo-related"><h2>Related pages</h2><div class="related-links">${rel.map((p) => `<a href="/${p.slug}">${esc(p.title)}</a>`).join('')}<a href="/pricing">Pricing</a><a href="/bitly-alternative">Bitly comparison</a></div></section></main><footer><span>© 2026 ashrt.link</span><span class="foot-links"><a href="/pricing">Pricing</a> · <a href="/guides">Guides</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/report">Report a link</a></span></footer></div></body></html>`
}

export function sitemapXml() {
  const rows = [
    ...STATIC_PUBLIC_PATHS.map((path) => ({ path, priority: path === '/' ? '1.0' : ['pricing','bitly-alternative'].includes(path.slice(1)) ? '0.9' : '0.7' })),
    ...ALL_SEO_TOPICS.map((p) => ({ path: `/${p.slug}`, priority: p.type === 'hub' ? '0.9' : p.type === 'feature' ? '0.8' : '0.7' })),
  ]
  const urls = rows.map((r) => `  <url><loc>${SITE}${r.path}</loc><lastmod>${RELEASE_DATE}</lastmod><changefreq>monthly</changefreq><priority>${r.priority}</priority></url>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
}
