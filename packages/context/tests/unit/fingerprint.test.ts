import type { ContextDocument } from '../../src/runtime/document.js'
import { describe, expect, it } from 'vitest'
import { parseDocument } from '../../src/runtime/document.js'
import { bodyFingerprint, frontMatterFingerprint, normalizeBody, sourceFingerprint } from '../../src/runtime/fingerprint.js'
import { documentSource } from '../helpers/fixture.js'

/** @returns a parsed document, failing the test when the source is invalid. */
function parse(path: string, overrides: Parameters<typeof documentSource>[0]): ContextDocument {
  const result = parseDocument(path, documentSource(overrides))
  if (!result.ok)
    throw new Error(`fixture is invalid: ${result.issues.map(issue => issue.code).join(', ')}`)
  return result.document
}

const BASE = { domain: 'api-client', name: 'retry.md', id: 'api-client.retry', kind: 'guide' } as const

describe('body normalization', () => {
  it('removes only encoding noise', () => {
    expect(normalizeBody('﻿line\r\nnext   \r\n\n\n')).toBe('line\nnext\n')
  })

  it('leaves meaningful indentation intact', () => {
    expect(normalizeBody('- a\n  - b\n')).toBe('- a\n  - b\n')
  })
})

describe('front matter fingerprint', () => {
  it('is stable across relation ordering', () => {
    const left = parse('a.md', { ...BASE, requires: ['x.a', 'x.b'] })
    const right = parse('a.md', { ...BASE, requires: ['x.b', 'x.a'] })
    expect(frontMatterFingerprint(left)).toBe(frontMatterFingerprint(right))
  })

  it('changes when a declared code path changes', () => {
    const left = parse('a.md', { ...BASE, codePaths: ['src/a.ts'] })
    const right = parse('a.md', { ...BASE, codePaths: ['src/b.ts'] })
    expect(frontMatterFingerprint(left)).not.toBe(frontMatterFingerprint(right))
  })

  it('ignores the file path so a document survives a move', () => {
    const left = parse('context/api-client/manual/retry.md', BASE)
    const right = parse('context/api-client/design/retry.md', BASE)
    expect(frontMatterFingerprint(left)).toBe(frontMatterFingerprint(right))
    expect(bodyFingerprint(left)).toBe(bodyFingerprint(right))
  })

  it('changes when the ID changes, making it a delete plus a create', () => {
    const left = parse('a.md', BASE)
    const right = parse('a.md', { ...BASE, id: 'api-client.renamed' })
    expect(frontMatterFingerprint(left)).not.toBe(frontMatterFingerprint(right))
  })
})

describe('body fingerprint', () => {
  it('ignores line endings and trailing space', () => {
    const left = parse('a.md', { ...BASE, body: '# T\r\n\r\nBody   \r\n' })
    const right = parse('a.md', { ...BASE, body: '# T\n\nBody\n' })
    expect(bodyFingerprint(left)).toBe(bodyFingerprint(right))
  })

  it('changes when the body changes', () => {
    const left = parse('a.md', { ...BASE, body: '# T\n\nOne.\n' })
    const right = parse('a.md', { ...BASE, body: '# T\n\nTwo.\n' })
    expect(bodyFingerprint(left)).not.toBe(bodyFingerprint(right))
  })
})

describe('source fingerprint', () => {
  it('changes when the declaration narrows even though no file changed', () => {
    const resolved = [{ path: 'src/a.ts', contentHash: 'h1' }]
    expect(sourceFingerprint(['src/**/*.ts'], resolved)).not.toBe(sourceFingerprint(['src/a.ts'], resolved))
  })

  it('changes when resolved content changes', () => {
    expect(sourceFingerprint(['src/a.ts'], [{ path: 'src/a.ts', contentHash: 'h1' }]))
      .not
      .toBe(sourceFingerprint(['src/a.ts'], [{ path: 'src/a.ts', contentHash: 'h2' }]))
  })

  it('is independent of resolution order', () => {
    const a = { path: 'src/a.ts', contentHash: 'h1' }
    const b = { path: 'src/b.ts', contentHash: 'h2' }
    expect(sourceFingerprint(['src/**/*.ts'], [a, b])).toBe(sourceFingerprint(['src/**/*.ts'], [b, a]))
  })
})
