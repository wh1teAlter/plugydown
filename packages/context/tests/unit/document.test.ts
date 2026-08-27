import { describe, expect, it } from 'vitest'
import { checkPlacement, parseDocument, splitFrontMatter } from '../../src/runtime/document.js'

/** @returns a valid document source with the given front matter overrides applied. */
function source(overrides: Record<string, string> = {}, body = '# Title\n\nContent.\n'): string {
  const fields: Record<string, string> = {
    schema: 'plugydown.context.document/v1',
    id: 'api-client.retry',
    description: 'Retry rules.',
    kind: 'guide',
    domain: 'api-client',
    ...overrides,
  }
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}: ${value}`)
  return `---\n${lines.join('\n')}\n---\n\n${body}`
}

/** @returns the issue codes a source produces. */
function codes(raw: string): string[] {
  const result = parseDocument('context/api-client/manual/retry.md', raw)
  return result.ok ? [] : result.issues.map(issue => issue.code)
}

describe('front matter extraction', () => {
  it('splits a well-formed document', () => {
    expect(splitFrontMatter(source())).toMatchObject({ body: '\n# Title\n\nContent.\n' })
  })

  it('tolerates CRLF and a byte order mark', () => {
    expect(splitFrontMatter('﻿---\r\nid: a\r\n---\r\nbody\r\n')).toBeDefined()
  })

  it('returns undefined without a front matter block', () => {
    expect(splitFrontMatter('# Title\n')).toBeUndefined()
  })
})

describe('required fields', () => {
  it('accepts a minimal valid document', () => {
    const result = parseDocument('context/api-client/manual/retry.md', source())
    expect(result.ok).toBe(true)
  })

  it.each([
    [{ schema: `${'llm' + 'doc'}.${'document'}/v1` }, 'DOCUMENT_SCHEMA_INVALID'],
    [{ id: 'Api_Client' }, 'DOCUMENT_ID_INVALID'],
    [{ description: '' }, 'DOCUMENT_DESCRIPTION_INVALID'],
    [{ kind: 'manual' }, 'DOCUMENT_KIND_INVALID'],
    [{ domain: 'api.client' }, 'DOCUMENT_DOMAIN_INVALID'],
  ])('rejects %j with %s', (overrides, code) => {
    expect(codes(source(overrides))).toContain(code)
  })

  it('rejects an empty body', () => {
    expect(codes(source({}, '   \n'))).toContain('DOCUMENT_BODY_EMPTY')
  })

  it('rejects a missing front matter block', () => {
    expect(codes('# Title\n')).toContain('DOCUMENT_FRONT_MATTER_MISSING')
  })
})

describe('forbidden persisted metadata', () => {
  it.each(['commit', 'hash', 'validated_at', 'cursor', 'session', 'score'])('rejects %s', (field) => {
    expect(codes(source({ [field]: 'x' }))).toContain('DOCUMENT_FIELD_FORBIDDEN')
  })

  it('rejects an unknown field', () => {
    expect(codes(source({ author: 'someone' }))).toContain('DOCUMENT_FIELD_UNKNOWN')
  })
})

describe('code declarations', () => {
  it('accepts anchored paths and globs', () => {
    const raw = `---
schema: plugydown.context.document/v1
id: api-client.retry
description: Retry rules.
kind: guide
domain: api-client
code:
  paths:
    - src/api/retry.ts
    - src/api/**/*.ts
---

# Title
`
    expect(parseDocument('context/api-client/manual/retry.md', raw).ok).toBe(true)
  })

  it.each(['../outside.ts', '/etc/passwd', '*.ts', '$HOME/a.ts'])('rejects unsafe code path %j', (candidate) => {
    const raw = `---
schema: plugydown.context.document/v1
id: api-client.retry
description: Retry rules.
kind: guide
domain: api-client
code:
  paths:
    - '${candidate}'
---

# Title
`
    expect(codes(raw)).toContain('DOCUMENT_CODE_PATH_UNSAFE')
  })
})

describe('placement', () => {
  it('accepts a domain document at the Domain root', () => {
    const result = parseDocument('context/api-client/domain.md', source({ id: 'api-client', kind: 'domain' }))
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(checkPlacement(result.document, undefined)).toBeUndefined()
  })

  it('rejects a guide at the Domain root', () => {
    const result = parseDocument('context/api-client/retry.md', source())
    if (result.ok)
      expect(checkPlacement(result.document, undefined)?.code).toBe('DOCUMENT_PLACEMENT_INVALID')
  })

  it.each([
    ['manual', 'guide', true],
    ['manual', 'architecture', false],
    ['design', 'decision', true],
    ['design', 'reference', false],
    ['reflections', 'reflection', true],
  ])('places %s/%s correctly', (category, kind, legal) => {
    const result = parseDocument(`context/api-client/${category}/a.md`, source({ kind }))
    if (result.ok)
      expect(checkPlacement(result.document, category) === undefined).toBe(legal)
  })
})
