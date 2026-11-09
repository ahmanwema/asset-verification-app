/**
 * Password hashing and token minting, shared by the on-site SQLite server and
 * the Vercel serverless functions so both accept exactly the same credentials.
 *
 * Two hashes are stored per user on purpose:
 *   - `scrypt` is what the server itself issues when it seeds or sets a password.
 *   - `sha256` is the unlock hash the PWA computes offline and pushes up with
 *     the inspector record, so an account created in the field on a phone can
 *     sign in to the server without anyone retyping the password.
 *
 * scrypt is preferred whenever it is present; the SHA-256 path is a fallback
 * for those field-created accounts and is no stronger than the client that
 * produced it.
 */
import crypto from 'node:crypto'

export function scryptHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${derived}`
}

export function scryptVerify(password, stored) {
  const [salt, expected] = String(stored || '').split(':')
  if (!salt || !expected) return false
  const actual = crypto.scryptSync(password, salt, 64).toString('hex')
  const a = Buffer.from(actual, 'hex')
  const b = Buffer.from(expected, 'hex')
  // Length check first: timingSafeEqual throws on a mismatch rather than returning false.
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/** Verifies a password against a user row holding either or both hashes. */
export function verifyPassword(password, user) {
  if (!user) return false
  if (user.scrypt) return scryptVerify(password, user.scrypt)
  return Boolean(user.sha256) && user.sha256 === sha256(password)
}

export function newToken() {
  return crypto.randomBytes(32).toString('hex')
}

export function newId(prefix = '') {
  return `${prefix}${crypto.randomUUID()}`
}

export function newUserId() {
  return newId('usr_')
}
