import { describe, expect, it } from 'vitest'
import { PROTOCOL } from '../../src/runtime/constants.js'
import { redact, RuntimeError } from '../../src/runtime/errors.js'
import { buildResponse, parseRequest } from '../../src/runtime/protocol.js'
import { compareCodeUnits, stableJson } from '../../src/runtime/stable-json.js'

/** @returns a well-formed request with the given overrides applied. */
function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { protocol: PROTOCOL, capability: 'repository.inspect', ...overrides }
}

/** @returns the stable code of the RuntimeError a call throws. */
function codeOf(run: () => unknown): string {
  try {
    run()
  }
  catch (error) {
    expect(error).toBeInstanceOf(RuntimeError)
    return (error as RuntimeError).code
  }
  throw new Error('expected the call to throw')
}

describe('request envelope', () => {
  it('accepts a minimal request', () => {
    expect(parseRequest(request())).toEqual({ protocol: PROTOCOL, capability: 'repository.inspect' })
  })

  it.each([
    [null, 'REQUEST_MALFORMED'],
    ['text', 'REQUEST_MALFORMED'],
    [[], 'REQUEST_MALFORMED'],
  ])('rejects a non-object request %j', (raw, code) => {
    expect(codeOf(() => parseRequest(raw))).toBe(code)
  })

  it('rejects a foreign protocol', () => {
    expect(codeOf(() => parseRequest(request({ protocol: 'llmdoc.runtime/v1' })))).toBe('PROTOCOL_MISMATCH')
  })

  it.each(['', 'repository.destroy', 'up' + 'grade', 42])('rejects unknown capability %j', (capability) => {
    expect(codeOf(() => parseRequest(request({ capability })))).toBe('CAPABILITY_UNKNOWN')
  })

  it.each([
    { items: 0 },
    { bytes: -1 },
    { estimatedTokens: 1.5 },
    { items: 'many' },
  ])('rejects invalid budget %j', (budget) => {
    expect(codeOf(() => parseRequest(request({ budget })))).toBe('REQUEST_MALFORMED')
  })

  it('keeps a valid budget', () => {
    expect(parseRequest(request({ budget: { items: 10, bytes: 2048 } })).budget)
      .toEqual({ items: 10, bytes: 2048 })
  })

  it('rejects an empty cursor', () => {
    expect(codeOf(() => parseRequest(request({ cursor: '' })))).toBe('REQUEST_MALFORMED')
  })
})

describe('response envelope', () => {
  it('omits absent optional fields rather than emitting null', () => {
    expect(buildResponse('repository.inspect', { status: 'success' }))
      .toEqual({ protocol: PROTOCOL, capability: 'repository.inspect', status: 'success' })
  })

  it('drops an empty diagnostics array', () => {
    expect(buildResponse('repository.inspect', { status: 'success', diagnostics: [] }))
      .not
      .toHaveProperty('diagnostics')
  })
})

describe('redaction', () => {
  it('preserves a stable code from a RuntimeError', () => {
    expect(redact(new RuntimeError('PATH_TRAVERSAL', 'nope'))).toEqual({
      code: 'PATH_TRAVERSAL',
      severity: 'error',
      message: 'nope',
    })
  })

  it('never leaks an unexpected error message or path', () => {
    const leaked = redact(new Error('ENOENT: /Users/someone/secret/token.txt'))
    expect(leaked.code).toBe('INTERNAL')
    expect(leaked.message).not.toContain('/Users/')
    expect(leaked.message).not.toContain('token')
  })
})

describe('stable serialization', () => {
  it('orders object keys independently of insertion order', () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe(stableJson({ a: { c: 3, d: 2 }, b: 1 }))
  })

  it('preserves array order', () => {
    expect(stableJson(['b', 'a'])).not.toBe(stableJson(['a', 'b']))
  })

  it('is idempotent', () => {
    const once = stableJson({ z: [1, { y: 2, x: 3 }], a: null })
    expect(stableJson(JSON.parse(once))).toBe(once)
  })

  it('compares by code unit rather than locale', () => {
    expect(compareCodeUnits('Z', 'a')).toBeLessThan(0)
    expect(compareCodeUnits('a', 'a')).toBe(0)
  })
})
