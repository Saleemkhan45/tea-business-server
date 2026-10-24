import { getDashboardSummary } from '../controllers/dashboardController.js'
import express from 'express'
import { recordSearchQuery, searchRecords } from '../services/globalSearchService.js'
import { createSale, getEntryOptions, getSalesSummary, getSale, listSales, mapSalesError, updateSale, voidSale } from '../controllers/salesController.js'
import { requireAuth } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { listSalesQuerySchema, saleBodySchema, saleParamSchema, updateSaleBodySchema, voidSaleBodySchema } from '../schemas/salesSchemas.js'
import { topProductsQuerySchema } from '../schemas/salesSchemas.js'
import { getTopProducts } from '../controllers/topProductsController.js'

export const salesRoutes = express.Router()

salesRoutes.use(requireAuth)
salesRoutes.get('/search', validate(recordSearchQuery, 'query'), async (req, res) => res.json(await searchRecords('sales', req.user.shopId, req.query)))

salesRoutes.get('/', validate(listSalesQuerySchema, 'query'), listSales)
salesRoutes.get('/entry-options', getEntryOptions)
salesRoutes.get('/summary', validate(listSalesQuerySchema, 'query'), getSalesSummary)
salesRoutes.get('/dashboard', validate(topProductsQuerySchema, 'query'), getDashboardSummary)
salesRoutes.get('/top-products', validate(topProductsQuerySchema, 'query'), getTopProducts)
salesRoutes.post('/', validate(saleBodySchema), createSale)
salesRoutes.get('/:saleId', validate(saleParamSchema, 'params'), getSale)
salesRoutes.patch('/:saleId', validate(saleParamSchema, 'params'), validate(updateSaleBodySchema), updateSale)
salesRoutes.patch('/:saleId/void', validate(saleParamSchema, 'params'), validate(voidSaleBodySchema), voidSale)

salesRoutes.use(mapSalesError)


