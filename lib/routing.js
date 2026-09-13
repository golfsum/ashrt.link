/**
 * One link, several destinations.
 *
 * A rule sends US visitors to the US store and everyone else to the default, or
 * iPhones to the App Store and Android phones to Play. The important property is
 * that this costs nothing at redirect time: the rules live inside the link
 * record the redirect has already fetched, so evaluating them is a loop over a
 * short array, not another round-trip.
 *
 * Design rules that keep this safe and predictable:
 *
 *   - There is always a default. A rule set that matches nothing must still
 *     produce the destination the link was created with, so a link can never
 *     become a dead end by being configured.
 *   - First match wins, in the order the owner arranged them. No scoring, no
 *     specificity ranking: if two rules could both match, the one listed first
 *     is the answer, and that is legible from the list itself.
 *   - Every rule destination is validated exactly like the main one, when it is
 *     saved and again when it is served. A rule editor that skipped that check
 *     would be an open redirect with a nice form in front of it.
 */

export const RULE_TYPES = {
  country: {
    label: 'Country',
    // Two-letter ISO codes, which is what the CDN header gives us.
    //
    // Deliberately no truncation. Cutting "UNITED STATES" down to "UN" would
    // pass the check below and route real traffic to a country the person never
    // chose; a wrong value has to be rejected, not quietly reshaped.
    normalize: (v) => String(v || '').trim().toUpperCase(),
    valid: (v) => /^[A-Z]{2}$/.test(v),
    from: (ctx) => String(ctx?.country || '').toUpperCase(),
  },
  device: {
    label: 'Device',
    normalize: (v) => String(v || '').trim().toLowerCase(),
    valid: (v) => ['mobile', 'desktop', 'tablet'].includes(v),
    from: (ctx) => String(ctx?.device || '').toLowerCase(),
  },
  os: {
    label: 'Operating system',
    // Matched case-insensitively against what the click context records:
    // iOS, Android, Windows, macOS, Linux, ChromeOS.
    normalize: (v) => String(v || '').trim().toLowerCase(),
    valid: (v) => ['ios', 'android', 'windows', 'macos', 'linux', 'chromeos'].includes(v),
    from: (ctx) => String(ctx?.os || '').toLowerCase(),
  },
}

/** Per link. Enough for "one rule per market" without letting a record bloat. */
export const MAX_RULES = 20

/** Values per rule, so one rule can cover several countries. */
export const MAX_VALUES = 40

/**
 * Clean a rule set coming from a client.
 *
 * Returns the rules that are well formed and a list of what was rejected, so the
 * caller can refuse the request rather than silently saving something different
 * from what was sent. Destination validation happens in the caller, which is
 * where the blocklist lives.
 */
export function sanitizeRules(input) {
  const errors = []
  if (input === null || input === undefined) return { rules: [], errors }
  if (!Array.isArray(input)) return { rules: [], errors: ['Rules must be a list.'] }
  if (input.length > MAX_RULES) errors.push(`A link can have at most ${MAX_RULES} rules.`)

  const rules = []
  for (const [i, raw] of input.slice(0, MAX_RULES).entries()) {
    const spec = RULE_TYPES[raw?.type]
    if (!spec) {
      errors.push(`Rule ${i + 1}: unknown condition "${raw?.type}".`)
      continue
    }

    const values = [...new Set((Array.isArray(raw.values) ? raw.values : [raw.values]).map(spec.normalize))]
      .filter(Boolean)
      .slice(0, MAX_VALUES)

    const bad = values.filter((v) => !spec.valid(v))
    if (bad.length) {
      errors.push(`Rule ${i + 1}: ${bad.join(', ')} is not a valid ${spec.label.toLowerCase()}.`)
      continue
    }
    if (!values.length) {
      errors.push(`Rule ${i + 1}: pick at least one ${spec.label.toLowerCase()}.`)
      continue
    }
    if (!raw.url) {
      errors.push(`Rule ${i + 1}: needs a destination.`)
      continue
    }

    rules.push({
      id: String(raw.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || newRuleId(),
      type: raw.type,
      values,
      url: String(raw.url),
    })
  }

  return { rules, errors }
}

let counter = 0
const newRuleId = () => `r${Date.now().toString(36)}${(counter++).toString(36)}`

/**
 * Where should this visitor go?
 *
 * @returns {{url: string, rule: object|null}} the destination and the rule that
 *          chose it, or null when the link's own destination was used.
 */
export function resolveDestination(link, ctx) {
  const rules = Array.isArray(link?.rules) ? link.rules : []
  for (const rule of rules) {
    const spec = RULE_TYPES[rule?.type]
    if (!spec) continue
    const actual = spec.from(ctx)
    if (actual && rule.values.includes(actual)) return { url: rule.url, rule }
  }
  return { url: link?.url, rule: null }
}

/** A short human label for a rule, for analytics rows and the audit log. */
export function ruleLabel(rule) {
  const spec = RULE_TYPES[rule?.type]
  if (!spec) return 'Unknown rule'
  return `${spec.label}: ${rule.values.join(', ')}`
}
