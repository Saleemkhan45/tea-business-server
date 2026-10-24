import express from 'express'
import rateLimit from 'express-rate-limit'
import {
  getSettings,
  getUnreadCount,
  idParamSchema,
  listNotifications,
  listNotificationsQuerySchema,
  markAllNotificationsRead,
  markNotificationRead,
  updateSettings,
  updateSettingsSchema,
} from '../controllers/notificationController.js'
import { requireAuth } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { reminderRoutes } from '../reminders/routes.js'

const notificationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => ['GET', 'HEAD', 'OPTIONS'].includes(req.method),
})

export const notificationRoutes = express.Router()

notificationRoutes.use(notificationLimiter)
notificationRoutes.use(requireAuth)
notificationRoutes.use('/collections', reminderRoutes)

notificationRoutes.get('/', validate(listNotificationsQuerySchema, 'query'), listNotifications)
notificationRoutes.get('/unread-count', getUnreadCount)
notificationRoutes.patch('/read-all', markAllNotificationsRead)
notificationRoutes.get('/settings', getSettings)
notificationRoutes.put('/settings', validate(updateSettingsSchema), updateSettings)
notificationRoutes.patch('/:id/read', validate(idParamSchema, 'params'), markNotificationRead)
