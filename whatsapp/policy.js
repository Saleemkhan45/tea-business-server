import { reminderConfig } from '../reminders/config.js'

export function whatsappConfig(source = process.env) {
  return { ...reminderConfig(source), customerEnabled: source.WHATSAPP_CUSTOMER_ENABLED === 'true',
    retentionEnabled: source.WHATSAPP_RETENTION_ENABLED === 'true',
    customerShop: source.WHATSAPP_CUSTOMER_SHOP_ID ?? '', senderNumber: source.WHATSAPP_SENDER_NUMBER ?? '',
    customerTemplate: source.WHATSAPP_CUSTOMER_TEMPLATE ?? '',
    retentionDays: Math.min(365, Math.max(30, Number(source.WHATSAPP_MESSAGE_RETENTION_DAYS) || 90)) }
}
export function normalizePhone(value) {
  if (typeof value !== 'string' || !/^[+\d\s().-]+$/.test(value)) throw Object.assign(new Error('Enter a valid Pakistan or international WhatsApp number.'), { statusCode: 400 })
  let phone = value.replace(/[\s().-]/g, '')
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`
  if (/^03\d{9}$/.test(phone)) phone = `+92${phone.slice(1)}`
  else if (/^3\d{9}$/.test(phone)) phone = `+92${phone}`
  else if (/^92\d{10}$/.test(phone)) phone = `+${phone}`
  if (!/^\+[1-9]\d{7,14}$/.test(phone) || (phone.startsWith('+92') && !/^\+92\d{10}$/.test(phone))) {
    throw Object.assign(new Error('Use E.164 international format, for example +923001234567.'), { statusCode: 400 })
  }
  return phone
}
export function serviceWindowOpen(lastInboundAt, now = new Date()) {
  const stamp = new Date(lastInboundAt ?? 0).getTime()
  return Number.isFinite(stamp) && stamp <= now.getTime() && now.getTime() < stamp + 86400000
}
export function isOptOut(text) {
  return /^(stop|unsubscribe|opt[ -]?out|band|بند)$/iu.test(text.trim())
}
export function inboundText(message) {
  const value = message.type === 'text' ? message.text?.body : message.type === 'button' ? message.button?.text
    : message.type === 'interactive' ? (message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title) : null
  return typeof value === 'string' ? value.slice(0, 4096) : null
}
export function templateParameters(name, amount) {
  if (typeof name !== 'string' || !name.trim() || !Number.isSafeInteger(amount) || amount <= 0) throw new Error('Invalid reminder template parameters.')
  return [name.replace(/[\r\n\t\x00-\x1f]/g, ' ').trim().slice(0, 160), String(amount)]
}
