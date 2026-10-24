import mongoose from 'mongoose'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ claim: vi.fn(), exists: vi.fn(), schedule: vi.fn(), save: vi.fn(), cursor: vi.fn(),
  ledger: vi.fn(), occurrence: vi.fn(), indexes: vi.fn() }))
vi.mock('../models/Customer.js', () => ({ Customer: { findOneAndUpdate: db.claim, exists: db.exists } }))
vi.mock('../models/CustomerLedgerTransaction.js', () => ({ CustomerLedgerTransaction: { find: db.ledger } }))
vi.mock('../models/CollectionSchedule.js', () => ({
  CollectionSchedule: { findOne: db.schedule, findOneAndUpdate: db.save, updateOne: db.cursor },
  CollectionOccurrence: { updateOne: db.occurrence },
}))
vi.mock('./collectionReadiness.js', () => ({ requireCollectionIndexes: db.indexes }))
import { saveSchedule, syncCustomer, serializeSchedule } from './collectionService.js'
import { getBusinessDate } from '../utils/businessDay.js'
import { addDays } from './collectionCalculations.js'

const shop = '507f1f77bcf86cd799439001', customer = '507f1f77bcf86cd799439002', actor = '507f1f77bcf86cd799439003'
const today = getBusinessDate()
const input = { weekdays: [0, 1, 2, 3, 4, 5, 6], expectedAmount: 2000, time: '', startDate: today, endDate: '', notes: '', status: 'active', revision: 0 }
const schedule = { _id: 'schedule', shop, customer, ...input }
function query(value) { const result = { session: () => result, lean: async () => value }; return result }
beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(mongoose, 'startSession').mockResolvedValue({ withTransaction: callback => callback(), endSession: vi.fn() })
  db.indexes.mockResolvedValue(undefined)
  db.claim.mockReturnValue(query({ _id: customer }))
  db.schedule.mockReturnValue(query(null))
  db.save.mockReturnValue(query({ ...schedule, revision: 1 }))
  db.ledger.mockReturnValue(query([{ type: 'opening_balance', status: 'active', amountPkr: 20000, businessDate: today }]))
  db.cursor.mockResolvedValue({ acknowledged: true })
  db.occurrence.mockResolvedValue({ acknowledged: true })
})
afterEach(() => vi.restoreAllMocks())
describe('collection schedule persistence offline', () => {
  it('audits the authenticated operator, scopes every write, and creates only a non-financial occurrence', async () => {
    await saveSchedule(shop, customer, actor, input)
    const { revision, ...settings } = input
    expect(db.save).toHaveBeenCalledWith({ shop, customer }, expect.objectContaining({
      $push: { history: { ...settings, updatedBy: actor } },
    }), expect.anything())
  })
  it('preserves existing due-date snapshots while editing expected amounts', async () => {
    db.schedule.mockReturnValue(query({ ...schedule, revision: 1, generatedThrough: addDays(today, -1) }))
    db.save.mockReturnValue(query({ ...schedule, revision: 2, expectedAmount: 3000, generatedThrough: today }))
    await saveSchedule(shop, customer, actor, { ...input, revision: 1, expectedAmount: 3000 })
    expect(db.occurrence).toHaveBeenCalledTimes(2)
    expect(db.occurrence.mock.calls[0][1].$setOnInsert.expectedAmount).toBe(2000)
    // Both attempts use the same identity; setOnInsert cannot overwrite the snapshot.
    expect(db.occurrence.mock.calls[1][0]).toEqual(db.occurrence.mock.calls[0][0])
    expect(db.occurrence.mock.calls[0][0]).toEqual({ shop, schedule: 'schedule', scheduledDate: today })
    expect(db.cursor.mock.calls[0][1]).toEqual({ $set: { generatedThrough: today } })
  })
  it('rejects stale concurrent schedule edits before writing schedule or occurrence data', async () => {
    db.schedule.mockReturnValue(query({ ...schedule, revision: 2 }))
    await expect(saveSchedule(shop, customer, actor, { ...input, revision: 1 })).rejects.toMatchObject({ statusCode: 409 })
    expect(db.save).not.toHaveBeenCalled()
    expect(db.occurrence).not.toHaveBeenCalled()
  })
  it('cannot claim a customer from another shop', async () => {
    db.claim.mockReturnValue(query(null))
    await expect(saveSchedule(shop, customer, actor, input)).rejects.toMatchObject({ statusCode: 404 })
    expect(db.claim.mock.calls[0][0]).toEqual({ _id: customer, shop, status: 'active' })
    expect(db.save).not.toHaveBeenCalled()
  })
  it('repeated generation uses deterministic occurrence identity and setOnInsert', async () => {
    db.schedule.mockReturnValue(query(schedule))
    await syncCustomer(shop, customer)
    await syncCustomer(shop, customer)
    expect(db.occurrence.mock.calls[0][0]).toEqual(db.occurrence.mock.calls[1][0])
    expect(db.occurrence.mock.calls.every(call => call[2].upsert && call[2].session)).toBe(true)
  })
  it('does not generate new reminders for zero balances or paused schedules', async () => {
    db.schedule.mockReturnValue(query(schedule))
    db.ledger.mockReturnValue(query([]))
    await syncCustomer(shop, customer)
    expect(db.occurrence).not.toHaveBeenCalled()
    db.schedule.mockReturnValue(query({ ...schedule, status: 'paused' }))
    db.ledger.mockReturnValue(query([{ type: 'opening_balance', status: 'active', amountPkr: 20000, businessDate: today }]))
    await syncCustomer(shop, customer)
    expect(db.occurrence).not.toHaveBeenCalled()
  })
  it('fails closed when deployment indexes are missing', async () => {
    db.indexes.mockRejectedValue(Object.assign(new Error('Deployment required.'), { statusCode: 503 }))
    await expect(saveSchedule(shop, customer, actor, input)).rejects.toMatchObject({ statusCode: 503 })
    expect(mongoose.startSession).not.toHaveBeenCalled()
  })
  it('returns editable settings that round-trip through strict validation', () => {
    const stored = { ...schedule, revision: 1, history: [{ updatedBy: actor }],
      updatedBy: actor, createdAt: new Date(), generatedThrough: today, __v: 0 }
    const editable = serializeSchedule(stored)
    expect(editable).toEqual({ ...input, revision: 1, frequency: 'weekly', channels: ['in_app'] })
    expect(editable).not.toHaveProperty('history')
    expect(editable).not.toHaveProperty('shop')
    expect(serializeSchedule(null)).toBeNull()
  })
  it('generates today when resuming a schedule already synchronized while paused', async () => {
    db.schedule.mockReturnValue(query({ ...schedule, status: 'paused', revision: 1, generatedThrough: today }))
    db.save.mockReturnValue(query({ ...schedule, revision: 2, generatedThrough: today }))
    await saveSchedule(shop, customer, actor, { ...input, revision: 1 })
    expect(db.occurrence).toHaveBeenCalledOnce()
    expect(db.occurrence.mock.calls[0][0]).toEqual({ shop, schedule: 'schedule', scheduledDate: today })
  })
})
