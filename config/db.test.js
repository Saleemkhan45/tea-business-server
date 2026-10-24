import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn(), command: vi.fn(), readyState: 1 }))
vi.mock('mongoose', () => ({ default: { set: vi.fn(), connect: db.connect, disconnect: db.disconnect, connection: { get readyState() { return db.readyState }, db: { admin: () => ({ command: db.command }) } } } }))
vi.mock('../utils/databaseDiagnostics.js', () => ({ logDatabaseError: vi.fn() }))
import { connectDatabase, disconnectDatabase, probeDatabase } from './db.js'
beforeEach(() => { vi.clearAllMocks(); db.readyState = 1 })
describe('single database lifecycle, no connections made by tests', () => {
  it('bounds transport and pool waits without enabling migrations or indexes', async () => {
    db.connect.mockResolvedValue({})
    await connectDatabase()
    expect(db.connect).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ socketTimeoutMS: 20000, maxPoolSize: 20, waitQueueTimeoutMS: 5000, bufferCommands: false, autoIndex: false, autoCreate: false }))
    await disconnectDatabase(); expect(db.disconnect).toHaveBeenCalledOnce()
  })
  it('deduplicates readiness pings, reports disconnects and recovers using the same connection', async () => {
    db.readyState = 0
    expect(await probeDatabase()).toBe(false); expect(db.command).not.toHaveBeenCalled()
    db.readyState = 1
    let finish
    db.command.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = probeDatabase(), second = probeDatabase()
    expect(first).toBe(second)
    finish({ ok: 1 }); expect(await first).toBe(true)
    expect(db.command).toHaveBeenCalledWith({ ping: 1 }, { timeoutMS: 2000 })
    db.command.mockRejectedValueOnce(new Error('offline'))
    expect(await probeDatabase()).toBe(false)
    db.command.mockResolvedValueOnce({ ok: 1 })
    expect(await probeDatabase()).toBe(true)
    expect(db.connect).not.toHaveBeenCalled()
  })
})
