import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const auth = vi.hoisted(() => ({ authenticate: vi.fn(), sessionToken: vi.fn(), register: vi.fn() }))
vi.mock('../services/authService.js', () => ({ authenticate: auth.authenticate, sessionToken: auth.sessionToken }))
vi.mock('../services/notificationService.js', () => ({ registerNotificationEmitter: auth.register }))
import { initNotificationSocket, socketExpiryDelay } from './notificationSocket.js'
import { env } from '../config/env.js'

let io
let socket
beforeEach(() => {
  vi.clearAllMocks()
  socket = { handshake: { headers: { origin: env.clientOrigin } }, emit: vi.fn(), disconnect: vi.fn(), join: vi.fn(), on: vi.fn() }
  io = { use: vi.fn(), on: vi.fn(), in: vi.fn(() => ({ fetchSockets: async () => [socket] })) }
  auth.sessionToken.mockReturnValue({ token: 'offline-session' })
  auth.authenticate.mockResolvedValue({ user: { id: 'user-1', shopId: 'shop-1' }, session: { _id: 'session-1', expiresAt: new Date(Date.now() + 3600000) } })
  initNotificationSocket(io)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
describe('notification session authorization', () => {
  it('chunks long session timers and revalidates a renewed socket instead of disconnecting on the old expiry', async () => {
    vi.useFakeTimers()
    const future = new Date(Date.now() + 30 * 86400000)
    expect(socketExpiryDelay(future)).toBe(86400000)
    socket.connected = true
    socket.user = { id: 'user-1', shopId: 'shop-1' }
    socket.authSession = { _id: 'session-1', expiresAt: future }
    auth.authenticate.mockResolvedValue({ user: socket.user, session: socket.authSession })
    io.on.mock.calls[0][1](socket)
    await vi.advanceTimersByTimeAsync(86400000)
    expect(auth.authenticate).toHaveBeenCalledTimes(1)
    expect(socket.disconnect).not.toHaveBeenCalled()
    auth.authenticate.mockRejectedValueOnce(new Error('Revoked'))
    await vi.advanceTimersByTimeAsync(86400000)
    expect(socket.disconnect).toHaveBeenCalledWith(true)
  })
  it('requires a trusted origin and an authenticated session at handshake', async () => {
    const next = vi.fn()
    await io.use.mock.calls[0][0](socket, next)
    expect(next).toHaveBeenCalledWith()
    socket.handshake.headers.origin = 'https://attacker.invalid'
    await io.use.mock.calls[0][0](socket, next)
    expect(next.mock.calls.at(-1)[0]).toBeInstanceOf(Error)
  })
  it('rechecks revocation before sending private notifications', async () => {
    auth.authenticate.mockRejectedValue(new Error('Revoked session'))
    auth.register.mock.calls[0][0]({ _id: 'notification-1', shop: 'shop-1' }, ['user-1'])
    await vi.waitFor(() => expect(socket.disconnect).toHaveBeenCalledWith(true))
    expect(socket.emit).not.toHaveBeenCalled()
  })
  it('does not deliver a notification belonging to another shop', async () => {
    auth.register.mock.calls[0][0]({ _id: 'notification-1', shop: 'other-shop' }, ['user-1'])
    await vi.waitFor(() => expect(socket.disconnect).toHaveBeenCalledWith(true))
    expect(socket.emit).not.toHaveBeenCalled()
  })
  it('delivers only after validating the recipient and current shop', async () => {
    auth.register.mock.calls[0][0]({ _id: 'notification-1', shop: 'shop-1' }, ['user-1'])
    await vi.waitFor(() => expect(socket.emit).toHaveBeenCalledWith('notification:new', expect.objectContaining({ id: 'notification-1' })))
  })
})
