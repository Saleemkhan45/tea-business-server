import webpush from 'web-push'
import { allowedPushEndpoint } from './privacy.js'
import { providerReady } from './config.js'

export function whatsappPayload(phone, config) {
  if (!/^\+[1-9]\d{7,14}$/.test(phone) || !providerReady('whatsapp', config)) throw new Error('Provider configuration is incomplete.')
  // Approved privacy-minimized template: no customer, balance, URL token or variable content.
  return { messaging_product: 'whatsapp', to: phone.slice(1), type: 'template',
    template: { name: config.template, language: { code: config.language } } }
}
export async function sendWhatsApp(phone, config, request = fetch) {
  const response = await request(`https://graph.facebook.com/${config.version}/${config.phoneId}/messages`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${config.whatsappToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(whatsappPayload(phone, config)),
  })
  if (!response.ok) throw { statusCode: response.status, retryAfter: response.headers.get('retry-after') }
  const payload = await response.json()
  if (!payload.messages?.[0]?.id) throw new Error('Provider acknowledgment missing.')
  return { status: 'accepted', providerMessageId: payload.messages[0].id }
}
export async function sendPush(subscription, config, send = webpush.sendNotification) {
  if (!allowedPushEndpoint(subscription.endpoint)) throw { statusCode: 400 }
  await send(subscription, JSON.stringify({ title: 'Khata Collection Due', body: 'You have a scheduled collection. Open your dashboard to review.' }), {
    vapidDetails: { subject: config.vapidSubject, publicKey: config.vapidPublic, privateKey: config.vapidPrivate },
    TTL: 3600, timeout: 10000,
  })
  // Push service acceptance is not proof of display or receipt on a device.
  return { status: 'accepted' }
}
