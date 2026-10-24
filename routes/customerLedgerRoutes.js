import express from 'express'
import { createCustomer, getCustomerById, listCustomers } from '../controllers/customerDirectoryController.js'
import {
  createAdjustment,
  createOpeningBalance,
  createPayment,
  createPurchase,
  getDailyPayments,
  getLedger,
  getPaymentCalendar,
  getPaymentInsights,
  getReminderCandidate,
  getSummary,
  mapCustomerLedgerError,
  voidTransaction,
} from '../controllers/customerLedgerController.js'
import { requireAuth } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import {
  adjustmentBodySchema,
  customerDirectoryQuerySchema,
  customerBodySchema,
  customerParamsSchema,
  dailyPaymentsQuerySchema,
  ledgerQuerySchema,
  openingBalanceBodySchema,
  paymentBodySchema,
  paymentCalendarQuerySchema,
  paymentInsightsQuerySchema,
  purchaseBodySchema,
  reminderCandidateQuerySchema,
  summaryQuerySchema,
  transactionParamsSchema,
  voidBodySchema,
} from '../schemas/customerLedgerSchemas.js'

export const customerLedgerRoutes = express.Router()

customerLedgerRoutes.use(requireAuth)

customerLedgerRoutes.get('/', validate(customerDirectoryQuerySchema, 'query'), listCustomers)
customerLedgerRoutes.post('/', validate(customerBodySchema), createCustomer)
customerLedgerRoutes.get('/:customerId', validate(customerParamsSchema, 'params'), getCustomerById)
customerLedgerRoutes.get('/:customerId/ledger',
  validate(customerParamsSchema, 'params'), validate(ledgerQuerySchema, 'query'), getLedger)
customerLedgerRoutes.get('/:customerId/summary',
  validate(customerParamsSchema, 'params'), validate(summaryQuerySchema, 'query'), getSummary)
customerLedgerRoutes.get('/:customerId/daily-payments',
  validate(customerParamsSchema, 'params'), validate(dailyPaymentsQuerySchema, 'query'), getDailyPayments)
customerLedgerRoutes.get('/:customerId/payment-insights',
  validate(customerParamsSchema, 'params'), validate(paymentInsightsQuerySchema, 'query'), getPaymentInsights)
customerLedgerRoutes.get('/:customerId/payment-calendar',
  validate(customerParamsSchema, 'params'), validate(paymentCalendarQuerySchema, 'query'), getPaymentCalendar)
customerLedgerRoutes.get('/:customerId/reminder-candidate',
  validate(customerParamsSchema, 'params'), validate(reminderCandidateQuerySchema, 'query'), getReminderCandidate)

customerLedgerRoutes.post('/:customerId/purchases',
  validate(customerParamsSchema, 'params'), validate(purchaseBodySchema), createPurchase)
customerLedgerRoutes.post('/:customerId/payments',
  validate(customerParamsSchema, 'params'), validate(paymentBodySchema), createPayment)
customerLedgerRoutes.post('/:customerId/opening-balance',
  validate(customerParamsSchema, 'params'), validate(openingBalanceBodySchema), createOpeningBalance)
customerLedgerRoutes.post('/:customerId/adjustments',
  validate(customerParamsSchema, 'params'), validate(adjustmentBodySchema), createAdjustment)
customerLedgerRoutes.patch('/:customerId/transactions/:transactionId/void',
  validate(transactionParamsSchema, 'params'), validate(voidBodySchema), voidTransaction)

customerLedgerRoutes.use(mapCustomerLedgerError)
