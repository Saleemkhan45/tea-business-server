import { describe, expect, it } from 'vitest'
import {
  createIntegrationLifecycle,
  LifecycleState,
  preservePrimaryFailure,
  wrapIntegrationTest,
} from './integrationLifecycle.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve))
}

describe('integration lifecycle ownership guard', () => {
  it('keeps a callback owned until its actual completion', async () => {
    const lifecycle = createIntegrationLifecycle()
    const pending = deferred()

    const callback = lifecycle.runCallback('slow callback', () => pending.promise)

    expect(lifecycle.activeCount()).toBe(1)
    expect(lifecycle.state).toBe(LifecycleState.running)

    pending.resolve('done')

    await expect(callback).resolves.toBe('done')
    expect(lifecycle.activeCount()).toBe(0)
    expect(lifecycle.state).toBe(LifecycleState.quiescent)
  })

  it('does not mark a callback complete when a simulated timeout occurs', async () => {
    const lifecycle = createIntegrationLifecycle()
    const pending = deferred()

    const callback = lifecycle.runCallback('timed callback', () => pending.promise)

    await expect(lifecycle.waitForQuiescence(0, 'afterEach drain after timeout'))
      .rejects.toThrow(/quarantined/)
    expect(lifecycle.isInvalidated()).toBe(true)
    expect(lifecycle.activeCount()).toBe(1)

    pending.resolve('late success')

    await expect(callback).resolves.toBe('late success')
    expect(lifecycle.activeCount()).toBe(0)
    expect(lifecycle.isInvalidated()).toBe(true)
  })

  it('keeps the original timeout error as the reported result after later callback completion', async () => {
    const lifecycle = createIntegrationLifecycle()
    const pending = deferred()
    const timeoutError = new Error('Test timed out in 5000ms')

    const callback = lifecycle.runCallback('late success', () => pending.promise)
    const reportedBeforeCompletion = preservePrimaryFailure(timeoutError)

    pending.resolve('eventual success')

    await expect(callback).resolves.toBe('eventual success')
    expect(reportedBeforeCompletion).toBe(timeoutError)
    expect(preservePrimaryFailure(timeoutError)).toBe(timeoutError)
  })

  it('keeps ownership active when Promise.all rejects before a sibling settles', async () => {
    const lifecycle = createIntegrationLifecycle()
    const rejected = deferred()
    const sibling = deferred()
    const firstError = new Error('first failure')

    const combined = Promise.all([
      lifecycle.track('rejecting child', rejected.promise),
      lifecycle.track('pending sibling', sibling.promise),
    ])

    rejected.reject(firstError)

    await expect(combined).rejects.toBe(firstError)
    expect(lifecycle.activeCount()).toBe(1)
    expect(lifecycle.activeLabels()).toEqual(['pending sibling'])

    sibling.resolve('finished')

    await lifecycle.waitForQuiescence()
    expect(lifecycle.activeCount()).toBe(0)
  })

  it('observes a late child rejection without an unhandled rejection', async () => {
    const lifecycle = createIntegrationLifecycle()
    const child = deferred()
    const unhandled = []
    const onUnhandled = reason => {
      unhandled.push(reason)
    }

    process.once('unhandledRejection', onUnhandled)
    lifecycle.track('late rejecting child', child.promise)

    child.reject(new Error('late child failure'))

    try {
      await lifecycle.waitForQuiescence()
      await nextTurn()
      expect(unhandled).toEqual([])
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
    }
  })

  it('executes a Mongoose-like thenable at most once', async () => {
    const lifecycle = createIntegrationLifecycle()
    let executions = 0
    const thenable = {
      then(resolve) {
        executions += 1
        resolve('query result')
      },
    }

    const tracked = lifecycle.track('mongoose-like query', thenable)

    await expect(Promise.all([tracked])).resolves.toEqual(['query result'])
    expect(executions).toBe(1)
    expect(lifecycle.activeCount()).toBe(0)
  })

  it('blocks mock restoration until owned work completes', async () => {
    const lifecycle = createIntegrationLifecycle()
    const pending = deferred()
    const order = []

    lifecycle.track('test work', pending.promise)
    const restoreMocks = async () => {
      await lifecycle.drainAndGuard('mock restoration')
      order.push('restore mocks')
    }
    const restore = restoreMocks()

    await Promise.resolve()
    expect(order).toEqual([])

    pending.resolve()

    await restore
    expect(order).toEqual(['restore mocks'])
  })

  it('blocks next beforeEach fixture deletion while prior work is active', async () => {
    const lifecycle = createIntegrationLifecycle()
    const pending = deferred()
    let deleted = false

    lifecycle.track('prior test work', pending.promise)

    const deleteFixtures = async () => {
      await lifecycle.drainAndGuard('beforeEach fixture deletion', 0)
      deleted = true
    }

    await expect(deleteFixtures()).rejects.toThrow(/fixture deletion/)
    expect(deleted).toBe(false)
    expect(lifecycle.isInvalidated()).toBe(true)

    pending.resolve()
    await nextTurn()
  })

  it('blocks afterAll teardown while owned work is active', async () => {
    const lifecycle = createIntegrationLifecycle()
    const pending = deferred()
    let tornDown = false

    lifecycle.track('unfinished test work', pending.promise)

    const tearDown = async () => {
      await lifecycle.drainAndGuard('afterAll teardown', 0)
      tornDown = true
    }

    await expect(tearDown()).rejects.toThrow(/afterAll teardown/)
    expect(tornDown).toBe(false)
    expect(lifecycle.isInvalidated()).toBe(true)

    pending.resolve()
    await nextTurn()
  })

  it('fails closed when draining exceeds its allowed budget', async () => {
    const lifecycle = createIntegrationLifecycle()
    const pending = deferred()

    lifecycle.track('stuck callback', pending.promise)

    await expect(lifecycle.waitForQuiescence(0, 'bounded drain'))
      .rejects.toThrow(/Unresolved owned work: stuck callback/)
    expect(lifecycle.state).toBe(LifecycleState.invalidated)
    expect(lifecycle.invalidReason.message).toContain('Lifecycle is quarantined')

    pending.resolve()
    await nextTurn()
  })

  it('does not allow a quarantined lifecycle to be reused accidentally', async () => {
    const lifecycle = createIntegrationLifecycle()
    const pending = deferred()

    lifecycle.track('stuck work', pending.promise)
    await expect(lifecycle.waitForQuiescence(0, 'quarantine')).rejects.toThrow(/quarantined/)

    expect(() => lifecycle.begin('manual work')).toThrow(/Unsafe starting manual work/)
    expect(() => lifecycle.track('new work', Promise.resolve())).toThrow(/Unsafe starting new work/)
    expect(() => lifecycle.assertExclusiveOwnership('fixture deletion')).toThrow(/Unsafe fixture deletion/)

    pending.resolve()
    await nextTurn()
  })

  it('allows cleanup in order after a successful drain', async () => {
    const lifecycle = createIntegrationLifecycle()
    const pending = deferred()
    const order = []

    lifecycle.track('owned work', pending.promise.then(() => {
      order.push('work complete')
    }))

    const cleanup = async () => {
      await lifecycle.drainAndGuard('cleanup')
      order.push('cleanup')
    }
    const cleanupPromise = cleanup()

    await Promise.resolve()
    expect(order).toEqual([])

    pending.resolve()

    await cleanupPromise
    expect(order).toEqual(['work complete', 'cleanup'])
  })

  it('does not erase the original timeout failure when cleanup also fails', () => {
    const timeoutError = new Error('Test timed out in 5000ms')
    const cleanupError = new Error('mock restoration failed')

    const reported = preservePrimaryFailure(timeoutError, cleanupError)

    expect(reported).toBe(timeoutError)
    expect(reported.suppressed).toEqual([cleanupError])
  })

  it('handles repeated completion notifications idempotently', async () => {
    const lifecycle = createIntegrationLifecycle()
    const owner = lifecycle.begin('manual request')

    expect(lifecycle.activeCount()).toBe(1)

    owner.complete()
    owner.complete(new Error('late duplicate close'))

    await lifecycle.waitForQuiescence()
    expect(lifecycle.activeCount()).toBe(0)
    expect(lifecycle.state).toBe(LifecycleState.quiescent)
  })

  it('does not alter Promise.all original rejection behavior', async () => {
    const lifecycle = createIntegrationLifecycle()
    const rejected = deferred()
    const sibling = deferred()
    const originalError = new Error('original rejection')
    const combined = Promise.all([
      lifecycle.track('original rejecting child', rejected.promise),
      lifecycle.track('eventual sibling', sibling.promise),
    ])

    rejected.reject(originalError)

    await expect(combined).rejects.toBe(originalError)
    expect(lifecycle.activeLabels()).toEqual(['eventual sibling'])

    sibling.resolve('done')
    await lifecycle.waitForQuiescence()
  })

  it('wraps ordinary tests and it.each-compatible registrations without reordering callback args', async () => {
    const lifecycle = createIntegrationLifecycle()
    const ordinaryCalls = []
    const eachCalls = []
    const fakeIt = (title, ...args) => {
      ordinaryCalls.push([title, ...args])
      return args.find(arg => typeof arg === 'function')('ordinary-value')
    }
    fakeIt.each = cases => (title, ...args) => {
      eachCalls.push([cases, title, ...args])
      return args.find(arg => typeof arg === 'function')('each-value')
    }
    const tracked = wrapIntegrationTest(fakeIt, lifecycle)

    await expect(tracked('ordinary', { timeout: 5 }, async value => value)).resolves.toBe('ordinary-value')
    await expect(tracked.each([['case']])('each %s', async value => value)).resolves.toBe('each-value')

    expect(ordinaryCalls[0][0]).toBe('ordinary')
    expect(eachCalls[0][1]).toBe('each %s')
    expect(lifecycle.activeCount()).toBe(0)
  })
})
