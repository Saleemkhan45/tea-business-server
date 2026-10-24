import { daysBetweenBusinessDates } from '../utils/businessDay.js'

function safeSum(total, amount) {
  const result = total + amount
  if (!Number.isSafeInteger(result)) throw new RangeError('Ledger balance exceeds the safe integer PKR range.')
  return result
}

export function transactionImpactPkr(transaction) {
  if (transaction.status === 'voided') return 0
  if (transaction.status !== 'active' || !Number.isSafeInteger(transaction.amountPkr)) {
    throw new TypeError('Ledger transaction has an invalid status or PKR amount.')
  }

  switch (transaction.type) {
    case 'payment':
    case 'return': return -transaction.amountPkr
    case 'purchase':
    case 'opening_balance':
    case 'adjustment': return transaction.amountPkr
    default: throw new TypeError('Ledger transaction has an unsupported type.')
  }
}

export function balancePkr(transactions) {
  return transactions.reduce((total, transaction) => safeSum(total, transactionImpactPkr(transaction)), 0)
}

export function orderedTransactions(transactions) {
  return [...transactions].sort((first, second) =>
    first.businessDate.localeCompare(second.businessDate)
    || new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime()
    || String(first._id).localeCompare(String(second._id)))
}

export function ledgerRows(transactions) {
  let runningBalancePkr = 0
  return orderedTransactions(transactions).map(transaction => {
    const balanceImpactPkr = transactionImpactPkr(transaction)
    runningBalancePkr = safeSum(runningBalancePkr, balanceImpactPkr)
    return {
      transactionId: transaction._id,
      businessDate: transaction.businessDate,
      type: transaction.type,
      teaType: transaction.type === 'purchase' ? transaction.teaType : null,
      quantityKg: transaction.type === 'purchase' ? transaction.quantityKg : null,
      ratePerKgPkr: transaction.type === 'purchase' ? transaction.ratePerKgPkr : null,
      amountPkr: transaction.amountPkr,
      balanceImpactPkr,
      paymentMethod: transaction.type === 'payment' ? transaction.paymentMethod : null,
      runningBalancePkr,
      status: transaction.status,
      createdBy: transaction.createdBy,
      createdAt: transaction.createdAt,
    }
  })
}

function summarizeProducts(purchases) {
  const products = new Map()
  for (const transaction of purchases) {
    const productName = transaction.productName?.trim() || `${transaction.teaType ?? 'other'} tea`
    const key = `${transaction.teaType ?? 'other'}:${productName.toLowerCase()}`
    const summary = products.get(key) ?? {
      productName,
      teaType: transaction.teaType ?? null,
      totalQuantityKg: 0,
      totalSpendingPkr: 0,
      purchaseCount: 0,
      lastPurchaseDate: null,
    }
    summary.totalQuantityKg += transaction.quantityKg
    summary.totalSpendingPkr = safeSum(summary.totalSpendingPkr, transaction.amountPkr)
    summary.purchaseCount += 1
    summary.lastPurchaseDate = summary.lastPurchaseDate === null || transaction.businessDate > summary.lastPurchaseDate
      ? transaction.businessDate
      : summary.lastPurchaseDate
    products.set(key, summary)
  }
  return [...products.values()].sort((first, second) =>
    String(first.teaType ?? '').localeCompare(String(second.teaType ?? ''))
    || first.productName.localeCompare(second.productName))
}

export function customerSummary(customer, transactions, referenceDate) {
  const active = transactions.filter(transaction => transaction.status === 'active')
  const reversed = new Set(active.filter(transaction => transaction.reversalOf).map(transaction => String(transaction.reversalOf)))
  const purchases = active.filter(transaction => transaction.type === 'purchase' && !reversed.has(String(transaction._id)))
  const payments = active.filter(transaction => transaction.type === 'payment' && !reversed.has(String(transaction._id)))
  const openingBalances = active.filter(transaction => transaction.type === 'opening_balance' && !reversed.has(String(transaction._id)))
  const referencePurchases = purchases.filter(transaction => transaction.businessDate <= referenceDate)
  const lastPurchaseDate = referencePurchases
    .map(transaction => transaction.businessDate)
    .sort()
    .at(-1) ?? null
  const lastPaymentDate = payments
    .filter(transaction => transaction.businessDate <= referenceDate)
    .map(transaction => transaction.businessDate)
    .sort()
    .at(-1) ?? null

  return {
    customerId: customer._id,
    totalPurchasedKg: purchases.reduce((total, transaction) => total + transaction.quantityKg, 0),
    totalPurchasedPkr: purchases.reduce((total, transaction) => safeSum(total, transaction.amountPkr), 0),
    totalPaidPkr: payments.reduce((total, transaction) => safeSum(total, transaction.amountPkr), 0),
    openingBalancePkr: openingBalances.reduce((total, transaction) => safeSum(total, transaction.amountPkr), 0),
    currentBalancePkr: balancePkr(transactions),
    purchaseCount: purchases.length,
    lastPurchaseDate,
    productSummary: summarizeProducts(purchases),
    todayPurchasedPkr: purchases.filter(transaction => transaction.businessDate === referenceDate).reduce((total, transaction) => safeSum(total, transaction.amountPkr), 0),
    todayPaidPkr: payments.filter(transaction => transaction.businessDate === referenceDate).reduce((total, transaction) => safeSum(total, transaction.amountPkr), 0),
    lastPaymentDate,
    daysSinceLastPayment: lastPaymentDate === null ? null : daysBetweenBusinessDates(lastPaymentDate, referenceDate),
  }
}

