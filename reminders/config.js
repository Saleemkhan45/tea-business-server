// Read lazily: disabled by default, with no provider activity at module import.
export function reminderConfig(source = process.env) {
  return {
    live: source.REMINDER_DELIVERY_MODE === 'live',
    encryptionKey: source.REMINDER_ENCRYPTION_KEY ?? '',
    vapidPublic: source.VAPID_PUBLIC_KEY ?? '', vapidPrivate: source.VAPID_PRIVATE_KEY ?? '',
    vapidSubject: source.VAPID_SUBJECT ?? '',
    whatsappToken: source.WHATSAPP_ACCESS_TOKEN ?? '', phoneId: source.WHATSAPP_PHONE_NUMBER_ID ?? '',
    businessId: source.WHATSAPP_BUSINESS_ACCOUNT_ID ?? '', version: source.WHATSAPP_API_VERSION ?? '',
    template: source.WHATSAPP_OPERATOR_TEMPLATE ?? '', language: source.WHATSAPP_TEMPLATE_LANGUAGE ?? 'en',
    appSecret: source.WHATSAPP_APP_SECRET ?? '', verifyToken: source.WHATSAPP_VERIFY_TOKEN ?? '',
    approvedRecipients: source.WHATSAPP_APPROVED_OPERATORS ?? '{}',
  }
}
export function operatorApproved(config, shop, phone) {
  try { return JSON.parse(config.approvedRecipients)[String(shop)]?.includes(phone) === true }
  catch { return false }
}
export function providerReady(channel, config) {
  if (channel === 'push') return Boolean(config.vapidPublic && config.vapidPrivate && config.vapidSubject)
  return Boolean(config.whatsappToken && /^\d+$/.test(config.phoneId) && /^\d+$/.test(config.businessId)
    && /^v\d+\.\d+$/.test(config.version) && /^[a-z0-9_]+$/.test(config.template)
    && /^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(config.language) && config.appSecret && config.verifyToken)
}
