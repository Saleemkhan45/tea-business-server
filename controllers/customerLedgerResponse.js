function timestamp(value) {
  return value instanceof Date ? value.toISOString() : value
}

export function serializeTransaction(transaction) {
  return {
    id: String(transaction._id),
    businessId: String(transaction.shop),
    customerId: String(transaction.customer),
    type: transaction.type,
    businessDate: transaction.businessDate,
    status: transaction.status,
    createdBy: String(transaction.createdBy),
    createdAt: timestamp(transaction.createdAt),
    updatedAt: timestamp(transaction.updatedAt),
    notes: transaction.notes ?? null,
    amountPkr: transaction.amountPkr,
    ...(transaction.reference ? { reference: transaction.reference } : {}),
    ...(transaction.collectionOccurrence ? { collectionOccurrence: String(transaction.collectionOccurrence) } : {}),
    ...(transaction.enteredByName ? { enteredByName: transaction.enteredByName } : {}),
    ...(transaction.productName ? { productName: transaction.productName } : {}),
    ...(transaction.salePaymentMethod ? { salePaymentMethod: transaction.salePaymentMethod } : {}),
    ...(transaction.reversalOf ? { reversalOf: String(transaction.reversalOf) } : {}),
    ...(transaction.saleId ? { saleId: String(transaction.saleId) } : {}),
    ...(transaction.type === 'purchase' || transaction.type === 'return' ? {
      saleId: String(transaction.saleId),
      teaType: transaction.teaType,
      stockLocationId: transaction.stockLocationId,
      quantityKg: transaction.quantityKg,
      ratePerKgPkr: transaction.ratePerKgPkr,
    } : {}),
    ...(transaction.paymentMethod ? { paymentMethod: transaction.paymentMethod } : {}),
    ...(transaction.type === 'adjustment' ? { reason: transaction.reason } : {}),
    ...(transaction.status === 'voided' ? {
      voidedAt: timestamp(transaction.voidedAt),
      voidedBy: String(transaction.voidedBy),
      voidReason: transaction.voidReason,
    } : {}),
  }
}

function matchesFilter(transaction, filter) {
  return (!filter.from || transaction.businessDate >= filter.from)
    && (!filter.to || transaction.businessDate <= filter.to)
    && (!filter.type || transaction.type === filter.type)
    && (!filter.teaType || transaction.teaType === filter.teaType)
    && (!filter.status || transaction.status === filter.status)
}

export function serializeLedger(ledger, filter) {
  const transactions = ledger.transactions.filter(transaction => matchesFilter(transaction, filter))
  const ids = new Set(transactions.map(transaction => String(transaction._id)))
  return {
    customerId: String(ledger.customerId),
    transactions: transactions.map(serializeTransaction),
    rows: ledger.rows.filter(row => ids.has(String(row.transactionId))).map(row => ({
      ...row,
      transactionId: String(row.transactionId),
      createdBy: String(row.createdBy),
      createdAt: timestamp(row.createdAt),
    })),
    currentBalancePkr: ledger.currentBalancePkr,
  }
}

export function serializeSummary(summary) {
  return { ...summary, customerId: String(summary.customerId) }
}

export function serializeReminderCandidate(candidate) {
  return candidate === null ? null : { ...candidate, customerId: String(candidate.customerId) }
}
