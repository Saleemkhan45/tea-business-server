import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { reminderConfig, operatorApproved } from './config.js'
import { protect, unprotect, allowedPushEndpoint, validSignature } from './privacy.js'
import { failurePolicy, nextAllowedTime, eligibleOccurrence } from './policy.js'
import { sendWhatsApp, sendPush, whatsappPayload } from './providers.js'
import { scheduledOn, nextCollectionDate, reminderInstant } from '../services/collectionCalculations.js'
import { settingsSchema, subscriptionSchema } from './routes.js'

const config = { ...reminderConfig({}), whatsappToken: 'offline-not-a-real-token', businessId: '123', phoneId: '456',
  version: 'v99.0', template: 'operator_collection_due', language: 'en', appSecret: 'offline-app-secret', verifyToken: 'offline-verify' }
const now = new Date('2026-10-21T05:00:00Z')
describe('collection schedule additions', () => {
  it('schedules one date without inventing a repeating weekday', () => {
    const schedule = { frequency: 'one_time', weekdays: [], status: 'active', startDate: '2026-10-21' }
    expect(scheduledOn(schedule, '2026-10-21')).toBe(true)
    expect(scheduledOn(schedule, '2026-10-28')).toBe(false)
    expect(nextCollectionDate(schedule, '2026-10-22')).toBeNull()
  })
  it('interprets 09:00 in Karachi rather than the server timezone', () => {
    expect(reminderInstant({ scheduledDate: '2026-10-21', time: '09:00' }).toISOString()).toBe('2026-10-21T04:00:00.000Z')
    const occurrence = { scheduledDate: '2026-10-21', time: '10:01' }
    expect(eligibleOccurrence(occurrence, { status: 'due' }, now)).toBe(false)
    expect(eligibleOccurrence({ ...occurrence, time: '09:00' }, { status: 'due' }, now)).toBe(true)
    expect(eligibleOccurrence({ scheduledDate: '2026-10-18' }, { status: 'overdue' }, now)).toBe(false)
    expect(eligibleOccurrence({ ...occurrence, time: '09:00' }, { status: 'collected' }, now)).toBe(false)
  })
})
describe('delivery privacy and deployment gates', () => {
  it('defaults to dry run and requires approval for this particular shop', () => {
    expect(reminderConfig({}).live).toBe(false)
    const settings = { approvedRecipients: JSON.stringify({ shop: ['+923001234567'] }) }
    expect(operatorApproved(settings, 'shop', '+923001234567')).toBe(true)
    expect(operatorApproved(settings, 'other-shop', '+923001234567')).toBe(false)
  })
  it('encrypts subscription credentials with tenant-bound authenticated encryption', () => {
    const key = 'a'.repeat(64), value = { endpoint: 'https://fcm.googleapis.com/device', keys: { auth: 'secret' } }
    const encrypted = protect(value, key, 'shop:user')
    expect(encrypted).not.toContain('secret')
    expect(unprotect(encrypted, key, 'shop:user')).toEqual(value)
    expect(() => unprotect(encrypted, key, 'other-shop:user')).toThrow()
    expect(() => protect(value, '', 'shop:user')).toThrow('deployment')
  })
  it.each(['http://fcm.googleapis.com/device', 'https://127.0.0.1/device', 'https://fcm.googleapis.com.attacker.invalid/device', 'https://user:password@fcm.googleapis.com/device'])('rejects unsafe push destination %s', endpoint => {
    expect(allowedPushEndpoint(endpoint)).toBe(false)
  })
  it('validates public subscription keys and rejects unknown settings', () => {
    expect(subscriptionSchema.safeParse({ endpoint: 'https://fcm.googleapis.com/device', keys: { auth: 'x', p256dh: 'x' } }).success).toBe(false)
    expect(settingsSchema.safeParse({ push: false, whatsapp: true, customerMode: true, quietStart: '21:00', quietEnd: '08:00', revision: 0 }).success).toBe(false)
  })
  it('requires the exact raw-body webhook signature', () => {
    const raw = Buffer.from('{"offline":true}')
    const signature = `sha256=${createHmac('sha256', config.appSecret).update(raw).digest('hex')}`
    expect(validSignature(raw, signature, config.appSecret)).toBe(true)
    expect(validSignature(Buffer.from('{}'), signature, config.appSecret)).toBe(false)
    expect(validSignature(raw, signature, '')).toBe(false)
  })
})
describe('provider adapters without network activity', () => {
  it('builds only approved privacy-minimized template messages', () => {
    expect(whatsappPayload('+923001234567', config)).toEqual({ messaging_product: 'whatsapp', to: '923001234567', type: 'template', template: { name: 'operator_collection_due', language: { code: 'en' } } })
    expect(() => whatsappPayload('03001234567', config)).toThrow()
  })
  it('records acceptance, not delivery, and uses a fixed official endpoint', async () => {
    const request = vi.fn().mockResolvedValue(new Response('{"messages":[{"id":"offline-message"}]}'))
    expect(await sendWhatsApp('+923001234567', config, request)).toEqual({ status: 'accepted', providerMessageId: 'offline-message' })
    expect(request.mock.calls[0][0]).toBe('https://graph.facebook.com/v99.0/456/messages')
  })
  it('does not leak provider error bodies', async () => {
    const request = vi.fn().mockResolvedValue(new Response('private provider details', { status: 429, headers: { 'retry-after': '120' } }))
    await expect(sendWhatsApp('+923001234567', config, request)).rejects.toEqual({ statusCode: 429, retryAfter: '120' })
  })
  it('sends a generic push and never a customer name, balance or token', async () => {
    const send = vi.fn().mockResolvedValue({ statusCode: 201 })
    await expect(sendPush({ endpoint: 'https://fcm.googleapis.com/device' }, config, send)).resolves.toEqual({ status: 'accepted' })
    expect(JSON.parse(send.mock.calls[0][1])).toEqual({ title: 'Khata Collection Due', body: 'You have a scheduled collection. Open your dashboard to review.' })
  })
})
describe('quiet hours and retry policy', () => {
  it('defers across Karachi midnight and month end', () => {
    const value = new Date('2026-10-31T18:00:00Z')
    expect(nextAllowedTime(value, { quietStart: '21:00', quietEnd: '08:00' }).toISOString()).toBe('2026-11-01T03:00:00.000Z')
    expect(nextAllowedTime(now, { quietStart: '21:00', quietEnd: '08:00' })).toEqual(now)
    expect(nextAllowedTime(now, { quietStart: '09:00', quietEnd: '11:00' }).toISOString()).toBe('2026-10-21T06:00:00.000Z')
  })
  it('backs off rate limits and caps attempts without retrying uncertainty', () => {
    expect(failurePolicy({ statusCode: 429, retryAfter: '120' }, 1, now)).toMatchObject({ status: 'retry', nextAttemptAt: new Date(now.getTime() + 120000) })
    expect(failurePolicy({ statusCode: 429, headers: { 'retry-after': '180' } }, 1, now).nextAttemptAt).toEqual(new Date(now.getTime() + 180000))
    expect(failurePolicy({ statusCode: 500 }, 5, now).status).toBe('failed')
    expect(failurePolicy({ statusCode: 410 }, 1, now).safeErrorCode).toBe('recipient_expired')
    expect(failurePolicy({ statusCode: 400 }, 1, now).status).toBe('failed')
    expect(failurePolicy(new Error('socket timeout'), 1, now).status).toBe('uncertain')
  })
})
