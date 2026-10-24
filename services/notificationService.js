import mongoose from 'mongoose'
import { Customer } from '../models/Customer.js'
import { CustomerPayment } from '../models/CustomerPayment.js'
import { CollectionSchedule } from '../models/CollectionSchedule.js'
import { DEFAULT_NOTIFICATION_ENABLED, NotificationSettings } from '../models/NotificationSettings.js'
import { Item } from '../models/Item.js'
import { Notification } from '../models/Notification.js'
import { Purchase } from '../models/Purchase.js'
import { Sale } from '../models/Sale.js'
import { Shop } from '../models/Shop.js'
import { User } from '../models/User.js'
import { createWhatsAppUrl, formatCompactPkr, formatPkr } from '../utils/format.js'
import { daysBetweenBusinessDates, getBusinessDate, previousBusinessDate } from '../utils/businessDay.js'

let emitNotification = null

function toObjectId(value) {
  return typeof value === 'string' ? new mongoose.Types.ObjectId(value) : value
}

function isDuplicateKeyError(error) {
  return error?.code === 11000
}

function normalizeEnabled(settings) {
  const saved = settings?.enabled instanceof Map ? Object.fromEntries(settings.enabled) : settings?.enabled ?? {}
  return { ...DEFAULT_NOTIFICATION_ENABLED, ...saved }
}

function isTypeEnabled(settings, type, now = new Date()) {
  if (settings?.muteUntil && settings.muteUntil > now) return false
  return normalizeEnabled(settings)[type] !== false
}

async function getRecipients(notification) {
  const users = await User.find({ shop: notification.shop, status: 'active' }).select('_id shop').lean()
  if (users.length === 0) return []

  const settings = await NotificationSettings.find({ user: { $in: users.map(user => user._id) } }).lean()
  const settingsByUser = new Map(settings.map(setting => [String(setting.user), setting]))
  return users.filter(user => isTypeEnabled(settingsByUser.get(String(user._id)), notification.type)).map(user => String(user._id))
}

async function notifyRealtime(notification) {
  if (!emitNotification) return
  const recipients = await getRecipients(notification)
  emitNotification(notification, recipients)
}

async function sumSales(shopId, businessDate) {
  const result = await Sale.aggregate([
    { $match: { shop: toObjectId(shopId), businessDate, status: { $ne: 'voided' } } },
    { $group: { _id: null, total: { $sum: '$totalAmount' } } },
  ])

  return result[0]?.total ?? 0
}

export function registerNotificationEmitter(emitter) {
  emitNotification = emitter
}

export async function create(payload) {
  try {
    const notification = await Notification.create(payload)
    await notifyRealtime(notification.toObject())
    return notification
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return Notification.findOne({ dedupeKey: payload.dedupeKey })
    }
    throw error
  }
}

export async function evaluateStock(itemId) {
  const item = await Item.findById(itemId)
  if (!item || item.status !== 'active') return null

  if (item.stockKg > item.lowStockThreshold) {
    if (item.lowStockAlertActive) {
      item.lowStockAlertActive = false
      await item.save()
    }
    return null
  }

  if (item.lowStockAlertActive) return null

  item.lowStockAlertActive = true
  item.lowStockAlertCycle += 1
  await item.save()

  const businessDate = getBusinessDate()
  const severity = item.stockKg <= 0 ? 'danger' : 'warning'
  return create({
    shop: item.shop,
    type: 'LOW_STOCK',
    severity,
    title: item.stockKg <= 0 ? `${item.name} is out of stock` : `${item.name} is low`,
    message: `${item.name} is low: ${item.stockKg.toLocaleString('en-PK')} kg left (limit ${item.lowStockThreshold.toLocaleString('en-PK')} kg).`,
    entityType: 'Item',
    entityId: item._id,
    meta: {
      itemName: item.name,
      stockKg: item.stockKg,
      thresholdKg: item.lowStockThreshold,
      businessDate,
    },
    dedupeKey: `LOW_STOCK:${item._id}:${businessDate}:${item.lowStockAlertCycle}`,
  })
}

export async function evaluatePurchase(purchaseInput) {
  const purchaseId = purchaseInput?._id ?? purchaseInput?.id ?? purchaseInput
  const purchase = await Purchase.findById(purchaseId).populate('item supplier')
  if (!purchase || purchase.status === 'voided') return null

  const itemName = purchase.item?.name ?? 'Tea item'
  const supplierName = purchase.supplier?.name ?? 'Supplier'
  return create({
    shop: purchase.shop,
    type: 'PURCHASE_ADDED',
    severity: 'info',
    title: 'Purchase added',
    message: `Purchase added: ${purchase.quantityKg.toLocaleString('en-PK')} kg ${itemName} from ${supplierName}, ${formatPkr(purchase.totalAmount)}.`,
    entityType: 'Purchase',
    entityId: purchase._id,
    meta: {
      purchaseId: String(purchase._id),
      supplierName,
      itemName,
      quantityKg: purchase.quantityKg,
      totalAmount: purchase.totalAmount,
      businessDate: purchase.businessDate,
    },
    dedupeKey: `PURCHASE_ADDED:${purchase._id}`,
  })
}

