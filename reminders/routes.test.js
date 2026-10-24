import express from 'express'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ settings: vi.fn(), save: vi.fn(), subscribe: vi.fn(), index: vi.fn() }))
vi.mock('../models/ReminderDelivery.js', () => ({
  ReminderSettings: { findOne: db.settings, findOneAndUpdate: db.save },
  PushDevice: { findOneAndUpdate: db.subscribe }, ReminderDelivery: {},
}))
vi.mock('./readiness.js', () => ({ requireReminderIndexes: db.index }))
import { reminderRoutes } from './routes.js'
let server, base
beforeAll(async () => {
  const app = express(); app.use(express.json())
  // Parent authentication/CSRF is independently exercised in authRoutes.test.js.
  app.use((req, res, next) => { req.user = { id: 'operator', shopId: 'owned-shop', role: 'admin' }; req.auth = { session: { _id: 'session' } }; next() })
  app.use('/delivery', reminderRoutes)
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve))
  base = `http://127.0.0.1:${server.address().port}/delivery`
})
afterAll(async () => { await new Promise(resolve => server.close(resolve)) })
beforeEach(() => {
  vi.clearAllMocks(); db.index.mockResolvedValue(); db.settings.mockReturnValue({ lean: async () => null })
  vi.stubEnv('REMINDER_ENCRYPTION_KEY', 'a'.repeat(64)); vi.stubEnv('VAPID_PUBLIC_KEY', 'offline-public')
  vi.stubEnv('VAPID_PRIVATE_KEY', 'offline-private'); vi.stubEnv('VAPID_SUBJECT', 'mailto:offline@example.invalid')
  vi.stubEnv('WHATSAPP_APPROVED_OPERATORS', '{}')
})
afterEach(() => vi.unstubAllEnvs())
describe('delivery settings shop boundaries offline', () => {
  it('does not accept a phone without approval and consent or expose approved numbers', async () => {
    const response = await fetch(`${base}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ push: false, whatsapp: true, operatorPhone: '+923001234567', operatorConsent: true, quietStart: '21:00', quietEnd: '08:00', revision: 0 }) })
    expect(response.status).toBe(400); expect(db.save).not.toHaveBeenCalled()
    expect(db.settings).toHaveBeenCalledWith({ shop: 'owned-shop' })
  })
  it('cannot overwrite a push endpoint belonging to another account', async () => {
    db.subscribe.mockRejectedValue({ code: 11000 })
    const publicKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url')
    const response = await fetch(`${base}/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/offline', keys: { p256dh: publicKey, auth: Buffer.alloc(16).toString('base64url') } }) })
    expect(response.status).toBe(409)
    expect(db.subscribe.mock.calls[0][0]).toMatchObject({ shop: 'owned-shop', user: 'operator' })
    expect(db.subscribe.mock.calls[0][1].$set.protectedSubscription).not.toContain('fcm.googleapis.com')
  })
})
