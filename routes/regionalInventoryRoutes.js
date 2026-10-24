import express from 'express'
import { requireAuth } from '../middleware/auth.js'
import * as inventory from '../services/regionalInventoryService.js'
import * as reports from '../services/regionalReportService.js'
import { ITEM_TEA_TYPES } from '../constants/teaCategories.js'

export const regionalInventoryRoutes = express.Router()
regionalInventoryRoutes.use(requireAuth)
const scope = req => ({ shop: req.user.shopId, actor: req.user.id })
regionalInventoryRoutes.get('/regions', async (req, res) => res.json({ regions: await inventory.listRegions(req.user.shopId) }))
regionalInventoryRoutes.get('/overview', async (req, res) => res.json(await reports.regionalOverview({ ...scope(req), from: req.query.from, to: req.query.to })))
regionalInventoryRoutes.post('/regions', async (req, res) => res.status(201).json({ region: await inventory.createRegion({ ...req.body, ...scope(req) }) }))
regionalInventoryRoutes.patch('/regions/:regionId', async (req, res) => res.json({ region: await inventory.updateRegion({ ...req.body, regionId: req.params.regionId, ...scope(req) }) }))
regionalInventoryRoutes.get('/regions/:regionId/report', async (req, res) => res.json(await reports.regionReport({ ...scope(req), regionId: req.params.regionId, from: req.query.from, to: req.query.to, itemId: req.query.itemId })))
regionalInventoryRoutes.get('/products', async (req, res) => res.json({ products: await inventory.listProducts(req.user.shopId) }))
regionalInventoryRoutes.get('/product-options', (req, res) => res.json({ categories: ITEM_TEA_TYPES }))
regionalInventoryRoutes.post('/products', async (req, res) => res.status(201).json({ product: await inventory.createProduct({ ...req.body, ...scope(req) }) }))
regionalInventoryRoutes.get('/inventory', async (req, res) => res.json({ inventory: await inventory.listInventory({ regionId: req.query.regionId, search: req.query.search, availability: req.query.availability, ...scope(req) }) }))
regionalInventoryRoutes.post('/regions/:regionId/products', async (req, res) => res.status(201).json({ stock: await inventory.assignProduct({ itemId: req.body.itemId, regionId: req.params.regionId, ...scope(req) }) }))
regionalInventoryRoutes.delete('/regions/:regionId/products/:itemId', async (req, res) => res.json(await inventory.removeUnusedAssignment({ regionId: req.params.regionId, itemId: req.params.itemId, ...scope(req) })))
regionalInventoryRoutes.patch('/regions/:regionId/products/:itemId', async (req, res) => res.json(await inventory.updateRegionalSettings({ ...req.body, regionId: req.params.regionId, itemId: req.params.itemId, ...scope(req) })))
regionalInventoryRoutes.get('/regions/:regionId/history', async (req, res) => res.json(await inventory.regionHistory({ regionId: req.params.regionId, ...scope(req) })))
regionalInventoryRoutes.post('/stock-operations', async (req, res) => res.status(201).json({ operation: await inventory.recordStockOperation({ ...req.body, ...scope(req) }) }))
regionalInventoryRoutes.use((error, req, res, next) => {
  if (error.name === 'ZodError') return res.status(400).json({ message: 'Invalid regional input.', issues: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) })
  if (error.statusCode) return res.status(error.statusCode).json({ message: error.message })
  if (error.code === 11000) return res.status(409).json({ message: 'This name or stock assignment already exists.' })
  if (error.name === 'ValidationError' || error.name === 'CastError') return res.status(400).json({ message: 'Invalid regional inventory input.' })
  next(error)
})