export async function evaluateSales(options = {}) {
  const today = getBusinessDate()
  const yesterday = previousBusinessDate(today)
  const shops = options.shopId
    ? [{ _id: toObjectId(options.shopId) }]
    : await Shop.find({ status: 'active' }).select('_id').lean()

  const notifications = []
  for (const shop of shops) {
    const todayTotal = await sumSales(shop._id, today)
    const yesterdayTotal = await sumSales(shop._id, yesterday)
    if (todayTotal <= yesterdayTotal || todayTotal <= 0) continue

    const increasePercent = yesterdayTotal > 0 ? Math.round(((todayTotal - yesterdayTotal) / yesterdayTotal) * 100) : 100
    const notification = await create({
      shop: shop._id,
      type: 'SALES_UP',
      severity: 'success',
      title: "Today's sales are up",
      message: `Today's sales ${formatCompactPkr(todayTotal)}, up ${increasePercent}% from yesterday.`,
      entityType: 'Sale',
      entityId: shop._id,
      meta: {
        todayTotal,
        yesterdayTotal,
        increasePercent,
        businessDate: today,
      },
      dedupeKey: `SALES_UP:${shop._id}:${today}`,
    })
    if (notification) notifications.push(notification)
  }

  return notifications
}

export async function evaluateUnpaidCustomers(options = {}) {
  const today = getBusinessDate()
  let shopIds = options.shopId ? [toObjectId(options.shopId)] : null

  if (!shopIds && options.cutoffTime) {
    const dueSettings = await NotificationSettings.find({ noPaymentCutoffTime: options.cutoffTime }).populate('user', 'shop status').lean()
    shopIds = [...new Set(dueSettings.filter(setting => setting.user?.status === 'active').map(setting => String(setting.user.shop)))]
  }

  if (!shopIds) {
    shopIds = (await Shop.find({ status: 'active' }).select('_id').lean()).map(shop => shop._id)
  }

  const notifications = []
  for (const shopId of shopIds) {
    const scheduled = await CollectionSchedule.find({ shop: shopId }).select('customer').lean()
    const customers = await Customer.find({ shop: shopId, _id: { $nin: scheduled.map(row => row.customer) }, balanceDue: { $gt: 0 }, status: 'active' }).lean()
    for (const customer of customers) {
      const paidToday = await CustomerPayment.exists({ shop: shopId, customer: customer._id, businessDate: today, amount: { $gt: 0 } })
      if (paidToday) continue

      const lastPayment = await CustomerPayment.findOne({ shop: shopId, customer: customer._id, amount: { $gt: 0 } }).sort({ businessDate: -1 }).lean()
      const idleDays = daysBetweenBusinessDates(lastPayment?.businessDate, today)
      const severity = idleDays !== null && idleDays >= 7 ? 'danger' : 'warning'
      const reminderText = `${customer.name} has not paid today. Balance due ${formatPkr(customer.balanceDue)}.`
      const notification = await create({
        shop: shopId,
        type: 'NO_PAYMENT_TODAY',
        severity,
        title: `${customer.name} has not paid today`,
        message: `${reminderText} Last payment ${idleDays ?? 'not recorded'} ${idleDays === 1 ? 'day' : 'days'} ago.`,
        entityType: 'Customer',
        entityId: customer._id,
        meta: {
          customerName: customer.name,
          phone: customer.phone,
          balanceDue: customer.balanceDue,
          lastPaymentBusinessDate: lastPayment?.businessDate ?? null,
          idleDays,
          businessDate: today,
          whatsAppUrl: createWhatsAppUrl(customer.phone, `${reminderText} Please clear or update your payment when possible.`),
        },
        dedupeKey: `NO_PAYMENT:${customer._id}:${today}`,
      })
      if (notification) notifications.push(notification)
    }
  }

  return notifications
}

export async function evaluate(event) {
  if (!event?.type) return null
  if (event.type === 'stock') return evaluateStock(event.itemId)
  if (event.type === 'purchase') return evaluatePurchase(event.purchase)
  if (event.type === 'sales') return evaluateSales(event)
  if (event.type === 'unpaid-customers') return evaluateUnpaidCustomers(event)
  throw new Error(`Unsupported notification evaluation type: ${event.type}`)
}
