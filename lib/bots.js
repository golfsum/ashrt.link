/**
 * Bot and crawler identification for the redirect path.
 *
 * Why this matters more here than on a normal site: the whole product promise
 * is an accurate click count. Post a link in Slack and Slackbot fetches it to
 * build the preview; post it on Twitter/X, Discord, LinkedIn, iMessage and each
 * does the same. Without this, a link shared once in a busy channel reports a
 * handful of "visitors" nobody made.
 *
 * We classify rather than block. Bot hits are recorded in their own counters so
 * the admin view can show them and user analytics can leave them out.
 */

/**
 * Ordered: the first match wins, so put specific names above generic patterns.
 * @type {Array<[RegExp, string, string]>}
 */
const SIGNATURES = [
  // Link-preview fetchers: the biggest source of phantom clicks.
  [/slackbot|slack-imgproxy/i, 'Slack', 'preview'],
  // Telegram must be tested before Twitter: its real user-agent is
  // "TelegramBot (like TwitterBot)", so the looser pattern would claim it and
  // the analytics would report Telegram traffic as Twitter.
  [/telegrambot/i, 'Telegram', 'preview'],
  [/twitterbot/i, 'Twitter', 'preview'],
  [/facebookexternalhit|facebookcatalog|meta-externalagent/i, 'Facebook', 'preview'],
  [/discordbot/i, 'Discord', 'preview'],
  [/whatsapp/i, 'WhatsApp', 'preview'],
  [/linkedinbot/i, 'LinkedIn', 'preview'],
  [/pinterest(bot)?/i, 'Pinterest', 'preview'],
  [/redditbot/i, 'Reddit', 'preview'],
  [/skypeuripreview/i, 'Skype', 'preview'],
  [/embedly|iframely|quora link preview|outbrain|nuzzel/i, 'Embed preview', 'preview'],
  [/vkshare|tumblr|flipboard/i, 'Social preview', 'preview'],
  [/applebot|apple-imessage/i, 'Apple', 'preview'],

  // AI / dataset crawlers.
  [/gptbot|oai-searchbot|chatgpt-user/i, 'GPTBot', 'ai'],
  [/claudebot|claude-web|anthropic-ai/i, 'ClaudeBot', 'ai'],
  [/perplexitybot/i, 'PerplexityBot', 'ai'],
  [/ccbot/i, 'CCBot', 'ai'],
  [/bytespider/i, 'Bytespider', 'ai'],
  [/google-extended|googleother/i, 'Google-Extended', 'ai'],
  [/amazonbot|meta-externalfetcher/i, 'AI crawler', 'ai'],

  // Search engines.
  [/googlebot|google-inspectiontool|apis-google|adsbot-google|mediapartners-google/i, 'Googlebot', 'crawler'],
  [/bingbot|adidxbot|msnbot/i, 'Bingbot', 'crawler'],
  [/duckduckbot|duckduckgo/i, 'DuckDuckBot', 'crawler'],
  [/yandex(bot|images)/i, 'YandexBot', 'crawler'],
  [/baiduspider/i, 'Baiduspider', 'crawler'],
  [/slurp/i, 'Yahoo Slurp', 'crawler'],

  // SEO and backlink crawlers.
  [/ahrefsbot/i, 'AhrefsBot', 'crawler'],
  [/semrushbot/i, 'SemrushBot', 'crawler'],
  [/mj12bot|majestic/i, 'MJ12bot', 'crawler'],
  [/dotbot|opensiteexplorer|rogerbot/i, 'DotBot', 'crawler'],
  [/screaming frog/i, 'Screaming Frog', 'crawler'],
  [/serpstatbot|dataforseo|seokicks|blexbot/i, 'SEO crawler', 'crawler'],

  // Uptime and monitoring.
  [/uptimerobot/i, 'UptimeRobot', 'monitor'],
  [/pingdom/i, 'Pingdom', 'monitor'],
  [/statuscake/i, 'StatusCake', 'monitor'],
  [/site24x7|newrelicpinger|datadog|betteruptime|checkly|hetrixtools/i, 'Monitor', 'monitor'],

  // Security scanners and safety checks.
  [/cloudflare-(traffic|ssldetector|alwaysonline)|cf-uc/i, 'Cloudflare', 'security'],
  [/qualys|nessus|zgrab|masscan|nmap|nikto|sqlmap|acunetix|netcraft/i, 'Scanner', 'security'],
  [/safebrowsing|virustotal|urlscan|phishtank|barracuda|proofpoint|mimecast|forcepoint/i, 'Safety scanner', 'security'],

  // Headless browsers and automation frameworks.
  [/headlesschrome|phantomjs|puppeteer|playwright|selenium|electron\//i, 'Headless browser', 'headless'],

  // HTTP clients and scripts.
  [/^curl\//i, 'curl', 'tool'],
  [/^wget/i, 'wget', 'tool'],
  [/python-requests|python-urllib|aiohttp|httpx/i, 'Python', 'tool'],
  [/postmanruntime|insomnia|httpie|restsharp/i, 'API client', 'tool'],
  [/axios|node-fetch|got \(|undici/i, 'Node client', 'tool'],
  [/go-http-client/i, 'Go client', 'tool'],
  [/java\/|okhttp|apache-httpclient|jakarta|libwww-perl|lwp::|guzzle|php-curl/i, 'HTTP library', 'tool'],
  [/ruby|faraday|typhoeus/i, 'Ruby client', 'tool'],

  // Feed readers.
  [/feedly|feedburner|inoreader|newsblur|rss|atom/i, 'Feed reader', 'crawler'],

  // Generic catch-all, last so named bots keep their identity.
  [/\b(bot|crawler|spider|scraper|archiver|fetcher|monitor|validator|checker|preview)\b/i, 'Other bot', 'crawler'],
]

/**
 * Classify a user-agent string.
 * @returns {{isBot:boolean,name:string|null,category:string|null}}
 */
export function classify(userAgent) {
  const ua = String(userAgent || '').trim()

  // No user-agent at all is a script, not a person with a browser.
  if (!ua) return { isBot: true, name: 'Unknown client', category: 'tool' }

  for (const [re, name, category] of SIGNATURES) {
    if (re.test(ua)) return { isBot: true, name, category }
  }

  // Real browsers always announce an engine. Anything this short is automated.
  if (ua.length < 20 && !/mozilla/i.test(ua)) {
    return { isBot: true, name: 'Unknown client', category: 'tool' }
  }

  return { isBot: false, name: null, category: null }
}

export function isBot(userAgent) {
  return classify(userAgent).isBot
}

/**
 * Classify a request. Slightly better than the UA alone: a real browser
 * navigation sends an Accept header that asks for HTML.
 */
export function classifyRequest(req) {
  const result = classify(req.get('user-agent'))
  if (result.isBot) return result
  const accept = req.get('accept') || ''
  if (accept && !/text\/html|application\/xhtml|\*\/\*/i.test(accept)) {
    return { isBot: true, name: 'Unknown client', category: 'tool' }
  }
  return result
}

/** Categories whose traffic is a person seeing the destination, eventually. */
export const HUMAN_ADJACENT = new Set(['preview'])
