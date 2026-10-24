const hour = 60 * 60 * 1000
const day = 24 * hour
export function readSessionPolicy(source = process.env) {
  function number(name, fallback, maximum) {
    const value = source[name] === undefined ? fallback : Number(source[name])
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer between 1 and ${maximum}.`)
    return value
  }
  const shortMs = number('SESSION_SHORT_HOURS', 8, 24) * hour
  const slidingMs = number('SESSION_SLIDING_DAYS', 30, 180) * day
  const absoluteMs = number('SESSION_ABSOLUTE_DAYS', 180, 365) * day
  const renewalMs = number('SESSION_RENEWAL_HOURS', 24, 72) * hour
  if (slidingMs > absoluteMs || renewalMs > slidingMs / 2) throw new Error('Session renewal must be at most half the sliding window, and sliding expiry must not exceed absolute expiry.')
  return Object.freeze({ shortMs, slidingMs, absoluteMs, renewalMs })
}
export const sessionPolicy = readSessionPolicy()
