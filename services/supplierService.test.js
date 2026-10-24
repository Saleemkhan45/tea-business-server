import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ find: vi.fn(), one: vi.fn(), create: vi.fn(), update: vi.fn(), purchases: vi.fn(), regions: vi.fn(), products: vi.fn(), movements: vi.fn(), manager: vi.fn() }))
vi.mock('../models/Supplier.js', () => ({ Supplier: { init: vi.fn(), find: db.find, findOne: db.one, create: db.create, findOneAndUpdate: db.update } }))
vi.mock('../models/Purchase.js', () => ({ Purchase: { find: db.purchases } }))
vi.mock('../models/Region.js', () => ({ Region: { countDocuments: db.regions } }))
vi.mock('../models/Item.js', () => ({ Item: { countDocuments: db.products } }))
vi.mock('../models/RegionalStockOperation.js', () => ({ RegionalStockOperation: { find: db.movements } }))
vi.mock('./regionalInventoryService.js', () => ({ requireManager: db.manager, objectId: value => value, inventoryError: (message, statusCode = 400) => Object.assign(new Error(message), { statusCode }) }))
import { listSuppliers, saveSupplier, supplierDetails, supplierInput, supplierStats, reconcileSupplier, supplierCreationId } from './supplierService.js'
const id = '507f1f77bcf86cd799439001', region = '507f1f77bcf86cd799439002', item = '507f1f77bcf86cd799439003'
const query = value => ({ sort() { return this }, select() { return this }, read() { return this }, readConcern() { return this }, lean: async () => value })
beforeEach(() => {
  vi.resetAllMocks(); db.create.mockImplementation(async rows => rows); db.one.mockReturnValue(query(null)); db.find.mockReturnValue(query([])); db.purchases.mockReturnValue(query([])); db.movements.mockReturnValue(query([])); db.regions.mockResolvedValue(0); db.products.mockResolvedValue(0)
})
describe('supplier management offline', () => {
  it('normalizes optional fields and rejects invalid names, phone, email and duplicate references', () => {
    expect(supplierInput.parse({ name: ' Supplier ', email: ' A@B.com ' })).toMatchObject({ name: 'Supplier', email: 'a@b.com', regions: [], status: 'active' })
    for (const input of [{ name: ' ' }, { name: 'S', phone: 'invalid' }, { name: 'S', phone: '-------' }, { name: 'S', email: 'invalid' }, { name: 'S', regions: [region, region] }]) expect(supplierInput.safeParse(input).success).toBe(false)
  })
  it('creates only validated profile fields with authenticated attribution', async () => {
    await saveSupplier({ shop: 'shop', actor: 'actor', name: ' Supplier ', totalAmount: 999, quantityGrams: 888 })
    expect(db.manager).toHaveBeenCalledWith('shop', 'actor')
    expect(db.create).toHaveBeenCalledWith([expect.objectContaining({ shop: 'shop', name: 'Supplier', createdBy: 'actor', updatedBy: 'actor' })], { writeConcern: { w: 'majority', wtimeout: 10000 } })
    expect(db.create.mock.calls[0][0][0]).not.toHaveProperty('quantityGrams')
    expect(db.purchases).not.toHaveBeenCalled(); expect(db.movements).not.toHaveBeenCalled()
  })
  it('rejects duplicate names and foreign reference IDs before writing', async () => {
    db.one.mockImplementation(filter => query(filter.name ? { _id: id } : null))
    await expect(saveSupplier({ shop: 'shop', actor: 'actor', name: 'Supplier' })).rejects.toMatchObject({ statusCode: 409, code: 'SUPPLIER_ALREADY_EXISTS' })
    db.one.mockReturnValue(query(null))
    await expect(saveSupplier({ shop: 'shop', actor: 'actor', name: 'Supplier', regions: [region] })).rejects.toThrow('shop-owned regions')
    await expect(saveSupplier({ shop: 'shop', actor: 'actor', name: 'Supplier', products: [item] })).rejects.toThrow('shop-owned products')
    expect(db.create).not.toHaveBeenCalled()
  })
  it('edits and deactivates with revision checks without mutating financial history', async () => {
    db.one.mockImplementation(filter => query(filter.name ? null : { _id: id, name: 'Original', revision: 0, status: 'active' }))
    db.update.mockResolvedValue({ _id: id, status: 'inactive', revision: 1 })
    await saveSupplier({ shop: 'shop', actor: 'actor', supplierId: id, revision: 0, name: 'Renamed', status: 'inactive' })
    expect(db.update).toHaveBeenCalledWith(expect.objectContaining({ shop: 'shop', _id: id, $or: expect.any(Array) }), expect.objectContaining({ $inc: { revision: 1 }, $set: expect.objectContaining({ name: 'Renamed', status: 'inactive', updatedBy: 'actor' }) }), expect.objectContaining({ runValidators: true }))
    expect(db.purchases).not.toHaveBeenCalled(); expect(db.movements).not.toHaveBeenCalled()
    db.update.mockResolvedValue(null); db.one.mockImplementation(filter => query(filter.name ? null : { _id: id }))
    await expect(saveSupplier({ shop: 'shop', actor: 'actor', supplierId: id, revision: 1, name: 'Old edit' })).rejects.toMatchObject({ statusCode: 409 })
  })
  it('requires manager authorization before profile writes', async () => {
    db.manager.mockRejectedValue(new Error('Forbidden'))
    await expect(saveSupplier({ shop: 'shop', actor: 'staff', name: 'Supplier' })).rejects.toThrow('Forbidden')
    expect(db.create).not.toHaveBeenCalled()
  })
  it('scopes search, profile filters and purchase dates to the shop', async () => {
    db.find.mockReturnValue(query([{ _id: id, name: 'S' }]))
    db.purchases.mockReturnValue(query([{ supplier: id, quantityKg: 2, totalAmount: 100, status: 'received', businessDate: '2026-10-10' }]))
    const result = await listSuppliers({ shop: 'shop', search: 'S.*', region, product: item, status: 'active', from: '2026-10-01', to: '2026-10-17' })
    expect(db.find).toHaveBeenCalledWith(expect.objectContaining({ shop: 'shop', regions: region, products: item, status: 'active', $or: expect.any(Array) }))
    expect(db.find.mock.calls[0][0].$or[0].name.$regex).toBe('S\\.\\*')
    expect(db.purchases).toHaveBeenCalledWith({ shop: 'shop', supplier: { $in: [id] }, businessDate: { $gte: '2026-10-01', $lte: '2026-10-17' } })
    expect(result.suppliers[0].stats).toMatchObject({ quantityKg: 2, valuePkr: 100 })
    await expect(listSuppliers({ shop: 'shop', from: '2026-10-20', to: '2026-10-01' })).rejects.toThrow('End date')
  })
  it('calculates invoice totals and recorded payables while excluding voids', () => {
    expect(supplierStats([
      { quantityKg: 2, totalAmount: 100, receivingRegion: region, status: 'received', businessDate: '2026-10-10', payments: [{ amountPkr: 30 }] },
      { quantityKg: 3, totalAmount: 200, receivingRegion: region, status: 'pending', businessDate: '2026-10-11', payments: [] },
      { quantityKg: 99, totalAmount: 999, status: 'voided', businessDate: '2026-10-17' },
    ])).toEqual({ quantityKg: 5, valuePkr: 300, invoicedPkr: 300, unknownPayableCount: 0, paymentsPkr: 30, outstandingPkr: 270, count: 2, lastPurchase: '2026-10-11' })
  })
  it('loads purchase and receipt history by stable supplier ID within the same shop', async () => {
    db.one.mockReturnValue(query({ _id: id, name: 'Renamed' }))
    db.purchases.mockReturnValue(query([{ _id: 'purchase', supplier: id, supplierName: 'Original', quantityKg: 2, totalAmount: 100, status: 'received', businessDate: '2026-10-10' }]))
    const result = await supplierDetails({ shop: 'shop', supplierId: id })
    expect(db.one).toHaveBeenCalledWith({ shop: 'shop', _id: id })
    expect(db.purchases).toHaveBeenCalledWith({ shop: 'shop', supplier: id })
    expect(db.movements).toHaveBeenCalledWith(expect.objectContaining({ shop: 'shop', purchase: { $in: ['purchase'] } }))
    expect(result.purchases[0].supplierName).toBe('Original')
    db.one.mockReturnValue(query(null)); await expect(supplierDetails({ shop: 'other-shop', supplierId: id })).rejects.toMatchObject({ statusCode: 404 })
  })
})


