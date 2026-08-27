import { describe, expect, it } from 'vitest'
import { emptyLedger, ledgerToJson, parseLedger } from '../../src/runtime/meta.js'

/** @returns a valid ledger object with overrides applied. */
function ledger(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $schema: 'plugydown.context.meta/v1',
    toolVersion: '0.1.0',
    fingerprintVersion: '1',
    documents: {},
    ...overrides,
  }
}

/** @returns the issue codes a ledger produces. */
function codes(raw: unknown): string[] {
  const result = parseLedger(raw)
  return result.ok ? [] : result.issues.map(issue => issue.code)
}

describe('ledger validation', () => {
  it('accepts a minimal ledger', () => {
    expect(parseLedger(ledger()).ok).toBe(true)
  })

  it('rejects a foreign schema', () => {
    expect(codes(ledger({ $schema: `${'llm' + 'doc'}.${'meta'}/v1` }))).toContain('META_SCHEMA_INVALID')
  })

  it.each(['paths', 'catalog', 'relations', 'graph', 'body', 'session', 'feedback', 'journal'])(
    'rejects persisted %s',
    (field) => {
      expect(codes(ledger({ [field]: {} }))).toContain('META_FIELD_FORBIDDEN')
    },
  )

  it('rejects an unknown field', () => {
    expect(codes(ledger({ notes: 'x' }))).toContain('META_FIELD_UNKNOWN')
  })

  it('rejects a path-like document key', () => {
    expect(codes(ledger({ documents: { 'context/a/domain.md': {} } }))).toContain('META_DOCUMENT_KEY_INVALID')
  })

  it('defaults an unrecognised status to unverified', () => {
    const result = parseLedger(ledger({
      documents: { 'api-client': { frontMatterFingerprint: 'a', bodyFingerprint: 'b', status: 'weird' } },
    }))
    expect(result.ok && result.ledger.documents['api-client']?.status).toBe('unverified')
  })
})

describe('serialization', () => {
  it('round-trips without gaining fields', () => {
    const source = ledger({
      repository: { baseline: { revision: 'abc', treeFingerprint: 'def' } },
      documents: { 'api-client': { frontMatterFingerprint: 'a', bodyFingerprint: 'b', status: 'valid' } },
      convergence: { source: 'init', documentCount: 1, frontMatterBytes: 2, bodyBytes: 3, estimatedTokens: 4, perDomain: { 'api-client': 1 } },
    })
    const parsed = parseLedger(source)
    expect(parsed.ok).toBe(true)
    if (parsed.ok)
      expect(parseLedger(ledgerToJson(parsed.ledger)).ok).toBe(true)
  })

  it('creates an empty ledger carrying the fingerprint version', () => {
    expect(ledgerToJson(emptyLedger('0.1.0'))).toMatchObject({
      $schema: 'plugydown.context.meta/v1',
      fingerprintVersion: '1',
      documents: {},
    })
  })
})
