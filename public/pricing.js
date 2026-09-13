/**
 * The pricing page renders from the server's own entitlements.
 *
 * Every number here is the number the API enforces, read from /api/plans at
 * load: the cards, the comparison table and the "in every plan" list are all
 * derived from the same catalogue the server gates requests with. A
 * hand-written pricing table drifts from the code within a month, and then the
 * page is quietly lying about what somebody is buying.
 */

const $ = (id) => document.getElementById(id)

async function render() {
  const [data, user] = await Promise.all([Plans.load(), Plans.whoami()])
  const opts = { user, interval: Plans.interval, data }

  $('plans').innerHTML =
    Plans.toggleHtml(data) +
    `<div class="price-grid">${data.plans.map((p) => Plans.card(p, opts)).join('')}</div>` +
    `<p class="price-error" data-plan-error></p>`

  $('universal').innerHTML = (data.universal || [])
    .map((label) => `<li>${Plans.esc(label)}</li>`)
    .join('')

  $('matrix').innerHTML = `
    <table class="compare">
      <thead>
        <tr>
          <th scope="col">Feature</th>
          ${data.plans.map((p) => `<th scope="col">${Plans.esc(p.label)}</th>`).join('')}
        </tr>
      </thead>
      ${data.matrix
        .map(
          (group) => `<tbody>
            <tr class="compare-group"><th scope="rowgroup" colspan="${data.plans.length + 1}">${Plans.esc(group.group)}</th></tr>
            ${group.rows
              .map(
                (row) => `<tr>
                  <th scope="row">${Plans.esc(row.label)}</th>
                  ${data.plans
                    .map((p) => {
                      const v = row.values[p.id]
                      const off = v === 'Not included' || v === 'None'
                      return `<td class="${off ? 'compare-off' : ''}">${
                        v === 'Included' ? '<span aria-label="Included">✓</span>' : Plans.esc(v)
                      }</td>`
                    })
                    .join('')}
                </tr>`,
              )
              .join('')}
          </tbody>`,
        )
        .join('')}
    </table>`

  Plans.wire(document.body)
}

document.addEventListener('plans:interval', render)

render().catch(() => {
  $('plans').innerHTML =
    '<p class="chart-empty">Could not load the plans just now. Reload, or see them on the <a href="/account">account page</a>.</p>'
})

/** The same nav the other public pages use. */
async function nav() {
  const user = await Plans.whoami()
  $('nav').innerHTML = user
    ? '<a href="/dashboard">Dashboard</a><a href="/account">Account</a>'
    : '<a href="/login">Log in</a><a class="btn btn-sm" href="/signup">Get started</a>'
}

nav()
