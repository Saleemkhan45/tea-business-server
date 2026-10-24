import { afterEach, expect, it, vi } from 'vitest'
import { emailDeliveryConfigured, sendSecurityEmail } from './securityEmail.js'
import { emailChangeVerification } from './securityEmailTemplates.js'
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
const message = { to: 'test@example.invalid', subject: 'Offline verification', text: 'Offline only' }
it('fails closed before any network call without explicit delivery opt-in', async () => {
  vi.stubEnv('SECURITY_EMAIL_ENABLED', 'false')
  const request = vi.fn(); vi.stubGlobal('fetch', request)
  expect(emailDeliveryConfigured()).toBe(false)
  await expect(sendSecurityEmail(message)).rejects.toMatchObject({ statusCode: 503 })
  expect(request).not.toHaveBeenCalled()
})
it('sends only via the configured provider and never exposes its raw errors', async () => {
  vi.stubEnv('SECURITY_EMAIL_ENABLED', 'true'); vi.stubEnv('RESEND_API_KEY', 'offline-key'); vi.stubEnv('SECURITY_EMAIL_FROM', 'test@example.invalid')
  const request = vi.fn().mockResolvedValueOnce(new Response('{"id":"offline-id"}')).mockResolvedValueOnce(new Response('{"message":"private-provider-details"}', { status: 403 }))
  vi.stubGlobal('fetch', request)
  await sendSecurityEmail(message)
  expect(request.mock.calls[0][0]).toBe('https://api.resend.com/emails')
  expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ to: [message.to], text: message.text })
  await expect(sendSecurityEmail(message)).rejects.toMatchObject({ statusCode: 503, message: expect.not.stringContaining('private-provider-details') })
})
it('renders a branded, escaped verification email with a plain-text fallback and expiry', () => {
  const message = emailChangeVerification({ email: 'name+<tag>@example.test', url: 'https://tea.example.test/verify-email#' + 'a'.repeat(64) })
  expect(message.html).toContain('Verify Email')
  expect(message.html).toContain('15 minutes')
  expect(message.html).toContain('name+&lt;tag&gt;@example.test')
  expect(message.html).not.toContain('name+<tag>')
  expect(message.text).toContain('Your existing email and password remain unchanged')
  expect(message.text).toContain('ignore this message')
})
it('does not acknowledge malformed provider successes and sends both HTML and text', async () => {
  vi.stubEnv('SECURITY_EMAIL_ENABLED', 'true'); vi.stubEnv('RESEND_API_KEY', 'offline-key'); vi.stubEnv('SECURITY_EMAIL_FROM', 'Tea Business <test@example.invalid>')
  const request = vi.fn().mockResolvedValueOnce(new Response('{}'))
  vi.stubGlobal('fetch', request)
  const message = emailChangeVerification({ email: 'new@example.invalid', url: 'https://tea.example.test/verify-email#' + 'b'.repeat(64) })
  await expect(sendSecurityEmail({ to: 'new@example.invalid', ...message })).rejects.toMatchObject({ statusCode: 503 })
  expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ html: message.html, text: message.text })
})
it('treats whitespace credentials as unconfigured without attempting delivery', () => {
  vi.stubEnv('SECURITY_EMAIL_ENABLED', 'true'); vi.stubEnv('RESEND_API_KEY', ' '); vi.stubEnv('SECURITY_EMAIL_FROM', ' ')
  expect(emailDeliveryConfigured()).toBe(false)
})
it.each([[401, 'authorization'], [403, 'sender verification'], [422, 'message configuration'], [429, 'rate limited']])('provides safe guidance for provider HTTP %s', async (status, guidance) => {
  vi.stubEnv('SECURITY_EMAIL_ENABLED', 'true'); vi.stubEnv('RESEND_API_KEY', 'offline-key'); vi.stubEnv('SECURITY_EMAIL_FROM', 'test@example.invalid')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"message":"private-provider-details"}', { status })))
  await expect(sendSecurityEmail(message)).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining(guidance) })
  await expect(sendSecurityEmail(message)).rejects.toMatchObject({ message: expect.not.stringContaining('private-provider-details') })
})
