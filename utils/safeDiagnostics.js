// Allowlisted fields only: no request bodies, URLs, credentials or driver messages.
export function diagnostic(event, fields = {}) {
  const safe = { event, at: new Date().toISOString() }
  for (const key of ['requestId', 'port', 'status', 'durationMs', 'method', 'code', 'state']) {
    if (typeof fields[key] === 'number' || (typeof fields[key] === 'string' && /^[\w.-]{1,80}$/.test(fields[key]))) safe[key] = fields[key]
  }
  if (typeof fields.route === 'string' && /^\/[\w/:.-]{0,160}$/.test(fields.route)) safe.route = fields.route
  console.info(JSON.stringify(safe))
}
export function databaseFailure(error) {
  return /Mongo(Network|ServerSelection|TopologyClosed|NotConnected|PoolCleared|WaitQueueTimeout|OperationTimeout)|MongooseServerSelection/.test(error?.name ?? '') || (error?.name === 'MongoServerError' && error.code === 50)
}

export function diagnosticRoute(req) {
  const prefix = req.baseUrl?.match(/^\/api\/v1\/(auth|sales|customers|collections|regional|purchases|notifications|whatsapp|cashbook)(?=\/|$)/)?.[0] ?? ''
  const template = req.route?.path
  return typeof template === 'string' && /^\/[\w/:.-]*$/.test(template) ? prefix + template : '/unmatched'
}
