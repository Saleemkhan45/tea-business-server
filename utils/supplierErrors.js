export function supplierError(code, message, statusCode = 400, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details })
}

export function isUncertainSupplierWrite(error) {
  return Boolean(error?.writeConcernError || error?.result?.writeConcernError || error?.hasErrorLabel?.('UnknownTransactionCommitResult') || error?.errorLabels?.includes('UnknownTransactionCommitResult') ||
    ['MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoWriteConcernError', 'MongoServerSelectionError', 'MongooseServerSelectionError', 'MongoOperationTimeoutError'].includes(error?.name) ||
    [64, 91, 189, 262].includes(error?.code))
}

export function mapSupplierError(error, req, res, next) {
  if (error.name === 'ZodError') return res.status(400).json({ code: 'SUPPLIER_VALIDATION_FAILED', message: 'Review the supplier information.', issues: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) })
  if (error.name === 'ValidationError' || error.name === 'CastError') return res.status(400).json({ code: 'SUPPLIER_VALIDATION_FAILED', message: 'Review the supplier information.' })
  if (error.statusCode) return res.status(error.statusCode).json({
    code: typeof error.code === 'string' ? error.code : error.statusCode === 403 ? 'FORBIDDEN' : error.statusCode === 404 ? 'SUPPLIER_NOT_FOUND' : 'SUPPLIER_VALIDATION_FAILED',
    message: error.statusCode === 403 ? 'Only an owner or admin can manage suppliers.' : error.message,
    ...(error.existingSupplierId ? { existingSupplierId: error.existingSupplierId } : {}),
    ...(error.outcomeUncertain ? { outcomeUncertain: true } : {}),
  })
  if (isUncertainSupplierWrite(error) || error.name === 'MongoNotConnectedError') return res.status(503).json({ code: 'DATABASE_UNAVAILABLE', message: 'Supplier data is temporarily unavailable. Try the read-only check again.' })
  // Never expose driver messages, index names, keys, or values to the client.
  return res.status(500).json({ code: 'SUPPLIER_SAVE_FAILED', message: 'The supplier request could not be completed.' })
}
