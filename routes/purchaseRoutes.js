import express from 'express'
import { validate } from '../middleware/validate.js'
import { recordSearchQuery, searchRecords } from '../services/globalSearchService.js'
import { requireAuth } from '../middleware/auth.js'
import * as purchases from '../services/purchaseService.js'
import * as suppliers from '../services/supplierService.js'
import { profileQuery, supplierHistory, supplierProfile } from '../services/supplierProfileService.js'
import { mapSupplierError } from '../utils/supplierErrors.js'

export const purchaseRoutes = express.Router()
purchaseRoutes.use(requireAuth)
purchaseRoutes.get('/search', validate(recordSearchQuery, 'query'), async (req, res) => res.json(await searchRecords('purchases', req.user.shopId, req.query)))
const scope = req => ({ shop: req.user.shopId, actor: req.user.id })
purchaseRoutes.get('/options', async (req, res) => res.json(await purchases.purchaseOptions(req.user.shopId)))
const supplierRoutes = express.Router()
supplierRoutes.get('/', async (req, res) => res.json(await suppliers.listSuppliers({ ...req.query, ...scope(req) })))
supplierRoutes.post('/', async (req, res) => res.status(201).json({ supplier: await suppliers.saveSupplier({ ...req.body, supplierId: undefined, ...scope(req) }) }))
supplierRoutes.get('/reconcile', async (req, res) => res.json(await suppliers.reconcileSupplier({ creationIdempotencyKey: req.query.creationIdempotencyKey, ...scope(req) })))
supplierRoutes.get('/:supplierId/profile', validate(profileQuery, 'query'), async (req, res) => res.json(await supplierProfile({ ...req.query, supplierId: req.params.supplierId, shop: req.user.shopId })))
supplierRoutes.get('/:supplierId/history', validate(profileQuery, 'query'), async (req, res) => res.json(await supplierHistory({ ...req.query, supplierId: req.params.supplierId, shop: req.user.shopId })))
supplierRoutes.get('/:supplierId', async (req, res) => res.json(await suppliers.supplierDetails({ from: req.query.from, to: req.query.to, supplierId: req.params.supplierId, ...scope(req) })))
supplierRoutes.patch('/:supplierId', async (req, res) => res.json({ supplier: await suppliers.saveSupplier({ ...req.body, supplierId: req.params.supplierId, ...scope(req) }) }))
supplierRoutes.use(mapSupplierError)
purchaseRoutes.use('/suppliers', supplierRoutes)
purchaseRoutes.get('/', async (req, res) => res.json({ purchases: await purchases.listPurchases({ ...scope(req), regionId: req.query.regionId, from: req.query.from, to: req.query.to }) }))
purchaseRoutes.post('/', async (req, res) => res.status(201).json({ purchase: await purchases.createPurchase({ ...req.body, ...scope(req) }) }))
purchaseRoutes.post('/:purchaseId/receive', async (req, res) => res.json({ purchase: await purchases.receivePurchase({ purchaseId: req.params.purchaseId, ...scope(req) }) }))
purchaseRoutes.post('/:purchaseId/payments', async (req, res) => res.status(201).json({ purchase: await purchases.payPurchase({ ...req.body, purchaseId: req.params.purchaseId, ...scope(req) }) }))
purchaseRoutes.post('/:purchaseId/void', async (req, res) => res.json({ purchase: await purchases.voidPurchase({ reason: req.body.reason, purchaseId: req.params.purchaseId, ...scope(req) }) }))
purchaseRoutes.use((error, req, res, next) => {
  if (error.name === 'ZodError') return res.status(400).json({ message: 'Invalid purchase input.', issues: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) })
  if (error.statusCode) return res.status(error.statusCode).json({ message: error.message })
  if (error.code === 11000) return res.status(409).json({ message: 'This purchase operation already exists.' })
  if (error.name === 'ValidationError' || error.name === 'CastError') return res.status(400).json({ message: 'Invalid purchase input.' })
  next(error)
})
