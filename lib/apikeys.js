/**
 * API keys: several per account, named, scoped, revocable.
 *
 * The old model was one key per account, rotated in place. That is fine until
 * the key is in three places and rotating it breaks two of them, and until a
 * script that only needs to read stats is holding a key that can delete every
 * link.
 *
 * What is stored is a hash, never the key. The plaintext is shown once, at
 * creation, and is not recoverable afterwards — including by us. A prefix is
 * kept so a key can be recognised in a list without being able to be used.
 *
 * Accounts created before this keep working: their single key is presented as a
 * key named "Default" with full scopes, and nothing has to be migrated for it
 * to keep authenticating.
 */

import crypto from 'node:crypto'

/**
 * Scopes, narrowest first.
 *
 * Deliberately few. A scope nobody understands gets granted "just in case",
 * which is the same as having no scopes at all.
 */
export const SCOPES = {
  'links:read': 'Read links and their settings',
  'links:write': 'Create, update and delete links',
  'analytics:read': 'Read click statistics',
  'qr:read': 'Generate QR codes',
}

export const ALL_SCOPES = Object.keys(SCOPES)

/** What a key gets when nothing is chosen, and what legacy keys carry. */
export const DEFAULT_SCOPES = [...ALL_SCOPES]

export const MAX_KEYS = 10

/** `ask_` so a leaked key is recognisable in a log or a repository scan. */
export function newApiKey() {
  return 'ask_' + crypto.randomBytes(24).toString('base64url')
}

export function hashApiKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex')
}

/** Enough of the key to recognise it, not enough to use it. */
export const keyPrefix = (key) => String(key).slice(0, 11) + '…'

export function sanitizeScopes(input) {
  const asked = Array.isArray(input) ? input : DEFAULT_SCOPES
  const clean = asked.filter((s) => ALL_SCOPES.includes(s))
  return clean.length ? [...new Set(clean)] : [...DEFAULT_SCOPES]
}

/**
 * Every key on an account, including a pre-existing single key.
 *
 * The legacy key is presented rather than migrated, so reading this never has
 * to write, and an account that is never touched again keeps working forever.
 */
export function keysOf(user) {
  const keys = Array.isArray(user?.apiKeys) ? [...user.apiKeys] : []
  const legacyHash = user?.apiKeyHash || (user?.apiKey ? hashApiKey(user.apiKey) : null)
  if (legacyHash && !keys.some((k) => k.hash === legacyHash)) {
    keys.push({
      id: 'legacy',
      name: 'Default',
      hash: legacyHash,
      prefix: user.apiKey ? keyPrefix(user.apiKey) : 'ask_…',
      scopes: [...DEFAULT_SCOPES],
      createdAt: user.apiKeyCreatedAt || user.createdAt || null,
      lastUsedAt: user.apiKeyLastUsedAt || null,
      legacy: true,
    })
  }
  return keys
}

/** Public view: metadata only. The key itself is never in here. */
export const publicKey = (k) => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  scopes: k.scopes,
  createdAt: k.createdAt || null,
  lastUsedAt: k.lastUsedAt || null,
  legacy: Boolean(k.legacy),
})

/** Which key on this account a presented secret belongs to, if any. */
export function matchKey(user, key) {
  const hash = hashApiKey(key)
  return keysOf(user).find((k) => k.hash === hash) || null
}

/**
 * Does this key allow this operation?
 *
 * A key with no scopes recorded is a legacy key and has all of them: an
 * upgrade must not silently revoke access that already worked.
 */
export function keyAllows(key, scope) {
  if (!key) return false
  const scopes = Array.isArray(key.scopes) && key.scopes.length ? key.scopes : DEFAULT_SCOPES
  return scopes.includes(scope)
}
