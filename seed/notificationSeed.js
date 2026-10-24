import jwt from 'jsonwebtoken'
import { connectDatabase, disconnectDatabase } from '../config/db.js'
import { env } from '../config/env.js'
import { Customer } from '../models/Customer.js'
import { CustomerPayment } from '../models/CustomerPayment.js'
import { Item } from '../models/Item.js'
import { Notification } from '../models/Notification.js'
import { NotificationRead } from '../models/NotificationRead.js'
import { NotificationSettings } from '../models/NotificationSettings.js'
import { Purchase } from '../models/Purchase.js'
import { Sale } from '../models/Sale.js'
import { Shop } from '../models/Shop.js'
import { Supplier } from '../models/Supplier.js'
import { User } from '../models/User.js'
import { evaluatePurchase, evaluateSales, evaluateStock, evaluateUnpaidCustomers } from '../services/notificationService.js'
import { getBusinessDate, previousBusinessDate } from '../utils/businessDay.js'

async function seedNotifications() {
  await connectDatabase()

  await Promise.all([
    Notification.deleteMany({}),
    NotificationRead.deleteMany({}),
    NotificationSettings.deleteMany({}),
    Purchase.deleteMany({}),
    Sale.deleteMany({}),
    CustomerPayment.deleteMany({}),
    Customer.deleteMany({}),
    Supplier.deleteMany({}),
    Item.deleteMany({}),
    User.deleteMany({}),
    Shop.deleteMany({}),
  ])

  const today = getBusinessDate()
  const yesterday = previousBusinessDate(today)
  const shop = await Shop.create({ name: 'Tea Business', status: 'active' })
  const owner = await User.create({ shop: shop._id, name: 'Admin', email: 'admin@teabusiness.local', role: 'owner', status: 'active' })
  const staff = await User.create({ shop: shop._id, name: 'Staff Member', email: 'staff@teabusiness.local', role: 'staff', status: 'active' })

  const [greenTea, blackTea] = await Item.create([
    { shop: shop._id, name: 'Green Tea', teaType: 'Green Tea', stockKg: 45, lowStockThreshold: 100 },
    { shop: shop._id, name: 'Black Tea', teaType: 'Black Tea', stockKg: 620, lowStockThreshold: 120 },
  ])

  const supplier = await Supplier.create({ shop: shop._id, name: 'Ali Traders', phone: '+923001234567', status: 'active' })
  const purchase = await Purchase.create({
    shop: shop._id,
    supplier: supplier._id,
    item: blackTea._id,
    businessDate: today,
    quantityKg: 500,
    totalAmount: 240000,
    status: 'received',
  })

  await Sale.create([
    { shop: shop._id, businessDate: yesterday, totalAmount: 275000, status: 'completed' },
    { shop: shop._id, businessDate: today, totalAmount: 325000, status: 'completed' },
  ])

  const customer = await Customer.create({ shop: shop._id, name: 'Haji Rashid', phone: '+923331112222', balanceDue: 412000, status: 'active' })
  let oldPaymentDate = today
  for (let index = 0; index < 9; index += 1) oldPaymentDate = previousBusinessDate(oldPaymentDate)
  await CustomerPayment.create({ shop: shop._id, customer: customer._id, businessDate: oldPaymentDate, amount: 25000 })

  await NotificationSettings.create([
    { user: owner._id, soundEnabled: true, noPaymentCutoffTime: '18:00' },
    { user: staff._id, soundEnabled: false, noPaymentCutoffTime: '18:00' },
  ])

  await evaluateStock(greenTea._id)
  await evaluatePurchase(purchase)
  await evaluateSales({ shopId: shop._id })
  await evaluateUnpaidCustomers({ shopId: shop._id })

  const ownerToken = jwt.sign({ sub: String(owner._id), shopId: String(shop._id), role: owner.role }, env.jwtSecret, { expiresIn: '8h' })
  console.log('Notification seed complete.')
  console.log(`Owner email: ${owner.email}`)
  console.log(`Demo JWT: ${ownerToken}`)

  await disconnectDatabase()
}

seedNotifications().catch(async error => {
  console.error(error)
  await disconnectDatabase()
  process.exit(1)
})
