import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual, createHmac } from 'node:crypto'

function key(value) {
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw Object.assign(new Error('Notification encryption requires deployment configuration.'), { statusCode: 503 })
  return Buffer.from(value, 'hex')
}
export function protect(value, secret, context) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv)
  cipher.setAAD(Buffer.from(context))
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.')
}
export function unprotect(value, secret, context) {
  const [iv, tag, encrypted] = value.split('.').map(part => Buffer.from(part, 'base64url'))
  const cipher = createDecipheriv('aes-256-gcm', key(secret), iv)
  cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(tag)
  return JSON.parse(Buffer.concat([cipher.update(encrypted), cipher.final()]).toString())
}
export function fingerprint(value) { return createHash('sha256').update(value).digest('hex') }
export function validSignature(raw, signature, secret) {
  if (!secret || !/^sha256=[a-f0-9]{64}$/.test(signature ?? '')) return false
  const expected = createHmac('sha256', secret).update(raw).digest()
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))
}
export function safeEqual(first, second) {
  const a = Buffer.from(first ?? ''), b = Buffer.from(second ?? '')
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b)
}

// Provider domains only: browser-provided endpoints must never become arbitrary SSRF targets.
export function allowedPushEndpoint(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'].includes(url.hostname)
        || url.hostname.endsWith('.notify.windows.com'))
  } catch { return false }
}
