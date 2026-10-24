import mongoose from 'mongoose'
import { refreshCollectionNotifications } from '../services/collectionNotifications.js'
import { z } from 'zod'
import { Item } from '../models/Item.js'
import { NOTIFICATION_TYPES, Notification } from '../models/Notification.js'
import { NotificationRead } from '../models/NotificationRead.js'
import { DEFAULT_NOTIFICATION_ENABLED, NotificationSettings } from '../models/NotificationSettings.js'

export const listNotificationsQuerySchema = z.object({
  unread: z.enum(['true', 'false']).optional(),
  type: z.enum(NOTIFICATION_TYPES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
})

export const idParamSchema = z.object({
  id: z.string().refine(value => mongoose.Types.ObjectId.isValid(value), 'Invalid notification id.'),
})

const enabledSettingsSchema = z.object({
  WHATSAPP_MESSAGE: z.boolean().optional(),
  KHATA_COLLECTION: z.boolean().optional(),
  LOW_STOCK: z.boolean().optional(),
  PURCHASE_ADDED: z.boolean().optional(),
  SALES_UP: z.boolean().optional(),
  NO_PAYMENT_TODAY: z.boolean().optional(),
})

export const updateSettingsSchema = z.object({
  enabled: enabledSettingsSchema.optional(),
  lowStockThresholds: z.array(z.object({
    itemId: z.string().refine(value => mongoose.Types.ObjectId.isValid(value), 'Invalid item id.'),
    threshold: z.coerce.number().min(0).max(1000000),
  })).optional(),
  noPaymentCutoffTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  muteUntil: z.union([z.string().datetime(), z.null()]).optional(),
  soundEnabled: z.boolean().optional(),
})

function normalizeEnabled(settings) {
  const saved = settings?.enabled instanceof Map ? Object.fromEntries(settings.enabled) : settings?.enabled ?? {}
  return { ...DEFAULT_NOTIFICATION_ENABLED, ...saved }
}

async function getSettingsForUser(userId) {
  return NotificationSettings.findOneAndUpdate(
    { user: userId },
    { $setOnInsert: { user: userId, enabled: DEFAULT_NOTIFICATION_ENABLED } },
    { new: true, upsert: true },
  )
}

async function getReadNotificationIds(userId) {
  const reads = await NotificationRead.find({ user: userId }).select('notification').lean()
  return reads.map(read => read.notification)
}

async function serializeNotifications(notifications, userId) {
  const readRows = await NotificationRead.find({ user: userId, notification: { $in: notifications.map(notification => notification._id) } }).lean()
  const readIds = new Set(readRows.map(read => String(read.notification)))
  return notifications.map(notification => ({
    id: String(notification._id),
    type: notification.type,
    severity: notification.severity,
    title: notification.title,
    message: notification.message,
    entityType: notification.entityType,
    entityId: String(notification.entityId),
    meta: notification.meta ?? {},
    dedupeKey: notification.dedupeKey,
    createdAt: notification.createdAt,
    read: readIds.has(String(notification._id)),
  }))
}

export async function listNotifications(req, res, next) {
  try {
    await refreshCollectionNotifications(req.user.shopId)
    const { unread, type, page, limit } = req.query
    const settings = await getSettingsForUser(req.user.id)
    const enabled = normalizeEnabled(settings)
    const enabledTypes = NOTIFICATION_TYPES.filter(notificationType => enabled[notificationType] !== false)
    const readIds = unread === 'true' ? await getReadNotificationIds(req.user.id) : []
    const query = {
      'meta.resolved': { $ne: true },
      shop: req.user.shopId,
      type: { $in: type ? [type] : enabledTypes },
      ...(unread === 'true' ? { _id: { $nin: readIds } } : {}),
    }

    const skip = (page - 1) * limit
    const [notifications, total] = await Promise.all([
      Notification.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Notification.countDocuments(query),
    ])

    res.json({
      data: await serializeNotifications(notifications, req.user.id),
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    })
  } catch (error) {
    next(error)
  }
}

export async function getUnreadCount(req, res, next) {
  try {
    await refreshCollectionNotifications(req.user.shopId)
    const settings = await getSettingsForUser(req.user.id)
    const enabled = normalizeEnabled(settings)
    const enabledTypes = NOTIFICATION_TYPES.filter(notificationType => enabled[notificationType] !== false)
    const readIds = await getReadNotificationIds(req.user.id)
    const count = await Notification.countDocuments({
      'meta.resolved': { $ne: true },
      shop: req.user.shopId,
      type: { $in: enabledTypes },
      _id: { $nin: readIds },
    })

    res.json({ count })
  } catch (error) {
    next(error)
  }
}

export async function markNotificationRead(req, res, next) {
  try {
    const notification = await Notification.findOne({ _id: req.params.id, shop: req.user.shopId }).lean()
    if (!notification) return res.status(404).json({ message: 'Notification not found.' })

    await NotificationRead.updateOne(
      { user: req.user.id, notification: notification._id },
      { $setOnInsert: { user: req.user.id, notification: notification._id, readAt: new Date() } },
      { upsert: true },
    )

    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
}

export async function markAllNotificationsRead(req, res, next) {
  try {
    const notifications = await Notification.find({ shop: req.user.shopId }).select('_id').lean()
    if (notifications.length > 0) {
      await NotificationRead.bulkWrite(notifications.map(notification => ({
        updateOne: {
          filter: { user: req.user.id, notification: notification._id },
          update: { $setOnInsert: { user: req.user.id, notification: notification._id, readAt: new Date() } },
          upsert: true,
        },
      })), { ordered: false })
    }

    res.json({ ok: true, marked: notifications.length })
  } catch (error) {
    next(error)
  }
}

export async function getSettings(req, res, next) {
  try {
    const settings = await getSettingsForUser(req.user.id)
    const items = await Item.find({ shop: req.user.shopId, status: 'active' }).sort({ name: 1 }).lean()
    res.json({
      enabled: normalizeEnabled(settings),
      noPaymentCutoffTime: settings.noPaymentCutoffTime,
      muteUntil: settings.muteUntil,
      soundEnabled: settings.soundEnabled,
      lowStockThresholds: items.map(item => ({
        itemId: String(item._id),
        itemName: item.name,
        stockKg: item.stockKg,
        threshold: item.lowStockThreshold,
      })),
    })
  } catch (error) {
    next(error)
  }
}

export async function updateSettings(req, res, next) {
  try {
    const current = await getSettingsForUser(req.user.id)
    const enabled = { ...normalizeEnabled(current), ...(req.body.enabled ?? {}) }
    const update = {
      enabled,
      ...(req.body.noPaymentCutoffTime ? { noPaymentCutoffTime: req.body.noPaymentCutoffTime } : {}),
      ...(typeof req.body.soundEnabled === 'boolean' ? { soundEnabled: req.body.soundEnabled } : {}),
      ...(Object.prototype.hasOwnProperty.call(req.body, 'muteUntil') ? { muteUntil: req.body.muteUntil ? new Date(req.body.muteUntil) : null } : {}),
    }

    if (req.body.lowStockThresholds) {
      update.lowStockThresholds = req.body.lowStockThresholds.map(item => ({
        item: item.itemId,
        threshold: item.threshold,
      }))

      await Promise.all(req.body.lowStockThresholds.map(item => Item.updateOne(
        { _id: item.itemId, shop: req.user.shopId },
        { $set: { lowStockThreshold: item.threshold } },
      )))
    }

    await NotificationSettings.updateOne({ user: req.user.id }, { $set: update }, { upsert: true })
    return getSettings(req, res, next)
  } catch (error) {
    next(error)
  }
}
