import express from 'express'
import { createHmac } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ update: vi.fn(), receipt: vi.fn(), known: vi.fn(), inbound: vi.fn(), integration: vi.fn() }))
vi.mock('../models/ReminderDelivery.js', () => ({ ReminderDelivery: { updateOne: db.update, exists: db.known }, ReminderReceipt: { updateOne: db.receipt } }))
import { whatsappWebhook } from './webhook.js'
vi.mock('./readiness.js', () => ({ requireReminderIndexes: async () => {} }))
vi.mock('../whatsapp/readiness.js', () => ({ requireWhatsAppIndexes: async () => {} }))
vi.mock('../whatsapp/service.js', () => ({ receiveInbound: db.inbound }))
vi.mock('../models/WhatsApp.js', () => ({ WhatsAppIntegration: { updateOne: db.integration }, WhatsAppMessage: {} }))
let server, base
beforeAll(async () => {
  const app = express(); app.use('/hook', whatsappWebhook)
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve))
  base = `http://127.0.0.1:${server.address().port}/hook`
})
afterAll(async () => { await new Promise(resolve => server.close(resolve)) })
beforeEach(() => {
  vi.stubEnv('WHATSAPP_APP_SECRET', 'offline-secret'); vi.stubEnv('WHATSAPP_VERIFY_TOKEN', 'offline-verify')
  vi.stubEnv('WHATSAPP_BUSINESS_ACCOUNT_ID', '123'); vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '456')
  db.update.mockReset().mockResolvedValue({})
  db.receipt.mockReset().mockResolvedValue({}); db.known.mockReset().mockResolvedValue(true)
  db.inbound.mockReset().mockResolvedValue(); db.integration.mockReset().mockResolvedValue({})
  vi.stubEnv('WHATSAPP_CUSTOMER_ENABLED', 'false')
})
afterEach(() => vi.unstubAllEnvs())
function event(status = 'delivered', business = '123') {
  return JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: business, changes: [{ field: 'messages', value: { metadata: { phone_number_id: '456' }, statuses: [{ id: 'offline-message', status }] } }] }] })
}
async function post(body, signed = true) {
  return fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(signed ? { 'x-hub-signature-256': `sha256=${createHmac('sha256', 'offline-secret').update(body).digest('hex')}` } : {}) }, body })
}
describe('official provider webhook boundary offline', () => {
  it('verifies the challenge without authentication cookies', async () => {
    expect((await fetch(`${base}?hub.mode=subscribe&hub.verify_token=incorrect&hub.challenge=test`)).status).toBe(403)
    expect(await (await fetch(`${base}?hub.mode=subscribe&hub.verify_token=offline-verify&hub.challenge=test`)).text()).toBe('test')
  })
  it('rejects unsigned requests before persistence', async () => {
    expect((await post(event(), false)).status).toBe(403)
    expect(db.update).not.toHaveBeenCalled()
  })
  it('accepts signed delivery events with non-regressing and idempotent state filters', async () => {
    expect((await post(event())).status).toBe(200)
    expect(db.update.mock.calls[0][0]).toEqual({ channel: 'whatsapp', providerMessageId: 'offline-message', status: { $in: ['accepted', 'failed', 'uncertain'] } })
    expect(db.update.mock.calls[0][1].$set.status).toBe('delivered')
  })
  it('ignores events from a different business account', async () => {
    expect((await post(event('delivered', 'other-business'))).status).toBe(200)
    expect(db.update).not.toHaveBeenCalled()
  })
  it('persists an early receipt when the send acknowledgment is not yet stored', async () => {
    db.known.mockResolvedValue(false)
    expect((await post(event())).status).toBe(200)
    expect(db.receipt.mock.calls[0][1].$setOnInsert).toMatchObject({ providerMessageId: 'offline-message', processed: false })
    expect(db.update).not.toHaveBeenCalled()
    expect(db.receipt.mock.calls.at(-1)[1].$set).toHaveProperty('lastCheckedAt')
  })
  it('routes signed inbound messages only to the explicitly assigned customer shop', async () => {
    const shop = '507f1f77bcf86cd799439011'
    vi.stubEnv('WHATSAPP_CUSTOMER_ENABLED', 'true'); vi.stubEnv('WHATSAPP_CUSTOMER_SHOP_ID', shop)
    const message = { id: 'wamid.inbound', from: '923001234567', timestamp: '1792558800', type: 'text', text: { body: 'I will pay tomorrow' } }
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '123', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '456' }, messages: [message] } }] }] })
    expect((await post(payload, false)).status).toBe(403)
    expect(db.inbound).not.toHaveBeenCalled()
    expect((await post(payload)).status).toBe(200)
    expect(db.inbound).toHaveBeenCalledWith(shop, message, expect.objectContaining({ customerShop: shop }))
  })
})
