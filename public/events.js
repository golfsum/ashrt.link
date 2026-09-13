// Client-side funnel events.
//
// Only the handful of things the server cannot observe: someone starting to
// use the tracker, clicking upgrade, or beginning a signup. Everything else
// (links created, accounts made, checkouts, subscriptions) is counted
// server-side, where it cannot be blocked or dropped.
//
// This sends no identifier of any kind. It posts an event name and nothing
// else; the server attributes it to a coarse referrer bucket and increments a
// daily counter.

window.Track = (function () {
  const sent = new Set()

  function send(event) {
    // Each event fires once per page. "Started using the tracker" is a fact
    // about the visit, not a count of keystrokes.
    if (sent.has(event)) return
    sent.add(event)

    const body = JSON.stringify({ event })
    try {
      // sendBeacon survives the page being navigated away from, which is
      // exactly what happens when someone clicks upgrade.
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/events', new Blob([body], { type: 'application/json' }))
        return
      }
    } catch {
      /* fall through to fetch */
    }
    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {})
  }

  /** Fire once, the first time someone actually engages with an element. */
  function onFirstUse(el, event) {
    if (!el) return
    const fire = () => send(event)
    el.addEventListener('focus', fire, { once: true })
    el.addEventListener('input', fire, { once: true })
  }

  return { send, onFirstUse }
})()

// Wire the standard funnel points if the elements are on this page.
;(() => {
  // The URL box on the homepage, the landing pages and the dashboard.
  window.Track.onFirstUse(document.getElementById('url'), 'tracker_started')
  window.Track.onFirstUse(document.getElementById('quick-url'), 'tracker_started')

  for (const id of ['pro-btn', 'biz-btn']) {
    document.getElementById(id)?.addEventListener('click', () => window.Track.send('upgrade_clicked'))
  }

  // The signup form being started, as distinct from the page being viewed.
  const form = document.getElementById('form')
  if (form && location.pathname.replace(/\/$/, '').endsWith('/signup')) {
    window.Track.onFirstUse(document.getElementById('email'), 'signup_started')
  }
})()
