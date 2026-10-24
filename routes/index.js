import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { collectionRoutes } from './collectionRoutes.js'
import { customerLedgerRoutes } from './customerLedgerRoutes.js'
import { authRoutes } from './authRoutes.js'
import { notificationRoutes } from './notificationRoutes.js'
import { salesRoutes } from './salesRoutes.js'
import { regionalInventoryRoutes } from './regionalInventoryRoutes.js'
import { purchaseRoutes } from './purchaseRoutes.js'
import { whatsappRoutes } from '../whatsapp/routes.js'
import { manualCashRoutes } from '../manual-cashbook/routes.js'

export const apiRoutes = express.Router()
apiRoutes.use(rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false, skip: req => ['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path.startsWith('/auth/'), message: { message: 'Too many changes in a short time. Wait before retrying.' } }))

apiRoutes.get('/health', (req, res) => {
  res.json({ ok: true, service: 'tea-business-api', uptimeSeconds: Math.floor(process.uptime()) })
})

apiRoutes.use('/auth', authRoutes)
apiRoutes.use('/customers', customerLedgerRoutes)
apiRoutes.use('/collections', collectionRoutes)
apiRoutes.use('/sales', salesRoutes)
apiRoutes.use('/regional', regionalInventoryRoutes)
apiRoutes.use('/purchases', purchaseRoutes)
apiRoutes.use('/notifications', notificationRoutes)
apiRoutes.use('/whatsapp', whatsappRoutes)
apiRoutes.use('/cashbook', manualCashRoutes)
