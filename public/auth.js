const $ = (id) => document.getElementById(id)
const isSignup = location.pathname.replace(/\/$/, '').endsWith('/signup')

/**
 * Where to go once the account exists.
 *
 * Somebody who pressed "Choose Pro" on the pricing page asked to buy Pro, not
 * to look at a dashboard and find the button again, so the choice travels with
 * them as ?plan= and the account page picks it up.
 */
function landing() {
  const plan = new URLSearchParams(location.search).get('plan')
  return ['pro', 'business'].includes(plan) ? `/account?upgrade=${plan}` : '/dashboard'
}

// If already signed in, skip the form entirely.
fetch('/auth/me', { cache: 'no-store' }).then((r) => {
  if (r.ok) window.location.href = landing()
})

// Show the OAuth buttons that the server has configured.
fetch('/auth/config')
  .then((r) => r.json())
  .then(({ providers }) => {
    const wrap = $('oauth')
    const btns = []
    if (providers.google) btns.push(oauthBtn('google', 'Continue with Google'))
    if (providers.github) btns.push(oauthBtn('github', 'Continue with GitHub'))
    if (!btns.length) {
      wrap.style.display = 'none'
      $('divider').style.display = 'none'
      return
    }
    wrap.innerHTML = btns.join('')
  })
  .catch(() => {
    $('oauth').style.display = 'none'
    $('divider').style.display = 'none'
  })

function oauthBtn(provider, label) {
  return `<a class="oauth-btn" href="/auth/${provider}">${label}</a>`
}

const ERRORS = {
  oauth: 'Social sign-in failed. Try again.',
  state: 'Your sign-in session expired. Try again.',
  email: 'We could not read an email from that account.',
  verification: 'That verification link is invalid or expired. Log in and request a new one.',
}
const qpError = new URLSearchParams(location.search).get('error')
if (qpError && ERRORS[qpError]) $('err').textContent = ERRORS[qpError]

$('form').addEventListener('submit', async (e) => {
  e.preventDefault()
  $('err').textContent = ''
  const body = {
    email: $('email').value.trim(),
    password: $('password').value,
  }
  if (isSignup) body.name = $('name').value.trim()

  // Guest links stay temporary until the account is verified. The app shell
  // claims them automatically after /auth/me reports a verified account.

  $('submit').disabled = true
  $('submit').textContent = isSignup ? 'Creating...' : 'Logging in...'
  try {
    const res = await fetch(isSignup ? '/auth/register' : '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) {
      $('err').textContent = data.error || 'Something went wrong'
      return
    }
    window.location.href = landing()
  } catch {
    $('err').textContent = 'Network error. Try again.'
  } finally {
    $('submit').disabled = false
    $('submit').textContent = isSignup ? 'Create account' : 'Log in'
  }
})
