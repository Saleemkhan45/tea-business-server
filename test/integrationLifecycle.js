export const LifecycleState = Object.freeze({
  idle: 'idle',
  running: 'running',
  draining: 'draining',
  quiescent: 'quiescent',
  invalidated: 'invalidated',
})

function toError(reason, fallbackMessage) {
  if (reason instanceof Error) return reason
  return new Error(String(reason ?? fallbackMessage))
}

function appendSuppressed(primary, secondary) {
  if (!secondary || secondary === primary) return primary
  if (!Array.isArray(primary.suppressed)) {
    Object.defineProperty(primary, 'suppressed', {
      configurable: true,
      enumerable: false,
      value: [],
      writable: true,
    })
  }
  primary.suppressed.push(secondary)
  if (primary.cause == null) {
    try {
      primary.cause = secondary
    } catch {
      // Some Error implementations expose a read-only cause.
    }
  }
  return primary
}

export function preservePrimaryFailure(primaryFailure, secondaryFailure) {
  if (primaryFailure) {
    return appendSuppressed(primaryFailure, secondaryFailure)
  }
  return secondaryFailure ?? null
}

export function createIntegrationLifecycle({
  drainTimeoutMs = 5000,
  onInvalidated,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const active = new Map()
  const waiters = new Set()
  let nextToken = 0
  let state = LifecycleState.idle
  let invalidReason = null

  function activeEntries() {
    return [...active.values()]
  }

  function activeLabels() {
    return activeEntries().map(entry => entry.label)
  }

  function activeSummary() {
    const labels = activeLabels()
    return labels.length > 0 ? labels.join(', ') : 'none'
  }

  function snapshotActive() {
    const current = now()
    return activeEntries().map(entry => ({
      label: entry.label,
      ageMs: Math.max(0, current - entry.startedAt),
    }))
  }

  function notifyWaiters() {
    if (active.size === 0 && state !== LifecycleState.invalidated) {
      state = LifecycleState.quiescent
    }
    const pending = [...waiters]
    waiters.clear()
    for (const resolve of pending) resolve()
  }

  function createDrainError(action, timeoutMs) {
    return new Error(
      `Integration lifecycle ownership timed out after ${timeoutMs}ms while ${action}. ` +
      `Unresolved owned work: ${activeSummary()}. ` +
      'Lifecycle is quarantined; unsafe cleanup must not continue.',
    )
  }

  function invalidate(reason) {
    if (state === LifecycleState.invalidated) {
      return invalidReason
    }

    invalidReason = toError(reason, 'Integration lifecycle ownership was invalidated.')
    state = LifecycleState.invalidated
    notifyWaiters()

    if (typeof onInvalidated === 'function') {
      onInvalidated(invalidReason)
    }

    return invalidReason
  }

  function guard(action) {
    if (state !== LifecycleState.invalidated) return
    const error = new Error(`Unsafe ${action}: ${invalidReason?.message ?? 'integration lifecycle is invalidated.'}`)
    if (invalidReason) error.cause = invalidReason
    throw error
  }

  function markRunning() {
    if (state !== LifecycleState.draining && state !== LifecycleState.invalidated) {
      state = LifecycleState.running
    }
  }

  function begin(label = 'owned work') {
    guard(`starting ${label}`)

    const token = ++nextToken
    let completed = false
    active.set(token, {
      label,
      startedAt: now(),
      error: null,
    })
    markRunning()

    function complete(reason) {
      if (completed) return
      completed = true

      const entry = active.get(token)
      if (entry && reason) {
        entry.error = toError(reason, `Owned work failed: ${label}`)
      }
      active.delete(token)
      notifyWaiters()
    }

    return {
      complete,
      get active() {
        return active.has(token)
      },
      label,
      token,
    }
  }

  function track(label, operation) {
    const owner = begin(label)
    let result

    try {
      result = typeof operation === 'function' ? operation() : operation
    } catch (error) {
      result = Promise.reject(error)
    }

    const observed = Promise.resolve(result)
    observed.then(
      () => owner.complete(),
      error => owner.complete(error),
    )
    return observed
  }

  function waitUntilQuiescent() {
    if (active.size === 0 || state === LifecycleState.invalidated) {
      return Promise.resolve()
    }
    return new Promise(resolve => {
      waiters.add(resolve)
    })
  }

  async function waitForQuiescence(timeoutMs = drainTimeoutMs, action = 'waiting for quiescence') {
    guard(action)

    if (active.size === 0) {
      state = LifecycleState.quiescent
      return
    }

    state = LifecycleState.draining

    if (timeoutMs <= 0) {
      const error = createDrainError(action, timeoutMs)
      invalidate(error)
      throw error
    }

    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimer(() => {
        const error = createDrainError(action, timeoutMs)
        invalidate(error)
        reject(error)
      }, timeoutMs)
    })

    try {
      await Promise.race([waitUntilQuiescent(), timeout])
      guard(action)
    } finally {
      clearTimer(timer)
    }

    if (active.size === 0 && state !== LifecycleState.invalidated) {
      state = LifecycleState.quiescent
    }
  }

  function assertExclusiveOwnership(label = 'destructive lifecycle operation') {
    guard(label)

    if (active.size > 0 || state === LifecycleState.running || state === LifecycleState.draining) {
      throw new Error(`Unsafe ${label} while owned work remains active: ${activeSummary()}.`)
    }
  }

  async function drainAndGuard(label, timeoutMs = drainTimeoutMs) {
    await waitForQuiescence(timeoutMs, label)
    assertExclusiveOwnership(label)
  }

  function all(label, operations) {
    if (!Array.isArray(operations)) {
      throw new TypeError('integration lifecycle all() requires an array of operations')
    }

    return Promise.all(operations.map((operation, index) => track(`${label} #${index + 1}`, operation)))
  }

  function withOwnership(label, callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('withOwnership requires a callback function')
    }

    return track(label, callback)
  }

  function runCallback(label, callback, thisArg, callbackArgs = []) {
    if (typeof callback !== 'function') {
      throw new TypeError('runCallback requires a callback function')
    }

    return track(`callback: ${label}`, () => callback.apply(thisArg, callbackArgs))
  }

  function observeHttpServer(server, label = 'HTTP request') {
    if (!server || typeof server.on !== 'function' || typeof server.off !== 'function') {
      throw new TypeError('observeHttpServer requires a Node HTTP server')
    }

    guard(`observing ${label}`)

    const onRequest = (request, response) => {
      const owner = begin(`${label}: ${request.method ?? 'REQUEST'} ${request.url ?? '/'}`)
      const complete = reason => owner.complete(reason)
      response.once('finish', complete)
      response.once('close', complete)
      response.once('error', complete)
    }

    server.on('request', onRequest)
    return () => {
      server.off('request', onRequest)
    }
  }

  return {
    activeCount: () => active.size,
    activeLabels,
    all,
    assertExclusiveOwnership,
    begin,
    drainAndGuard,
    get invalidReason() {
      return invalidReason
    },
    invalidate,
    isInvalidated: () => state === LifecycleState.invalidated,
    observeHttpServer,
    preservePrimaryFailure,
    register: track,
    runCallback,
    snapshotActive,
    get state() {
      return state
    },
    getState: () => state,
    track,
    waitForQuiescence,
    withOwnership,
  }
}

export function wrapIntegrationTest(testFn, lifecycle = createIntegrationLifecycle()) {
  if (typeof testFn !== 'function') {
    throw new TypeError('wrapIntegrationTest requires a test function')
  }

  function wrapCallback(title, callback) {
    return function trackedCallback(...callbackArgs) {
      return lifecycle.runCallback(String(title), callback, this, callbackArgs)
    }
  }

  const wrapped = function wrappedTest(title, ...args) {
    const callbackIndex = typeof args[0] === 'function'
      ? 0
      : typeof args[1] === 'function'
        ? 1
        : -1

    if (callbackIndex === -1) {
      return testFn.call(this, title, ...args)
    }

    const nextArgs = [...args]
    nextArgs[callbackIndex] = wrapCallback(title, args[callbackIndex])
    return testFn.call(this, title, ...nextArgs)
  }

  wrapped.each = (...args) => {
    if (typeof testFn.each !== 'function') {
      throw new TypeError('wrapIntegrationTest requires a test function with an each method')
    }

    return wrapIntegrationTest(testFn.each(...args), lifecycle)
  }

  return wrapped
}

export default createIntegrationLifecycle
