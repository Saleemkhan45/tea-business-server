import { WhatsAppContact, WhatsAppConversation, WhatsAppMessage, WhatsAppRead, WhatsAppIntegration } from '../models/WhatsApp.js'
export async function requireWhatsAppIndexes() {
  const specs = [
    [WhatsAppContact, 'wa_contact_customer_unique', { shop: 1, customer: 1 }],
    [WhatsAppContact, 'wa_contact_phone_unique', { shop: 1, phoneHash: 1 }],
    [WhatsAppConversation, 'wa_conversation_phone_unique', { shop: 1, phoneHash: 1 }],
    [WhatsAppMessage, 'wa_message_provider_unique', { providerMessageId: 1 }, { providerMessageId: { $type: 'string' } }],
    [WhatsAppMessage, 'wa_message_intent_unique', { shop: 1, clientKey: 1 }, { clientKey: { $type: 'string' } }],
    [WhatsAppRead, 'wa_read_user_unique', { shop: 1, message: 1, user: 1 }],
    [WhatsAppIntegration, 'wa_integration_shop_unique', { shop: 1 }],
  ]
  try {
    for (const [model, name, key, partial] of specs) {
      const indexes = await model.collection.listIndexes().toArray()
      if (!indexes.some(row => row.name === name && row.unique && !row.sparse && JSON.stringify(row.key) === JSON.stringify(key)
        && JSON.stringify(row.partialFilterExpression) === JSON.stringify(partial))) throw new Error()
    }
  } catch { throw Object.assign(new Error('Customer WhatsApp requires reviewed index deployment.'), { statusCode: 503 }) }
}