it('keeps unrecorded legacy supplier balances unknown', () => {
  expect(supplierStats([{ status: 'received', quantityKg: 5, totalAmount: 999, businessDate: '2026-01-01' }])).toMatchObject({ quantityKg: 5, valuePkr: 999, invoicedPkr: 0, paymentsPkr: 0, outstandingPkr: 0, unknownPayableCount: 1 })
})

describe('supplier confirmed writes and replay safety (offline simulated MongoDB)', () => {
  let rows
  const input = { shop: 'shop', actor: 'actor', name: 'Tea Supplier', creationIdempotencyKey: 'supplier-request-1', productOfferings: [' Green   Tea ', 'Black Tea'] }
  beforeEach(() => {
    rows = []
    db.one.mockImplementation(filter => query(rows.find(row => row.shop === filter.shop && (filter.name ? new RegExp(filter.name.$regex, 'i').test(row.name) && (!filter._id?.$ne || row._id !== filter._id.$ne) : row._id === filter._id)) ?? null))
    db.create.mockImplementation(async ([row], options) => {
      expect(options.writeConcern).toEqual({ w: 'majority', wtimeout: 10000 })
      if (rows.some(prior => prior._id === row._id || prior.shop === row.shop && prior.name === row.name)) throw Object.assign(new Error('Private duplicate index'), { code: 11000 })
      rows.push(structuredClone(row)); return [row]
    })
  })
  it('normalizes offerings and returns a saved ID without internal replay fields or inventory writes', async () => {
    const result = await saveSupplier(input)
    expect(result).toMatchObject({ _id: supplierCreationId('shop', input.creationIdempotencyKey), productOfferings: ['Green Tea', 'Black Tea'] })
    expect(result).not.toHaveProperty('creationFingerprint'); expect(result).not.toHaveProperty('creationIdempotencyKey')
    expect(db.purchases).not.toHaveBeenCalled(); expect(db.movements).not.toHaveBeenCalled()
  })
  it('replays identical requests, rejects changed payloads, and scopes keys to the shop', async () => {
    const original = await saveSupplier(input)
    expect((await saveSupplier(input))._id).toBe(original._id)
    expect(db.create).toHaveBeenCalledOnce()
    await expect(saveSupplier({ ...input, name: 'Different' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 })
    const other = await saveSupplier({ ...input, shop: 'other-shop' })
    expect(other._id).not.toBe(original._id); expect(rows).toHaveLength(2)
  })
  it('accepts different supplier names with independent submission keys', async () => {
    await saveSupplier(input)
    for (const [index, name] of ['Tea Supplier East', 'Tea Supplier (Premium)', 'Tea Supplier+'].entries()) {
      expect((await saveSupplier({ ...input, name, creationIdempotencyKey: `independent-key-${index}` })).name).toBe(name)
    }
    expect(rows).toHaveLength(4)
  })
  it('permits correcting a rejected duplicate without treating its unused key as a stored operation', async () => {
    const original = await saveSupplier(input)
    const rejected = { ...input, creationIdempotencyKey: 'rejected-draft-key' }
    await expect(saveSupplier(rejected)).rejects.toMatchObject({ code: 'SUPPLIER_ALREADY_EXISTS' })
    const corrected = await saveSupplier({ ...rejected, name: 'Different Supplier' })
    expect(corrected._id).not.toBe(original._id)
    expect(corrected.name).toBe('Different Supplier')
    expect(rows).toHaveLength(2)
  })
  it('replays a request that commits between its initial replay read and name check', async () => {
    await saveSupplier(input)
    const committed = rows[0]
    rows = []
    const lookup = db.one.getMockImplementation()
    db.one.mockImplementation(filter => {
      if (filter.name && !rows.length) rows.push(committed)
      return lookup(filter)
    })
    db.create.mockClear()
    expect(await saveSupplier(input)).toMatchObject({ _id: committed._id, name: input.name })
    expect(rows).toHaveLength(1)
    expect(db.create).not.toHaveBeenCalled()
  })
  it('keeps changed payloads distinct from name duplicates in that same replay race', async () => {
    await saveSupplier(input)
    const committed = rows[0]
    rows = []
    const lookup = db.one.getMockImplementation()
    db.one.mockImplementation(filter => {
      if (filter.name && !rows.length) rows.push(committed)
      return lookup(filter)
    })
    db.create.mockClear()
    await expect(saveSupplier({ ...input, phone: '+923001234567' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 })
    expect(db.create).not.toHaveBeenCalled()
  })
  it('does not call a same-operation row a name duplicate before majority confirmation', async () => {
    db.one.mockImplementation(filter => query(filter.name ? { _id: supplierCreationId(input.shop, input.creationIdempotencyKey), shop: input.shop, name: input.name } : null))
    await expect(saveSupplier(input)).rejects.toMatchObject({ code: 'SUPPLIER_SAVE_FAILED', outcomeUncertain: true, statusCode: 503 })
    expect(db.create).not.toHaveBeenCalled()
  })
  it('returns a specific duplicate with an existing shop-owned supplier ID', async () => {
    const original = await saveSupplier(input)
    await expect(saveSupplier({ ...input, name: ' tea   supplier ', creationIdempotencyKey: 'another-request' })).rejects.toMatchObject({ code: 'SUPPLIER_ALREADY_EXISTS', existingSupplierId: original._id })
    expect(rows).toHaveLength(1)
  })
  it('handles concurrent same-key and same-name inserts without making duplicate records', async () => {
    const replay = await Promise.all([saveSupplier(input), saveSupplier(input)])
    expect(replay[0]._id).toBe(replay[1]._id); expect(rows).toHaveLength(1)
    rows = []; db.create.mockClear()
    const raced = await Promise.allSettled([saveSupplier(input), saveSupplier({ ...input, creationIdempotencyKey: 'other-request' })])
    expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(raced.find(result => result.status === 'rejected').reason).toMatchObject({ code: 'SUPPLIER_ALREADY_EXISTS' })
    expect(rows).toHaveLength(1)
  })
  it('marks lost write acknowledgement uncertain and reconciles with reads only', async () => {
    db.create.mockImplementationOnce(async ([row]) => { rows.push(row); throw Object.assign(new Error('Private write concern details'), { name: 'MongoWriteConcernError' }) })
    await expect(saveSupplier(input)).rejects.toMatchObject({ code: 'SUPPLIER_SAVE_FAILED', outcomeUncertain: true })
    const result = await reconcileSupplier({ shop: 'shop', creationIdempotencyKey: input.creationIdempotencyKey })
    expect(result).toMatchObject({ status: 'confirmed', supplier: { name: 'Tea Supplier' } })
    expect(db.create).toHaveBeenCalledOnce()
    expect(await reconcileSupplier({ shop: 'other-shop', creationIdempotencyKey: input.creationIdempotencyKey })).toEqual({ status: 'unconfirmed' })
    expect(db.create).toHaveBeenCalledOnce()
  })
  it('leaves absent writes unconfirmed and never retries them during reconciliation', async () => {
    db.create.mockRejectedValueOnce(Object.assign(new Error('Socket closed'), { name: 'MongoNetworkError' }))
    await expect(saveSupplier(input)).rejects.toMatchObject({ outcomeUncertain: true })
    expect(await reconcileSupplier({ shop: 'shop', creationIdempotencyKey: input.creationIdempotencyKey })).toEqual({ status: 'unconfirmed' })
    expect(db.create).toHaveBeenCalledOnce()
  })
  it('treats unknown-commit labels as uncertain rather than a definite failure', async () => {
    db.create.mockRejectedValueOnce(Object.assign(new Error('Unknown outcome'), { errorLabels: ['UnknownTransactionCommitResult'] }))
    await expect(saveSupplier(input)).rejects.toMatchObject({ code: 'SUPPLIER_SAVE_FAILED', outcomeUncertain: true })
    expect(db.create).toHaveBeenCalledOnce()
  })
  it('does not mislabel an unrelated duplicate index as a supplier-name duplicate', async () => {
    db.create.mockRejectedValueOnce(Object.assign(new Error('Private index and key values'), { code: 11000, keyPattern: { legacyCode: 1 } }))
    await expect(saveSupplier(input)).rejects.toMatchObject({ code: 'SUPPLIER_SAVE_FAILED', statusCode: 409 })
  })
  it('validates manual offerings without requiring catalog membership', async () => {
    for (const productOfferings of [['Green Tea', ' green   tea '], [''], ['x'.repeat(161)]]) {
      await expect(saveSupplier({ ...input, productOfferings })).rejects.toHaveProperty('name', 'ZodError')
    }
    expect(db.create).not.toHaveBeenCalled()
    expect((await saveSupplier({ ...input, productOfferings: ['Uncatalogued Special Blend'] })).productOfferings).toEqual(['Uncatalogued Special Blend'])
    expect(db.products).toHaveBeenCalledWith({ shop: 'shop', _id: { $in: [] } })
  })
})




describe('atomic supplier profile audit, simulated storage only', () => {
  let stored
  const base = { shop: 'shop', actor: 'actor', supplierId: id, revision: 0, name: 'Updated supplier', phone: '+923001234567' }
  beforeEach(() => {
    stored = { ...supplierInput.parse({ name: 'Original' }), _id: id, shop: 'shop', revision: 0 }
    db.one.mockImplementation(filter => query(filter.name || filter.shop !== stored.shop ? null : structuredClone(stored)))
    db.update.mockImplementation(async (filter, update) => {
      const expected = filter.revision ?? 0
      if (expected !== (stored.revision ?? 0)) return null
      stored = { ...stored, ...update.$set, revision: (stored.revision ?? 0) + 1, profileHistory: [...(stored.profileHistory ?? []), update.$push.profileHistory] }
      return structuredClone(stored)
    })
  })
  it('writes changed fields, previous/new values and operator in the same revision-guarded update', async () => {
    const result = await saveSupplier(base)
    expect(stored.profileHistory).toHaveLength(1)
    expect(stored.profileHistory[0]).toMatchObject({ action: 'edit', revision: 1, modifiedBy: 'actor', changes: expect.arrayContaining([{ field: 'name', previous: 'Original', next: 'Updated supplier' }]) })
    expect(stored.profileHistory[0].createdAt).toBeInstanceOf(Date)
    expect(result).not.toHaveProperty('profileHistory')
    expect(db.purchases).not.toHaveBeenCalled(); expect(db.movements).not.toHaveBeenCalled()
  })
  it('replays an identical old-revision edit without appending a second audit and rejects changed payloads', async () => {
    await saveSupplier(base); await saveSupplier(base)
    expect(db.update).toHaveBeenCalledOnce(); expect(stored.profileHistory).toHaveLength(1)
    await expect(saveSupplier({ ...base, name: 'Different' })).rejects.toMatchObject({ code: 'SUPPLIER_EDIT_CONFLICT', statusCode: 409 })
  })
  it('admits only one competing revision and retains the original audit entry on subsequent edits', async () => {
    const results = await Promise.allSettled([saveSupplier(base), saveSupplier({ ...base, name: 'Competitor' })])
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    const originalAudit = structuredClone(stored.profileHistory[0])
    await saveSupplier({ ...base, revision: 1, name: 'Later profile edit' })
    expect(stored.profileHistory).toHaveLength(2); expect(stored.profileHistory[0]).toEqual(originalAudit)
  })
  it('makes no profile change if the atomic audited update fails', async () => {
    const before = structuredClone(stored)
    db.update.mockRejectedValueOnce(new Error('Simulated atomic storage failure'))
    await expect(saveSupplier(base)).rejects.toThrow('storage failure')
    expect(stored).toEqual(before)
  })
  it('starts genuine history on the first edit of a legacy revision-less document', async () => {
    delete stored.revision
    await saveSupplier(base)
    expect(stored.profileHistory).toHaveLength(1); expect(stored.profileHistory[0].action).toBe('edit')
  })
  it('returns a foreign supplier as not found and does not write', async () => {
    await expect(saveSupplier({ ...base, shop: 'foreign' })).rejects.toMatchObject({ statusCode: 404 })
    expect(db.update).not.toHaveBeenCalled()
  })
})
