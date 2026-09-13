const $ = (id) => document.getElementById(id)

// Prefill from ?link= so the "Report this link" buttons on our own error and
// interstitial pages land here with the code already filled in.
const preset = new URLSearchParams(location.search).get('link')
if (preset) $('link').value = preset

$('form').addEventListener('submit', async (e) => {
  e.preventDefault()
  $('err').textContent = ''

  const link = $('link').value.trim()
  if (!link) {
    $('err').textContent = 'Which link are you reporting?'
    return
  }

  $('submit').disabled = true
  $('submit').textContent = 'Sending...'
  try {
    const res = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        link,
        reason: $('reason').value,
        detail: $('detail').value.trim(),
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      $('err').textContent = data.error || 'Could not submit that report'
      return
    }
    $('form').hidden = true
    $('done').hidden = false
  } catch {
    $('err').textContent = 'Network error. Try again.'
  } finally {
    $('submit').disabled = false
    $('submit').textContent = 'Submit report'
  }
})
