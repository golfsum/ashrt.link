const rows = (type, text) => text.trim().split('\n').map((line) => {
  const [slug, title, angle] = line.split('|')
  return { type, slug, title, angle }
})

export const SEO_TOPICS = [
  ...rows('feature', `
url-shortener|URL Shortener|Create short, branded, measurable links for campaigns, messages, and everyday sharing.
link-tracker|Link Tracker|Track clicks, referrers, countries, devices, browsers, and time-of-day trends from one short URL.
short-link-tracker|Short Link Tracker|Turn a compact URL into a measurable campaign asset with first-party click data.
branded-links|Branded Links|Use your own domain for short links so every campaign URL reinforces your brand.
custom-url-shortener|Custom URL Shortener|Create memorable short links with custom back-halves instead of random codes.
custom-domain-url-shortener|Custom Domain URL Shortener|Shorten links on your own branded domain and manage them from one dashboard.
dynamic-links|Dynamic Links|Keep the public short URL the same while changing its destination when plans change.
editable-short-links|Editable Short Links|Change a short link destination after it has been published and keep a history of changes.
link-management|Link Management|Organize short links, destinations, tags, campaigns, and performance from one place.
link-analytics|Link Analytics|See how short links perform across channels without relying only on destination-site analytics.
click-tracking|Click Tracking|Measure when and where people click a shared link before they reach the destination.
url-analytics|URL Analytics|Add measurable performance data to the URLs you share across campaigns.
campaign-tracking|Campaign Tracking|Group related links and compare campaign performance across channels and placements.
utm-builder|UTM Builder|Build consistent campaign URLs with UTM parameters and pair them with trackable short links.
smart-links|Smart Links|Route visitors to different destinations based on country or device while keeping one public URL.
geo-redirect-links|Geo Redirect Links|Send visitors to different pages based on country using one short URL.
device-routing-links|Device Routing Links|Send mobile and desktop visitors to different destinations from one short link.
link-health-monitoring|Link Health Monitoring|Watch destination pages for failures so broken links can be fixed before campaigns waste traffic.
bulk-url-shortener|Bulk URL Shortener|Create many short links at once for large campaigns, catalogs, or imports.
link-api|URL Shortener API|Create, manage, and analyze short links programmatically with API keys and usage controls.
`),
  ...rows('channel', `
social-media-link-tracking|Social Media Link Tracking|Track which social posts and profiles send real clicks instead of relying on platform engagement alone.
email-link-tracking|Email Link Tracking|Measure clicks from newsletters and lifecycle emails with short links that stay readable.
sms-link-tracking|SMS Link Tracking|Use compact trackable links in text messages where every character matters.
affiliate-link-tracking|Affiliate Link Tracking|Give each partner or placement a distinct trackable link and compare the traffic each one produces.
influencer-link-tracking|Influencer Link Tracking|Assign trackable links by creator, platform, or campaign so influencer traffic can be compared directly.
podcast-link-tracking|Podcast Link Tracking|Create memorable spoken URLs and measure which episodes or placements drive visits.
youtube-link-tracking|YouTube Link Tracking|Track clicks from descriptions, pinned comments, and video-specific calls to action.
instagram-link-tracking|Instagram Link Tracking|Measure clicks from bios, stories, DMs, and campaign placements with distinct trackable links.
tiktok-link-tracking|TikTok Link Tracking|Use trackable links for bios, profiles, and off-platform campaign calls to action.
linkedin-link-tracking|LinkedIn Link Tracking|Compare clicks from posts, newsletters, employee advocacy, and company-page campaigns.
facebook-link-tracking|Facebook Link Tracking|Track traffic from organic posts, groups, pages, and paid campaigns with distinct short links.
twitter-x-link-tracking|X / Twitter Link Tracking|Measure clicks from posts, replies, profiles, and campaigns without mixing every placement together.
whatsapp-link-tracking|WhatsApp Link Tracking|Track links shared in customer chats, broadcast messages, and support workflows.
newsletter-link-tracking|Newsletter Link Tracking|Track article, sponsor, and CTA clicks from each newsletter edition.
paid-ad-link-tracking|Paid Ad Link Tracking|Add an independent click measurement layer to campaign destinations across ad platforms.
print-campaign-tracking|Print Campaign Tracking|Connect flyers, postcards, packaging, and signage to measurable digital traffic.
offline-marketing-tracking|Offline Marketing Tracking|Measure response from physical campaigns with placement-specific short links or QR codes.
event-qr-code-tracking|Event QR Code Tracking|Track scans from booths, badges, posters, handouts, and stage screens with placement-specific QR codes.
creator-link-tracking|Creator Link Tracking|Measure traffic from videos, newsletters, podcasts, bios, and sponsorships by placement.
customer-support-links|Customer Support Link Tracking|Use short links in support messages and see which help resources customers actually open.
`),
  ...rows('industry', `
url-shortener-for-small-business|URL Shortener for Small Business|Create professional short links, QR codes, and campaign tracking without enterprise complexity.
url-shortener-for-ecommerce|URL Shortener for Ecommerce|Track product, promotion, influencer, and abandoned-cart links across channels.
url-shortener-for-retail|URL Shortener for Retail|Connect store signage, receipts, email, social, and QR campaigns to measurable traffic.
url-shortener-for-restaurants|URL Shortener for Restaurants|Create memorable links and QR codes for menus, reservations, reviews, offers, and events.
url-shortener-for-real-estate|URL Shortener for Real Estate|Track listing, open-house, sign, flyer, and agent-profile links by property and campaign.
url-shortener-for-marketing-agencies|URL Shortener for Marketing Agencies|Manage client links, branded domains, campaigns, and analytics from a repeatable workflow.
url-shortener-for-nonprofits|URL Shortener for Nonprofits|Track donations, events, volunteer signups, newsletters, and campaign QR codes.
url-shortener-for-education|URL Shortener for Education|Share measurable links for enrollment, events, resources, QR codes, and campus communications.
url-shortener-for-healthcare|URL Shortener for Healthcare Marketing|Create concise campaign links for public-facing education, scheduling, events, and outreach.
url-shortener-for-financial-services|URL Shortener for Financial Services Marketing|Use branded, trackable links for public campaigns, educational content, and customer communications.
url-shortener-for-insurance|URL Shortener for Insurance Marketing|Track quote, claims-resource, agent, campaign, and educational links across channels.
url-shortener-for-hospitality|URL Shortener for Hospitality|Track booking, amenity, event, review, and on-property QR links across guest touchpoints.
url-shortener-for-travel|URL Shortener for Travel Marketing|Measure clicks from itineraries, social campaigns, partner offers, newsletters, and QR placements.
url-shortener-for-media|URL Shortener for Media and Publishers|Track article promotion, newsletters, social distribution, sponsorships, and QR placements.
url-shortener-for-content-creators|URL Shortener for Content Creators|Use memorable links across videos, podcasts, bios, newsletters, and sponsorships.
url-shortener-for-saas|URL Shortener for SaaS|Track product launches, onboarding, docs, lifecycle emails, affiliates, and campaign links.
url-shortener-for-technology|URL Shortener for Technology Companies|Create branded, measurable links for launches, documentation, events, support, and growth campaigns.
url-shortener-for-recruiting|URL Shortener for Recruiting|Track job posts, referral links, event QR codes, recruiter outreach, and candidate resources.
url-shortener-for-events|URL Shortener for Event Marketing|Track registrations, speaker pages, sponsor offers, booth QR codes, and follow-up campaigns.
url-shortener-for-local-business|URL Shortener for Local Business|Create trackable links for reviews, directions, booking, promotions, flyers, and neighborhood campaigns.
`),
  ...rows('guide', `
what-is-a-url-shortener|What Is a URL Shortener?|Learn how URL shorteners work, what happens during a redirect, and when a short link is useful.
how-to-shorten-a-url|How to Shorten a URL|A practical walkthrough for turning a long destination into a compact, trackable short link.
how-to-create-a-short-link|How to Create a Short Link|Create a short link that is easy to share, measurable, and safe to update later.
how-to-track-link-clicks|How to Track Link Clicks|Measure clicks, referrers, devices, countries, and timing from links you share.
how-to-track-qr-code-scans|How to Track QR Code Scans|Use a trackable short link behind a QR code so scans can be measured and compared.
how-to-track-links-in-google-analytics|How to Track Links in Google Analytics|Use UTM parameters and trackable short links together for cleaner campaign attribution.
utm-parameters-guide|UTM Parameters Guide|Understand utm_source, utm_medium, utm_campaign, utm_term, and utm_content with practical naming rules.
utm-source-vs-medium|UTM Source vs Medium|Choose consistent UTM source and medium values so campaign reports stay readable.
custom-short-url-guide|Custom Short URL Guide|Create readable short URLs with meaningful aliases and a consistent naming system.
branded-links-guide|Branded Links Guide|Learn how custom short domains work and when branded links are worth using.
dynamic-qr-code-guide|Dynamic QR Code Guide|Understand dynamic QR codes, editable destinations, scan tracking, and print-safe workflows.
qr-code-size-guide|QR Code Size Guide|Choose practical QR code sizes for screens, menus, flyers, posters, signs, and distance scanning.
qr-code-best-practices|QR Code Best Practices|Improve QR scan reliability with contrast, quiet zones, sizing, testing, and placement.
link-tracking-guide|Link Tracking Guide|Learn how tracked links capture click data and how to structure campaigns for useful reporting.
click-tracking-guide|Click Tracking Guide|Understand click tracking, bot filtering, unique visitors, and common attribution mistakes.
link-analytics-guide|Link Analytics Guide|Read link performance using clicks, unique visitors, referrers, geography, devices, and timing.
campaign-url-builder-guide|Campaign URL Builder Guide|Build campaign URLs with consistent UTM tags before shortening and sharing them.
url-redirect-guide|URL Redirect Guide|Understand redirects, destination changes, and how short links use redirects to stay editable.
301-vs-302-redirect|301 vs 302 Redirect|Learn the practical difference between permanent and temporary redirects and where short links fit.
short-link-security|Short Link Security Guide|Reduce phishing and malware risk with destination validation, branded domains, reporting, and link monitoring.
phishing-safe-short-links|How to Make Short Links Safer|Use branded domains, visible destinations, abuse controls, and verification to reduce short-link risk.
link-preview-bots|Link Preview Bots Explained|Understand why Slack, Facebook, X, Discord, and messaging apps fetch links before a person clicks.
short-links-for-sms|Short Links for SMS|Use concise links in text messages while preserving analytics and destination flexibility.
short-links-for-social-media|Short Links for Social Media|Use trackable short URLs across posts, bios, comments, and campaigns without losing attribution.
qr-codes-for-marketing|QR Codes for Marketing|Plan measurable QR campaigns across print, events, packaging, signage, and offline media.
qr-codes-for-business|QR Codes for Business|Use QR codes for menus, reviews, bookings, offers, resources, and customer journeys.
trackable-qr-codes|Trackable QR Codes|Create QR codes that report scans and keep working when the destination changes.
link-management-guide|Link Management Guide|Organize, name, tag, edit, and monitor growing libraries of short links.
how-to-track-affiliate-links|How to Track Affiliate Links|Give partners and placements distinct URLs so affiliate traffic can be measured cleanly.
how-to-track-influencer-links|How to Track Influencer Links|Create creator-specific links and compare influencer traffic by platform, post, and campaign.
`),
  ...rows('alternative', `
tinyurl-alternative|TinyURL Alternative|Compare basic shortening with editable destinations, analytics, campaigns, and branded domains.
rebrandly-alternative|Rebrandly Alternative|Compare branded-link workflows, analytics, custom domains, and pricing priorities.
short-io-alternative|Short.io Alternative|Compare short-link management, branded domains, routing, analytics, and plan limits for small teams.
dub-alternative|Dub Alternative|Compare modern link analytics, campaigns, custom domains, and developer workflows.
bl-ink-alternative|BL.INK Alternative|Compare link management, analytics, branded domains, and campaign workflows for growing teams.
t2m-alternative|T2M Alternative|Compare URL shortening, QR codes, analytics, and custom-domain workflows.
cuttly-alternative|Cuttly Alternative|Compare short-link creation, analytics, custom aliases, and branded-domain options.
tiny-cc-alternative|Tiny.cc Alternative|Compare custom short links, analytics, editable destinations, and branded domains.
shorturl-at-alternative|ShortURL Alternative|Compare basic URL shortening with a dashboard for analytics, campaigns, QR codes, and destination editing.
switchy-alternative|Switchy Alternative|Compare link management, retargeting-oriented workflows, branded domains, and analytics priorities.
linkly-alternative|Linkly Alternative|Compare link tracking, smart routing, custom domains, analytics, and campaign management.
rocketlink-alternative|RocketLink Alternative|Compare branded links, analytics, routing, and campaign workflows without assuming one tool fits every use case.
sniply-alternative|Sniply Alternative|Compare short-link tracking and campaign measurement with tools built around overlay and CTA workflows.
pixelme-alternative|PixelMe Alternative|Compare link tracking, branded URLs, campaign analytics, and advertising-oriented link workflows.
free-bitly-alternative|Free Bitly Alternative|Evaluate a free link-tracking plan with analytics and a clear path to branded domains and higher volume.
bitly-vs-ashrt-link|Bitly vs ashrt.link|Compare plan structure, analytics access, branded links, QR workflows, and small-team tradeoffs.
`),
]

export const SEO_HUBS = [
  { type: 'hub', slug: 'features', title: 'Link Tracking Features', angle: 'Explore URL shortening, analytics, branded links, QR codes, smart routing, monitoring, and API features.' },
  { type: 'hub', slug: 'solutions', title: 'Link Tracking Solutions', angle: 'See practical link-tracking workflows by channel, team, industry, and campaign.' },
  { type: 'hub', slug: 'guides', title: 'Link Tracking Guides', angle: 'Learn URL shortening, click tracking, UTMs, QR codes, redirects, analytics, and safety.' },
  { type: 'hub', slug: 'alternatives', title: 'URL Shortener Alternatives', angle: 'Compare popular short-link tools against the workflows and limits that matter to small teams.' },
]

export const ALL_SEO_TOPICS = [...SEO_HUBS, ...SEO_TOPICS]
