export function redactDatabaseMessage(value, uri = '') {
  let message = String(value ?? '(not available)')
  if (uri) message = message.replaceAll(uri, '[redacted-uri]')
  message = message.replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]*/gi, '[redacted-uri]')

  // Drivers can repeat decoded credentials outside the URI in an error message.
  const userInfo = uri.match(/^mongodb(?:\+srv)?:\/\/([^@]*)@/i)?.[1]
  if (userInfo) {
    const separator = userInfo.indexOf(':')
    const credentials = separator < 0
      ? [userInfo]
      : [userInfo, userInfo.slice(0, separator), userInfo.slice(separator + 1)]
    const tokens = new Set(credentials.filter(Boolean))
    for (const credential of credentials) {
      try {
        const decoded = decodeURIComponent(credential)
        if (decoded) tokens.add(decoded)
      } catch {
        // Keep the raw token when a malformed URI contains invalid percent escapes.
      }
    }
    for (const token of [...tokens].sort((a, b) => b.length - a.length)) {
      message = message.replaceAll(token, '[redacted-credential]')
    }
  }
  return message
}

export function logDatabaseError(error, uri, log = console.error) {
  const fields = ['name', 'code', 'syscall', 'hostname', 'message']
  function logDetails(current, prefix = '') {
    for (const field of fields) {
      log(`${prefix}${field}: ${redactDatabaseMessage(current?.[field], uri)}`)
    }
    const seen = new Set([current])
    let cause = current?.cause
    let causePrefix = `${prefix}cause.`
    while (cause && !seen.has(cause) && fields.some(field => cause[field] !== undefined)) {
      seen.add(cause)
      for (const field of fields) {
        log(`${causePrefix}${field}: ${redactDatabaseMessage(cause[field], uri)}`)
      }
      cause = cause.cause
      causePrefix += 'cause.'
    }
  }

  logDetails(error)
  for (const [host, description] of error?.reason?.servers ?? []) {
    log(`server: ${redactDatabaseMessage(host, uri)}`)
    if (description.error) logDetails(description.error, '  ')
    else log('  message: no error recorded')
  }
}