export function dailyPaymentBuckets(transactions, startDate, endDate) {
  const payments = new Map()
  const reversed = new Set(transactions.filter(transaction => transaction.status === 'active' && transaction.reversalOf).map(transaction => String(transaction.reversalOf)))
  for (const transaction of transactions) {
    if (transaction.status !== 'active' || transaction.type !== 'payment') continue
    if (reversed.has(String(transaction._id))) continue
    if (transaction.businessDate < startDate || transaction.businessDate > endDate) continue
    const bucket = payments.get(transaction.businessDate) ?? { date: transaction.businessDate, amountPkr: 0, transactionCount: 0 }
    bucket.amountPkr = safeSum(bucket.amountPkr, transaction.amountPkr)
    bucket.transactionCount += 1
    payments.set(transaction.businessDate, bucket)
  }

  const buckets = []
  for (let time = Date.parse(`${startDate}T00:00:00Z`), end = Date.parse(`${endDate}T00:00:00Z`);
    time <= end; time += 86400000) {
    const date = new Date(time).toISOString().slice(0, 10)
    buckets.push(payments.get(date) ?? { date, amountPkr: 0, transactionCount: 0 })
  }
  return buckets
}

export function paymentInsight(buckets, referenceDate, currentBalancePkr) {
  const paymentDays = buckets.filter(bucket => bucket.amountPkr > 0)
  const totalPaymentPkr = buckets.reduce((total, bucket) => safeSum(total, bucket.amountPkr), 0)
  const paymentTransactionCount = buckets.reduce((total, bucket) => total + bucket.transactionCount, 0)
  const highestPaymentDay = paymentDays.reduce((highest, bucket) =>
    !highest || bucket.amountPkr > highest.amountPkr ? bucket : highest, null)
  const lastPaymentDate = paymentDays.at(-1)?.date ?? null
  const intervals = paymentDays.slice(1).map((bucket, index) =>
    daysBetweenBusinessDates(paymentDays[index].date, bucket.date))
  const averageDailyPaymentPkr = paymentTransactionCount === 0 ? null : Math.round(totalPaymentPkr / buckets.length)

  return {
    highestPaymentDay,
    zeroPaymentDays: buckets.filter(bucket => bucket.amountPkr === 0).length,
    averageDailyPaymentPkr,
    averagePaymentAmountPkr: paymentTransactionCount === 0 ? null : Math.round(totalPaymentPkr / paymentTransactionCount),
    paymentDaysCount: paymentDays.length,
    paymentTransactionCount,
    lastPaymentDate,
    daysSinceLastPayment: lastPaymentDate === null ? null : daysBetweenBusinessDates(lastPaymentDate, referenceDate),
    averagePaymentIntervalDays: intervals.length === 0 ? null : intervals.reduce((total, days) => total + days, 0) / intervals.length,
    estimatedDaysToClear: currentBalancePkr <= 0 ? 0
      : averageDailyPaymentPkr === null || averageDailyPaymentPkr <= 0 ? null
        : Math.ceil(currentBalancePkr / averageDailyPaymentPkr),
  }
}

export function paymentCalendarBuckets(buckets) {
  const highestAmount = Math.max(0, ...buckets.map(bucket => bucket.amountPkr))
  return buckets.map(bucket => ({
    ...bucket,
    level: highestAmount === 0 ? 'no_data'
      : bucket.amountPkr === 0 ? 'none'
        : bucket.amountPkr < highestAmount / 3 ? 'low'
          : bucket.amountPkr < highestAmount * 2 / 3 ? 'medium' : 'high',
  }))
}

export function reminderCandidate(customer, transactions, referenceDate, thresholdDays) {
  if (customer.status !== 'active') return null
  const outstanding = balancePkr(transactions)
  if (outstanding <= 0) return null
  const active = transactions.filter(transaction => transaction.status === 'active' && transaction.businessDate <= referenceDate)
  const lastPaymentDate = active.filter(transaction => transaction.type === 'payment')
    .map(transaction => transaction.businessDate).sort().at(-1) ?? null
  const earliestDebtDate = lastPaymentDate === null
    ? orderedTransactions(active.filter(transaction => transactionImpactPkr(transaction) > 0))[0]?.businessDate ?? null
    : null
  const ageDate = lastPaymentDate ?? earliestDebtDate
  const reminderAgeDays = ageDate === null ? null : daysBetweenBusinessDates(ageDate, referenceDate)
  if (reminderAgeDays === null || reminderAgeDays < thresholdDays) return null
  return {
    customerId: customer._id,
    customerName: customer.name,
    balanceDuePkr: outstanding,
    lastPaymentDate,
    daysSinceLastPayment: lastPaymentDate === null ? null : reminderAgeDays,
    thresholdDays,
  }
}
