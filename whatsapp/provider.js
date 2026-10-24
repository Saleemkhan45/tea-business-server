import { providerReady } from '../reminders/config.js'
import { normalizePhone, templateParameters } from './policy.js'

export function customerPayload(phone, body, config) {
  if (!providerReady('whatsapp', { ...config, template: config.customerTemplate })) throw Object.assign(new Error('WhatsApp provider setup is incomplete.'), { statusCode: 503 })
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: normalizePhone(phone).slice(1) }
  if (body.kind === 'text') {
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4096) throw new Error('Invalid reply text.')
    return { ...base, type: 'text', text: { preview_url: false, body: body.text } }
  }
  const parameters = templateParameters(body.name, body.amount).map(text => ({ type: 'text', text }))
  return { ...base, type: 'template', template: { name: config.customerTemplate, language: { code: config.language }, components: [{ type: 'body', parameters }] } }
}
export async function sendCustomerMessage(phone, body, config, request = fetch) {
  const response = await request(`https://graph.facebook.com/${config.version}/${config.phoneId}/messages`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${config.whatsappToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(customerPayload(phone, body, config)),
  })
  if (!response.ok) throw { statusCode: response.status, retryAfter: response.headers.get('retry-after') }
  const result = await response.json()
  if (typeof result.messages?.[0]?.id !== 'string') throw new Error('Provider acknowledgment missing.')
  return { status: 'accepted', providerMessageId: result.messages[0].id }
}
