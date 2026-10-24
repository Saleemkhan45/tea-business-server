import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// A small fixture executor, not a MongoDB engine or a live connection.
const db = vi.hoisted(() => {
  const state = { stocks: [], items: [], regions: [], reads: [], options: null }
  const equal = (a, b) => String(a) === String(b)
  const match = (row, filter) => Object.entries(filter).every(([key, value]) => {
    if (key.endsWith('.0')) return Boolean(row[key.slice(0, -2)]?.length) === value.$exists
    return equal(row[key], value)
  })
  const recordRead = (collection, rows) => state.reads.push({ collection, rows: rows.length, bytes: Buffer.byteLength(JSON.stringify(rows)) })
  const find = (collection, filter) => {
    let rows = state[collection].filter(row => match(row, filter))
    return { sort() { return this }, select(fields) { rows = rows.map(row => Object.fromEntries(fields.split(' ').filter(key => key in row).map(key => [key, row[key]]))); return this },
      async lean() { recordRead(collection, rows); return structuredClone(rows) } }
  }
  const aggregate = pipeline => ({ async option(options) {
    state.options = options
    let rows = state.stocks.map(row => ({ ...row }))
    for (const step of pipeline) {
      if (step.$match) rows = rows.filter(row => match(row, step.$match))
      else if (step.$lookup) {
        const lookup = step.$lookup
        rows = rows.map(row => ({ ...row, [lookup.as]: state[lookup.from].filter(foreign => equal(foreign[lookup.foreignField], row[lookup.localField]) && match(foreign, lookup.pipeline[0].$match)) }))
      } else if (step.$group) rows = rows.length ? [{ _id: null, quantityGrams: rows.reduce((total, row) => total + row.quantityGrams, 0) }] : []
      else throw new Error('Unsupported fixture stage')
    }
    recordRead('stocks', rows)
    return rows
  } })
  return { state, find, aggregate }
})
vi.mock('../models/RegionalStock.js', () => ({ RegionalStock: { find: filter => db.find('stocks', filter), aggregate: db.aggregate } }))
vi.mock('../models/Item.js', () => ({ Item: { collection: { name: 'items' }, find: filter => db.find('items', filter) } }))
vi.mock('../models/Region.js', () => ({ Region: { collection: { name: 'regions' }, find: filter => db.find('regions', filter) } }))
import { dashboardStockKg, dashboardStockPipeline } from './dashboardStockService.js'
import { listInventory } from './regionalInventoryService.js'

const shop = '507f1f77bcf86cd799439001', other = '507f1f77bcf86cd799439002'
const oid = number => number.toString(16).padStart(24, '0')
const sumListing = rows => rows.filter(row => row.status !== 'inactive').reduce((sum, row) => sum + Math.round(row.availableKg * 1000), 0) / 1000

beforeEach(() => {
  Object.assign(db.state, { stocks: [], items: [], regions: [], reads: [], options: null })
})

describe('dashboard stock read plan, isolated fixtures', () => {
  it('matches the existing inventory authority for shop, active references, region and gram precision', async () => {
    db.state.items = [
      { _id: oid(10), shop, name: 'Active', teaType: 'green', status: 'active', stockKg: 99999 },
      { _id: oid(11), shop, name: 'Inactive', status: 'inactive' },
      { _id: oid(12), shop: other, name: 'Foreign', status: 'active' },
    ]
    db.state.regions = [{ _id: oid(20), shop, name: 'Active', status: 'active' }, { _id: oid(21), shop, name: 'Inactive', status: 'inactive' }]
    db.state.stocks = [
      { shop, item: oid(10), region: oid(20), quantityGrams: 125 },
      { shop, item: oid(10), region: oid(20), quantityGrams: 375 },
      { shop, item: oid(10), region: oid(20), quantityGrams: 0 },
      { shop, item: oid(11), region: oid(20), quantityGrams: 100000 },
      { shop, item: oid(10), region: oid(21), quantityGrams: 100000 },
      { shop, item: oid(12), region: oid(20), quantityGrams: 100000 },
      { shop, item: oid(99), region: oid(20), quantityGrams: 100000 },
      { shop: other, item: oid(10), region: oid(20), quantityGrams: 100000 },
    ]
    expect(await dashboardStockKg(shop)).toBe(sumListing(await listInventory({ shop })))
    expect(await dashboardStockKg(shop, oid(20))).toBe(.5)
    expect(await dashboardStockKg(shop, oid(21))).toBe(0)
    expect(await dashboardStockKg(other)).toBe(0)
    expect(db.state.options).toEqual({ maxTimeMS: 10000 })
    const pipeline = dashboardStockPipeline(shop, oid(20))
    expect(String(pipeline[0].$match.shop)).toBe(shop)
    expect(String(pipeline[0].$match.region)).toBe(oid(20))
    for (const step of pipeline.filter(row => row.$lookup)) {
      expect(String(step.$lookup.pipeline[0].$match.shop)).toBe(shop)
      expect(step.$lookup.pipeline[0].$match.status).toBe('active')
    }
  })
  it('does not turn an unsafe quantity or failed database read into a zero balance', async () => {
    db.state.items = [{ _id: oid(10), shop, status: 'active' }]
    db.state.regions = [{ _id: oid(20), shop, status: 'active' }]
    db.state.stocks = [{ shop, item: oid(10), region: oid(20), quantityGrams: Number.MAX_SAFE_INTEGER + 1 }]
    await expect(dashboardStockKg(shop)).rejects.toMatchObject({ statusCode: 409 })
  })
  it('measures fewer reads and returned documents for the same 5,000-assignment fixture', async () => {
    db.state.items = Array.from({ length: 100 }, (_, i) => ({ _id: oid(1000 + i), shop, name: `Tea ${i}`, status: 'active', teaType: 'green', sellingPrice: 1000, lowStockThreshold: 10 }))
    db.state.regions = Array.from({ length: 50 }, (_, i) => ({ _id: oid(2000 + i), shop, name: `Region ${i}`, status: 'active' }))
    db.state.stocks = Array.from({ length: 5000 }, (_, i) => ({ _id: oid(3000 + i), shop, item: oid(1000 + i % 100), region: oid(2000 + Math.floor(i / 100)), quantityGrams: 125 + i, configurationHistory: Array.from({ length: 3 }, () => ({ beforePrice: 1000, afterPrice: 1200, createdBy: oid(9), createdAt: '2026-10-22T00:00:00Z' })) }))
    const before = sumListing(await listInventory({ shop })), legacyReads = [...db.state.reads]
    db.state.reads = []
    const after = await dashboardStockKg(shop), aggregateReads = [...db.state.reads]
    expect(after).toBe(before)
    expect(legacyReads).toHaveLength(3); expect(aggregateReads).toHaveLength(1)
    const summarize = rows => ({ reads: rows.length, returnedRows: rows.reduce((sum, row) => sum + row.rows, 0), fixtureBytes: rows.reduce((sum, row) => sum + row.bytes, 0) })
    const directory = resolve('../.tmp'); mkdirSync(directory, { recursive: true })
    writeFileSync(resolve(directory, 'dashboard-stock-read-plan.json'), JSON.stringify({ offline: true, assignments: 5000, before: summarize(legacyReads), after: summarize(aggregateReads), stockKg: after, note: 'Fixture transfer sizes and application-issued command counts; not MongoDB execution time, query plans, or wire bytes.' }, null, 2))
  })
})
