export function formatPkr(amount) {
  return `PKR ${Number(amount || 0).toLocaleString('en-PK')}`
}

export function formatCompactPkr(amount) {
  const value = Number(amount || 0)
  if (Math.abs(value) >= 1000000) return `PKR ${(value / 1000000).toFixed(value % 1000000 === 0 ? 0 : 1)}M`
  if (Math.abs(value) >= 1000) return `PKR ${Math.round(value / 1000)}K`
  return formatPkr(value)
}

export function sanitizePhoneForWhatsApp(phone = '') {
  const digits = String(phone).replace(/\D/g, '')
  if (digits.startsWith('0')) return `92${digits.slice(1)}`
  return digits
}

export function createWhatsAppUrl(phone, message) {
  const cleanPhone = sanitizePhoneForWhatsApp(phone)
  const encoded = encodeURIComponent(message)
  return cleanPhone ? `https://wa.me/${cleanPhone}?text=${encoded}` : `https://wa.me/?text=${encoded}`
}
