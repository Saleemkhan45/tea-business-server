import { beforeEach, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ contact: vi.fn(), conversation: vi.fn(), message: vi.fn(), read: vi.fn(), integration: vi.fn() }))
vi.mock('../models/WhatsApp.js', () => ({
  WhatsAppContact: { collection: { listIndexes: () => ({ toArray: db.contact }) } },
  WhatsAppConversation: { collection: { listIndexes: () => ({ toArray: db.conversation }) } },
  WhatsAppMessage: { collection: { listIndexes: () => ({ toArray: db.message }) } },
  WhatsAppRead: { collection: { listIndexes: () => ({ toArray: db.read }) } },
  WhatsAppIntegration: { collection: { listIndexes: () => ({ toArray: db.integration }) } },
}))
import { requireWhatsAppIndexes } from './readiness.js'
const index = (name, key, partialFilterExpression) => ({ name, key, unique: true, ...(partialFilterExpression ? { partialFilterExpression } : {}) })
beforeEach(() => {
  db.contact.mockResolvedValue([index('wa_contact_customer_unique', { shop: 1, customer: 1 }), index('wa_contact_phone_unique', { shop: 1, phoneHash: 1 })])
  db.conversation.mockResolvedValue([index('wa_conversation_phone_unique', { shop: 1, phoneHash: 1 })])
  db.message.mockResolvedValue([index('wa_message_provider_unique', { providerMessageId: 1 }, { providerMessageId: { $type: 'string' } }), index('wa_message_intent_unique', { shop: 1, clientKey: 1 }, { clientKey: { $type: 'string' } })])
  db.read.mockResolvedValue([index('wa_read_user_unique', { shop: 1, message: 1, user: 1 })])
  db.integration.mockResolvedValue([index('wa_integration_shop_unique', { shop: 1 })])
})
it('requires reviewed ownership and message replay indexes', async () => {
  await expect(requireWhatsAppIndexes()).resolves.toBeUndefined()
  db.message.mockResolvedValue([])
  await expect(requireWhatsAppIndexes()).rejects.toMatchObject({ statusCode: 503 })
})
it('rejects partial contact ownership indexes', async () => {
  db.contact.mockResolvedValue([index('wa_contact_customer_unique', { shop: 1, customer: 1 }, { active: true })])
  await expect(requireWhatsAppIndexes()).rejects.toMatchObject({ statusCode: 503 })
})
