import { connectDatabase, disconnectDatabase } from '../config/db.js'
import { Customer } from '../models/Customer.js'
import { CustomerPayment } from '../models/CustomerPayment.js'
import { Item } from '../models/Item.js'
import { Purchase } from '../models/Purchase.js'
import { Sale } from '../models/Sale.js'
import { Shop } from '../models/Shop.js'
import { Supplier } from '../models/Supplier.js'
import { evaluatePurchase, evaluateSales, evaluateStock, evaluateUnpaidCustomers } from '../services/notificationService.js'
import { getBusinessDate, previousBusinessDate } from '../utils/businessDay.js'

async function trigger(type) {
  await connectDatabase()
  const shop = await Shop.findOne({ status: 'active' })
  if (!shop) throw new Error('Run npm run seed:notifications first.')

  const today = getBusinessDate()

  if (type === 'low-stock') {
    const item = await Item.findOne({ shop: shop._id, status: 'active' }).sort({ name: 1 })
    item.stockKg = Math.max(0, Math.min(item.stockKg, item.lowStockThreshold))
    item.lowStockAlertActive = false
    await item.save()
    await evaluateStock(item._id)
  } else if (type === 'purchase') {
    const item = await Item.findOne({ shop: shop._id, status: 'active' })
    const supplier = await Supplier.findOne({ shop: shop._id, status: 'active' })
    const purchase = await Purchase.create({ shop: shop._id, item: item._id, supplier: supplier._id, businessDate: today, quantityKg: 125, totalAmount: 76000, status: 'received' })
    await evaluatePurchase(purchase)
  } else if (type === 'sales-up') {
    const yesterday = previousBusinessDate(today)
    await Sale.create({ shop: shop._id, businessDate: yesterday, totalAmount: 100000, status: 'completed' })
    await Sale.create({ shop: shop._id, businessDate: today, totalAmount: 500000, status: 'completed' })
    await evaluateSales({ shopId: shop._id })
  } else if (type === 'no-payment') {
    const customer = await Customer.findOne({ shop: shop._id, balanceDue: { $gt: 0 }, status: 'active' })
    if (!customer) throw new Error('No unpaid customer found.')
    await CustomerPayment.deleteMany({ shop: shop._id, customer: customer._id, businessDate: today })
    await evaluateUnpaidCustomers({ shopId: shop._id })
  } else {
    throw new Error('Use one of: low-stock, purchase, sales-up, no-payment')
  }

  console.log(`Triggered ${type}.`)
  await disconnectDatabase()
}

trigger(process.argv[2]).catch(async error => {
  console.error(error.message)
  await disconnectDatabase()
  process.exit(1)
})
