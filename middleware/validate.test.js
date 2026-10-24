import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { validate } from './validate.js'

describe('validate middleware', () => {
  it('replaces Express 5 query getter with parsed query data', () => {
    const requestPrototype = Object.defineProperty({}, 'query', {
      configurable: true,
      get: () => ({ page: '2' }),
    })
    const req = Object.create(requestPrototype)
    const res = { status: vi.fn(), json: vi.fn() }
    const next = vi.fn()

    validate(z.object({ page: z.coerce.number().default(1) }), 'query')(req, res, next)

    expect(req.query).toEqual({ page: 2 })
    expect(next).toHaveBeenCalledOnce()
  })
})