import crypto from 'node:crypto'

const SECRET = process.env.EMAIL_VERIFY_SECRET || process.env.SESSION_SECRET || process.env.API_KEY || 'ashrt-dev-verify-secret'
const BASE_URL = (process.env.BASE_URL || 'https://www.ashrt.link').replace(/\/$/, '')
const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const EMAIL_FROM = process.env.EMAIL_FROM || ''
const VERIFY_TTL_MS = 2 * 60 * 60 * 1000

const sign = (value) => crypto.createHmac('sha256', SECRET).update(value).digest('base64url')

export function isEmailVerified(user) {
  if (!user) return false
  if (user.role === 'admin') return true
  if (user.emailVerified === true) return true
  if (user.provider === 'google' || user.provider === 'github') return true
  if (Array.isArray(user.oauth) && user.oauth.length > 0) return true
  return false
}

export function makeVerificationToken(user, { ttlMs = VERIFY_TTL_MS } = {}) {
  const payload = Buffer.from(
    JSON.stringify({ uid: user.id, email: String(user.email || '').toLowerCase(), exp: Date.now() + ttlMs }),
  ).toString('base64url')
  return `${payload}.${sign(payload)}`
}

export function readVerificationToken(token) {
  if (!token || !String(token).includes('.')) return null
  const [payload, signature] = String(token).split('.')
  const expected = sign(payload)
  if (!signature || signature.length !== expected.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString())
    if (!data.uid || !data.email || !data.exp || Date.now() > data.exp) return null
    return data
  } catch {
    return null
  }
}

export function emailVerificationConfigured() {
  return Boolean(RESEND_API_KEY && EMAIL_FROM)
}

export async function sendVerificationEmail(user) {
  if (!emailVerificationConfigured()) throw new Error('Verification email is not configured')
  const token = makeVerificationToken(user)
  const verifyUrl = `${BASE_URL}/auth/verify-email?token=${encodeURIComponent(token)}`
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [user.email],
      subject: 'Verify your email for ashrt.link',
      text: `Verify your ashrt.link email address by opening this link:\n\n${verifyUrl}\n\nThis link expires in 2 hours. If you did not create this account, you can ignore this email.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#111827"><h2>Verify your email</h2><p>Confirm this email address before creating permanent links on ashrt.link.</p><p><a href="${verifyUrl}" style="display:inline-block;background:#6366f1;color:white;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700">Verify email</a></p><p style="color:#6b7280;font-size:13px">This link expires in 2 hours. If you did not create this account, you can ignore this email.</p></div>`,
    }),
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) {
    let detail = ''
    try {
      detail = (await response.text()).slice(0, 300)
    } catch {}
    throw new Error(`Verification email failed (${response.status})${detail ? `: ${detail}` : ''}`)
  }
  return true
}

export const VERIFICATION_TTL_MS = VERIFY_TTL_MS
