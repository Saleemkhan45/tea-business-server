import { describe, expect, it, vi } from 'vitest'
import { inspectEnv, printEnvReport } from './check-env.js'

const sampleUri = 'mongodb://SAMPLE_USER:SAMPLE_PASSWORD@sample.invalid/tea_business_dashboard'

describe('secret-safe env structure inspection', () => {
  it.each(['', '"', "'", '`'])('accepts a single-line URI with delimiter %s', quote => {
    const report = inspectEnv(`MONGODB_URI=${quote}${sampleUri}${quote}\r\nPORT=4000\r\n`)
    expect(report).toMatchObject({ valid: true, exists: true, quotesBalanced: true,
      multiline: false, scheme: 'mongodb://', inventory: ['1: MONGODB_URI', '2: PORT'] })
    expect(JSON.stringify(report)).not.toContain('SAMPLE_PASSWORD')
    expect(JSON.stringify(report)).not.toContain('sample.invalid')
  })

  it('detects a missing key and does not treat a commented key as active', () => {
    expect(inspectEnv('PORT=4000')).toMatchObject({ exists: false, valid: false })
    expect(inspectEnv(`# MONGODB_URI=${sampleUri}`)).toMatchObject({
      exists: false, commentedOut: true, valid: false, inventory: ['1: commented out'],
    })
  })

  it.each([`MONGODB_URI="${sampleUri}`, `MONGODB_URI=${sampleUri}"`])
    ('detects unbalanced quotes without returning values', source => {
      expect(inspectEnv(source)).toMatchObject({ quotesBalanced: false, valid: false })
    })

  it.each([
    'MONGODB_URI="mongodb://SAMPLE_USER:SAMPLE_PASSWORD@\nsample.invalid/tea_business_dashboard"',
    'MONGODB_URI=mongodb://SAMPLE_USER:SAMPLE_PASSWORD@host1.invalid:27017,\nhost2.invalid:27017/tea_business_dashboard',
    `MONGODB_URI=\n${sampleUri}`,
    'MONGODB_URI="mongodb://sample.invalid/tea_business_dashboard\\n"',
  ])('flags quoted, unquoted, and escaped multiline values', source => {
    expect(inspectEnv(source)).toMatchObject({ multiline: true, valid: false })
  })

  it('reports BOM and trailing whitespace without exposing values', () => {
    expect(inspectEnv(`\uFEFFMONGODB_URI=${sampleUri} \t\n`)).toMatchObject({
      exists: true, bom: true, trailingWhitespace: true,
    })
  })

  it('reports invalid assignment syntax and duplicate assignments', () => {
    expect(inspectEnv(`MONGODB_URI ${sampleUri}`)).toMatchObject({
      inventory: ['1: invalid line'], valid: false,
    })
    expect(inspectEnv(`MONGODB_URI=${sampleUri}\nMONGODB_URI=${sampleUri}`))
      .toMatchObject({ assignments: 2, valid: false })
  })

  it('prints only keys and structural metadata, including the SRV scheme', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      printEnvReport(inspectEnv(`MONGODB_URI=${sampleUri.replace('mongodb://', 'mongodb+srv://')}\n# comment\ninvalid`))
      const output = log.mock.calls.flat().join('\n')
      expect(output).toContain('MONGODB_URI scheme: mongodb+srv://')
      expect(output).toContain('2: commented out')
      expect(output).toContain('3: invalid line')
      expect(output).not.toContain('SAMPLE_USER')
      expect(output).not.toContain('SAMPLE_PASSWORD')
      expect(output).not.toContain('sample.invalid')
    } finally {
      log.mockRestore()
    }
  })
})
