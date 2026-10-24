import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const derive = promisify(scrypt)
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw new TypeError('Password must contain between 12 and 256 characters.')
  }
  const salt = randomBytes(16).toString('hex')
  const hash = await derive(password, salt, 64, options)
  return `scrypt$32768$8$3$${salt}$${hash.toString('hex')}`
}

export async function verifyPassword(password, storedHash) {
  const parts = typeof storedHash === 'string' ? storedHash.split('$') : []
  const valid = parts.length === 6 && parts.slice(0, 4).join('$') === 'scrypt$32768$8$3'
    && /^[a-f0-9]{32}$/.test(parts[4]) && /^[a-f0-9]{128}$/.test(parts[5])
  const salt = valid ? parts[4] : '0'.repeat(32)
  const expected = Buffer.from(valid ? parts[5] : '0'.repeat(128), 'hex')
  const actual = await derive(password, salt, 64, options)
  return timingSafeEqual(actual, expected) && valid
}
