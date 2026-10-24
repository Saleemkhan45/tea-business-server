import { describe, expect, it, vi } from 'vitest'
import { normalizePhone, serviceWindowOpen, isOptOut, whatsappConfig, templateParameters, inboundText } from './policy.js'
import { customerPayload, sendCustomerMessage } from './provider.js'
const now = new Date('2026-10-21T05:00:00Z')
describe('customer WhatsApp policy', () => {
  it.each(['0300 1234567', '3001234567', '923001234567', '+92 (300) 123-4567', '00923001234567'])('normalizes Pakistan number %s', value => expect(normalizePhone(value)).toBe('+923001234567'))
  it('accepts explicit international E.164 numbers', () => expect(normalizePhone('+44 7700 900123')).toBe('+447700900123'))
  it.each(['0300123', '+9203001234567', '+00001234567', '12345', '++923001234567', 'https://example.invalid'])('rejects invalid phone %s', value => expect(() => normalizePhone(value)).toThrow())
  it('enforces the exact 24-hour boundary without extending it for future timestamps', () => {
    expect(serviceWindowOpen(new Date(now.getTime() - 86400000 + 1), now)).toBe(true)
    expect(serviceWindowOpen(new Date(now.getTime() - 86400000), now)).toBe(false)
    expect(serviceWindowOpen(new Date(now.getTime() + 1), now)).toBe(false)
    expect(serviceWindowOpen(null, now)).toBe(false)
  })
  it('treats explicit stop words as opt-out without interpreting payment promises', () => {
    expect(isOptOut(' STOP ')).toBe(true); expect(isOptOut('بند')).toBe(true)
    expect(isOptOut('I will pay tomorrow')).toBe(false)
    expect(isOptOut(inboundText({ type: 'interactive', interactive: { button_reply: { title: 'Unsubscribe' } } }))).toBe(true)
  })
  it('keeps customer activation separate and bounds content retention', () => {
    expect(whatsappConfig({}).customerEnabled).toBe(false)
    expect(whatsappConfig({ WHATSAPP_MESSAGE_RETENTION_DAYS: '99999' }).retentionDays).toBe(365)
    expect(templateParameters('Ali\nKhan', 2000)).toEqual(['Ali Khan', '2000'])
  })
})
describe('official customer provider adapter (no network)', () => {
  const config = { whatsappToken: 'offline-token', phoneId: '123', businessId: '456', version: 'v99.0', customerTemplate: 'khata_collection_customer', language: 'en', appSecret: 'offline-secret', verifyToken: 'offline-verify' }
  it('uses approved body parameters in fixed order and never arbitrary template names', () => {
    const payload = customerPayload('+923001234567', { kind: 'template', name: 'Ali', amount: 2000 }, config)
    expect(payload.template).toEqual({ name: 'khata_collection_customer', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ali' }, { type: 'text', text: '2000' }] }] })
  })
  it('formats manual replies as text and disables automatic link previews', () => {
    expect(customerPayload('+923001234567', { kind: 'text', text: 'Thank you. Please arrange payment.' }, config).text).toEqual({ preview_url: false, body: 'Thank you. Please arrange payment.' })
  })
  it('records provider acceptance separately from delivery', async () => {
    const request = vi.fn().mockResolvedValue(new Response('{"messages":[{"id":"wamid.offline"}]}'))
    expect(await sendCustomerMessage('+923001234567', { kind: 'text', text: 'Offline test' }, config, request)).toEqual({ status: 'accepted', providerMessageId: 'wamid.offline' })
    expect(request.mock.calls[0][0]).toBe('https://graph.facebook.com/v99.0/123/messages')
  })
  it('does not expose raw provider errors or recipient data', async () => {
    const request = vi.fn().mockResolvedValue(new Response('private provider details', { status: 429, headers: { 'retry-after': '120' } }))
    await expect(sendCustomerMessage('+923001234567', { kind: 'text', text: 'Offline test' }, config, request)).rejects.toEqual({ statusCode: 429, retryAfter: '120' })
  })
})
