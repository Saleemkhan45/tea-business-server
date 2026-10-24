export const BUSINESS_TIME_ZONE = 'Asia/Karachi'
export const BUSINESS_UTC_OFFSET = '+05:00'

function getParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)

  return Object.fromEntries(parts.map(part => [part.type, part.value]))
}

export function getBusinessDate(date = new Date()) {
  const parts = getParts(date)
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function getBusinessClock(date = new Date()) {
  const parts = getParts(date)
  return `${parts.hour}:${parts.minute}`
}

export function getBusinessDayRange(businessDate = getBusinessDate()) {
  const start = new Date(`${businessDate}T00:00:00${BUSINESS_UTC_OFFSET}`)
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 1)
  return { start, end }
}

export function previousBusinessDate(businessDate = getBusinessDate()) {
  const date = new Date(`${businessDate}T00:00:00${BUSINESS_UTC_OFFSET}`)
  date.setUTCDate(date.getUTCDate() - 1)
  return getBusinessDate(date)
}

export function daysBetweenBusinessDates(fromDate, toDate = getBusinessDate()) {
  if (!fromDate) return null
  const start = new Date(`${fromDate}T00:00:00${BUSINESS_UTC_OFFSET}`)
  const end = new Date(`${toDate}T00:00:00${BUSINESS_UTC_OFFSET}`)
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 86400000))
}
