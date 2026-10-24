import { getBusinessClock, getBusinessDate } from '../utils/businessDay.js'
import { addDays, reminderInstant } from '../services/collectionCalculations.js'

export function nextAllowedTime(now, settings) {
  const clock = getBusinessClock(now), { quietStart: start, quietEnd: end } = settings
  if (!start || !end || start === end) return now
  const quiet = start < end ? clock >= start && clock < end : clock >= start || clock < end
  if (!quiet) return now
  const date = start > end && clock >= start ? addDays(getBusinessDate(now), 1) : getBusinessDate(now)
  return new Date(`${date}T${end}:00+05:00`)
}
export function eligibleOccurrence(occurrence, state, now) {
  return ['due', 'overdue', 'partial'].includes(state.status)
    && reminderInstant(occurrence) <= now
    // Catch up in-app history indefinitely, but never flood phones with old reminders.
    && occurrence.scheduledDate >= addDays(getBusinessDate(now), -1)
}
export function failurePolicy(error, attempts, now) {
  const code = Number(error.statusCode ?? error.status)
  if (code === 404 || code === 410) return { status: 'failed', safeErrorCode: 'recipient_expired' }
  if (code === 429 || code >= 500) {
    if (attempts >= 5) return { status: 'failed', safeErrorCode: 'retry_exhausted' }
    const seconds = Math.min(86400, Math.max(60 * 2 ** (attempts - 1), Number(error.retryAfter ?? error.headers?.['retry-after']) || 0))
    return { status: 'retry', nextAttemptAt: new Date(now.getTime() + seconds * 1000), safeErrorCode: code === 429 ? 'provider_rate_limited' : 'provider_unavailable' }
  }
  if (code >= 400) return { status: 'failed', safeErrorCode: 'provider_rejected' }
  // Timeout, dropped connection, or crash may follow acceptance: do not resend blindly.
  return { status: 'uncertain', safeErrorCode: 'acknowledgment_unknown' }
}
