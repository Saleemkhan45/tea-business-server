import mongoose from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ owner: vi.fn(), claim: vi.fn(), customerExists: vi.fn(), contact: vi.fn(), contactSave: vi.fn(), contactUpdate: vi.fn(),
  conversation: vi.fn(), conversationSave: vi.fn(), conversationUpdate: vi.fn(), message: vi.fn(), create: vi.fn(), messageExists: vi.fn(),
  notification: vi.fn(), integration: vi.fn(), index: vi.fn() }))
vi.mock('../models/Customer.js', () => ({ Customer: { findOne: db.owner, findOneAndUpdate: db.claim, exists: db.customerExists } }))
vi.mock('../models/CustomerLedgerTransaction.js', () => ({ CustomerLedgerTransaction: {} }))
vi.mock('../models/Notification.js', () => ({ Notification: { updateOne: db.notification } }))
vi.mock('../models/WhatsApp.js', () => ({
  WhatsAppContact: { findOne: db.contact, findOneAndUpdate: db.contactSave, updateOne: db.contactUpdate },
  WhatsAppConversation: { findOne: db.conversation, findOneAndUpdate: db.conversationSave, updateOne: db.conversationUpdate },
  WhatsAppMessage: { findOne: db.message, create: db.create, exists: db.messageExists },
  WhatsAppRead: {}, WhatsAppIntegration: { updateOne: db.integration },
}))
vi.mock('./readiness.js', () => ({ requireWhatsAppIndexes: db.index }))
import { getContact, saveContact, receiveInbound, queueMessage, linkConversation } from './service.js'
import { fingerprint, protect, unprotect } from '../reminders/privacy.js'
const shop = '507f1f77bcf86cd799439011', customer = '507f1f77bcf86cd799439012', actor = '507f1f77bcf86cd799439013'
const config = { customerEnabled: true, customerShop: shop, encryptionKey: 'a'.repeat(64), retentionDays: 90 }
const phone = '+923001234567', phoneHash = fingerprint(phone)
const now = new Date('2026-10-21T05:00:00Z')
const conversation = { _id: 'conversation', shop, customer, phoneHash, lastInboundAt: new Date(now.getTime() - 1000), optedOut: false }
const contact = { _id: 'contact', shop, customer, phoneHash, optedIn: true, revision: 1, protectedPhone: protect(phone, config.encryptionKey, `${shop}:${customer}:contact`) }
function query(value) { return { session() { return this }, select() { return this }, lean: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject) } } }
beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(mongoose, 'startSession').mockResolvedValue({ withTransaction: callback => callback(), endSession: vi.fn() })
  db.owner.mockReturnValue(query({ _id: customer, name: 'Ali', phone: '03001234567', status: 'active' }))
  db.claim.mockReturnValue(query({ _id: customer })); db.customerExists.mockReturnValue(query(true))
  db.contact.mockReturnValue(query(contact)); db.contactSave.mockReturnValue(query(contact))
  db.conversationSave.mockReturnValue(query(conversation)); db.conversation.mockReturnValue(query(conversation))
  db.message.mockReturnValue(query(null)); db.messageExists.mockResolvedValue(false)
  for (const fn of [db.create, db.notification, db.integration, db.contactUpdate, db.conversationUpdate]) fn.mockResolvedValue({})
  db.index.mockResolvedValue()
})
afterEach(() => vi.restoreAllMocks())
describe('customer contact and consent offline', () => {
  it('shows the existing phone separately from explicitly configured consent', async () => {
    db.contact.mockReturnValue(query(null))
    expect(await getContact(shop, customer, config)).toMatchObject({ existingPhone: '03001234567', phone: '', optedIn: false })
    expect(db.owner).toHaveBeenCalledWith({ _id: customer, shop })
  })
  it('refuses consent without a recorded source', async () => {
    await expect(saveContact(shop, customer, actor, { phone, optedIn: true, consentSource: '', revision: 1 }, config)).rejects.toThrow('consent')
    expect(db.contactSave).not.toHaveBeenCalled()
  })
  it('does not overwrite a foreign customer or a stale contact revision', async () => {
    db.claim.mockReturnValue(query(null))
    await expect(saveContact(shop, customer, actor, { phone, optedIn: false, revision: 1 }, config)).rejects.toMatchObject({ statusCode: 404 })
    db.claim.mockReturnValue(query({ _id: customer }))
    await expect(saveContact(shop, customer, actor, { phone, optedIn: false, revision: 0 }, config)).rejects.toMatchObject({ statusCode: 409 })
  })
  it('requires the exact customer contact before linking an unknown sender', async () => {
    db.contact.mockReturnValue(query(null))
    await expect(linkConversation(shop, 'conversation', customer, actor)).rejects.toMatchObject({ statusCode: 409 })
    expect(db.conversationUpdate).not.toHaveBeenCalled()
  })
})
describe('signed inbound persistence downstream of webhook verification', () => {
  const inbound = { id: 'wamid.inbound', from: '923001234567', timestamp: String(now.getTime() / 1000), type: 'text', text: { body: 'I will pay tomorrow' } }
  it('stores an encrypted message, scopes matching to the configured shop, and never records money', async () => {
    await receiveInbound(shop, inbound, config, now)
    expect(db.contact).toHaveBeenCalledWith({ shop, phoneHash })
    const created = db.create.mock.calls[0][0][0]
    expect(created.protectedBody).not.toContain('I will pay tomorrow')
    expect(unprotect(created.protectedBody, config.encryptionKey, `${shop}:${created._id}:message`).text).toBe('I will pay tomorrow')
    expect(db.notification.mock.calls[0][1].$setOnInsert.type).toBe('WHATSAPP_MESSAGE')
    expect(db.contactUpdate).not.toHaveBeenCalled()
    expect(db.conversationUpdate.mock.calls[0][1].$max.lastInboundAt).toEqual(now)
  })
  it('blocks a webhook from assigning a sender to a different shop', async () => {
    await expect(receiveInbound('other-shop', inbound, config, now)).rejects.toMatchObject({ statusCode: 503 })
    expect(db.create).not.toHaveBeenCalled()
  })
  it('stores unknown senders unlinked rather than searching another shop or the ordinary phone field', async () => {
    db.contact.mockReturnValue(query(null))
    await receiveInbound(shop, inbound, config, now)
    const insert = db.conversationSave.mock.calls[0][1].$setOnInsert
    expect(insert).not.toHaveProperty('customer')
    expect(db.contact.mock.calls[0][0]).toEqual({ shop, phoneHash })
    expect(db.owner).not.toHaveBeenCalled()
  })
  it('records customer STOP as an opt-out rather than a payment or schedule edit', async () => {
    await receiveInbound(shop, { ...inbound, text: { body: 'STOP' } }, config, now)
    expect(db.contactUpdate.mock.calls[0][1].$set).toMatchObject({ optedIn: false, consentSource: 'customer_opt_out' })
    expect(db.conversationUpdate.mock.calls[0][1].$set.optedOut).toBe(true)
  })
  it('acknowledges a true message replay but not a failed conversation-creation race', async () => {
    db.create.mockRejectedValue({ code: 11000 })
    db.messageExists.mockResolvedValue(true)
    await expect(receiveInbound(shop, inbound, config, now)).resolves.toBeUndefined()
    db.messageExists.mockResolvedValue(false)
    await expect(receiveInbound(shop, inbound, config, now)).rejects.toMatchObject({ code: 11000 })
  })
})
describe('outgoing intent and service-window safety', () => {
  it('queues a reply only once and rejects changed text with the same client key', async () => {
    const body = { kind: 'text', text: 'Thank you', clientKey: 'offline-key' }
    await queueMessage(shop, conversation, actor, body, config, now)
    const stored = db.create.mock.calls[0][0]
    db.message.mockReturnValue(query(stored))
    await queueMessage(shop, conversation, actor, body, config, now)
    expect(db.create).toHaveBeenCalledOnce()
    await expect(queueMessage(shop, conversation, actor, { ...body, text: 'Changed reply' }, config, now)).rejects.toMatchObject({ statusCode: 409 })
  })
  it('rejects free-form text outside the 24-hour window', async () => {
    await expect(queueMessage(shop, { ...conversation, lastInboundAt: new Date(now.getTime() - 86400000) }, actor, { kind: 'text', text: 'Reply', clientKey: 'key' }, config, now)).rejects.toThrow('24-hour')
    expect(db.create).not.toHaveBeenCalled()
  })
  it('requires explicit template consent and blocks opted-out conversations', async () => {
    db.contact.mockReturnValue(query({ ...contact, optedIn: false }))
    await expect(queueMessage(shop, conversation, undefined, { kind: 'template', amount: 2000, clientKey: 'key' }, config, now)).rejects.toThrow('consent')
    await expect(queueMessage(shop, { ...conversation, optedOut: true }, actor, { kind: 'text', text: 'Reply', clientKey: 'key' }, config, now)).rejects.toThrow('opted-out')
  })
})
