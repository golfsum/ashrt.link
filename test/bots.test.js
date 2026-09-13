import test from 'node:test'
import assert from 'node:assert/strict'
import { classify, isBot } from '../lib/bots.js'

const REAL_BROWSERS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
]

const PREVIEW_BOTS = {
  'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)': 'Slack',
  'Twitterbot/1.0': 'Twitter',
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)': 'Facebook',
  'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)': 'Discord',
  'WhatsApp/2.23.20.0': 'WhatsApp',
  'LinkedInBot/1.0 (compatible; Mozilla/5.0)': 'LinkedIn',
  'TelegramBot (like TwitterBot)': 'Telegram',
}

test('real browsers are not flagged as bots', () => {
  for (const ua of REAL_BROWSERS) {
    assert.equal(isBot(ua), false, `should be human: ${ua.slice(0, 40)}`)
  }
})

test('link-preview fetchers are identified by name', () => {
  for (const [ua, name] of Object.entries(PREVIEW_BOTS)) {
    const r = classify(ua)
    assert.equal(r.isBot, true, `should be a bot: ${ua.slice(0, 40)}`)
    assert.equal(r.name, name)
    assert.equal(r.category, 'preview')
  }
})

test('search and AI crawlers are identified', () => {
  assert.equal(classify('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)').category, 'crawler')
  assert.equal(classify('Mozilla/5.0 (compatible; bingbot/2.0)').category, 'crawler')
  assert.equal(classify('Mozilla/5.0 (compatible; GPTBot/1.0)').category, 'ai')
  assert.equal(classify('Mozilla/5.0 (compatible; ClaudeBot/1.0)').category, 'ai')
  assert.equal(classify('Mozilla/5.0 (compatible; AhrefsBot/7.0)').category, 'crawler')
})

test('scripts and HTTP clients are bots', () => {
  for (const ua of ['curl/8.4.0', 'Wget/1.21.3', 'python-requests/2.31.0', 'PostmanRuntime/7.36.0', 'Go-http-client/2.0', 'axios/1.6.2']) {
    assert.equal(isBot(ua), true, `should be a bot: ${ua}`)
  }
})

test('monitors and scanners are bots', () => {
  assert.equal(classify('Mozilla/5.0+(compatible; UptimeRobot/2.0)').category, 'monitor')
  assert.equal(classify('Mozilla/5.0 (compatible; HeadlessChrome/120)').category, 'headless')
})

test('an empty user-agent is treated as automated', () => {
  assert.equal(isBot(''), true)
  assert.equal(isBot(undefined), true)
})
