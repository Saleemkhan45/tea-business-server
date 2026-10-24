import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ conversation: vi.fn(), queue: vi.fn(), list: vi.fn() }))
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, res, next) => { req.user = { id: 'operator', shopId: 'own-shop', role: 'staff' }; next() } }))
vi.mock('../models/WhatsApp.js', () => ({ WhatsAppConversation: { findOne: db.conversation }, WhatsAppIntegration: {} }))
vi.mock('./service.js', () => ({ queueMessage: db.queue, listConversations: db.list }))
import { whatsappRoutes } from './routes.js'
let server, base
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/wa', whatsappRoutes)
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve))
  base = `http://127.0.0.1:${server.address().port}/wa`
})
afterAll(async () => { await new Promise(resolve => server.close(resolve)) })
beforeEach(() => { vi.clearAllMocks(); db.conversation.mockReturnValue({ lean: async () => null }); db.list.mockResolvedValue({ rows: [], total: 0 }) })
describe('customer conversation route isolation', () => {
  it('does not return a conversation from a different shop', async () => {
    const id = '507f1f77bcf86cd799439011'
    const response = await fetch(`${base}/conversations/${id}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Reply', clientKey: '123e4567-e89b-42d3-a456-426614174000' }) })
    expect(response.status).toBe(404)
    expect(db.conversation).toHaveBeenCalledWith({ _id: id, shop: 'own-shop' })
    expect(db.queue).not.toHaveBeenCalled()
  })
  it('rejects client-selected templates or shop overrides on manual reply routes', async () => {
    const response = await fetch(`${base}/conversations/507f1f77bcf86cd799439011/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Reply', clientKey: '123e4567-e89b-42d3-a456-426614174000', shop: 'foreign', kind: 'template' }) })
    expect(response.status).toBe(400); expect(db.queue).not.toHaveBeenCalled()
  })
  it('uses authenticated scope and pagination and blocks staff configuration access', async () => {
    expect((await fetch(`${base}/conversations?page=2`)).status).toBe(200)
    expect(db.list).toHaveBeenCalledWith('own-shop', 'operator', 2)
    expect((await fetch(`${base}/integration`)).status).toBe(403)
  })
})
