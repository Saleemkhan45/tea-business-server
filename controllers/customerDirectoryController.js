import * as customerDirectoryService from '../services/customerDirectoryService.js'
import { getBusinessDate } from '../utils/businessDay.js'

export async function createCustomer(req, res) {
  const customer = await customerDirectoryService.createCustomer({
    ...req.body,
    shop: req.user.shopId,
    createdBy: req.user.id,
    businessDate: getBusinessDate(),
  })
  res.status(201).json({ customer })
}

export async function getCustomerById(req, res) {
  const customer = await customerDirectoryService.getCustomerById({
    shop: req.user.shopId,
    customerId: req.params.customerId,
  })
  res.json({ customer })
}

export async function deleteCustomer(req, res) {
  const result = await customerDirectoryService.deleteCustomer({
    shop: req.user.shopId,
    customerId: req.params.customerId,
    role: req.user.role,
  })
  res.json(result)
}

export async function listCustomers(req, res) {
  const directory = await customerDirectoryService.listCustomers({
    shop: req.user.shopId,
    ...req.query,
  })
  res.json(directory)
}
