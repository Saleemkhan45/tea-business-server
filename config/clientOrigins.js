export function getClientOrigins({ clientOrigin, nodeEnv }) {
  const origins = [clientOrigin]
  if (nodeEnv !== 'development') return origins
  try {
    const local = new URL(clientOrigin)
    if (!['localhost', '127.0.0.1'].includes(local.hostname)) return origins
    local.hostname = local.hostname === 'localhost' ? '127.0.0.1' : 'localhost'
    origins.push(local.origin)
  } catch {
    // Keep the configured origin when it is not a URL.
  }
  return origins
}
