import { Buffer } from 'node:buffer'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleRequest } from '../../src/runtime/handler.js'
import { call, CLIENT_DOMAIN, createRepository, PROTOCOL, removeRepository, REVISION_A, runtimeRequest, SERVICE_DOMAIN, SERVICE_GUIDE, writeGitEvidence, writeMeta } from './fixture.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRepository))
})

async function ready(): Promise<string> {
  const root = await createRepository({ documents: [SERVICE_DOMAIN, SERVICE_GUIDE, CLIENT_DOMAIN], baselineRevision: REVISION_A })
  roots.push(root)
  return root
}

async function paginationReady(): Promise<string> {
  const extras = Array.from({ length: 8 }, (_, index) => ({
    relativePath: `extra${index}/domain.md`,
    id: `extra${index}`,
    kind: 'domain' as const,
    domain: `extra${index}`,
    description: `Extra Domain ${index}.`,
    body: `# Extra ${index}\n\nExtra Domain body.\n`,
  }))
  const root = await createRepository({ documents: [SERVICE_DOMAIN, SERVICE_GUIDE, CLIENT_DOMAIN, ...extras], baselineRevision: REVISION_A })
  roots.push(root)
  return root
}

describe('runtime protocol', () => {
  it('accepts each read capability through the single handler', async () => {
    const root = await ready()
    const evidence = await writeGitEvidence(root)
    const requests = [
      runtimeRequest('repository.inspect', {}),
      runtimeRequest('frontier.query', { depth: 1 }),
      runtimeRequest('graph.validate', {}),
      runtimeRequest('delta.compute', {
        gitEvidencePath: evidence,
        scope: { kind: 'repository' },
        taskEvidence: { intentKnown: true, scopeComplete: true, newCapabilitySuspected: false, crossDomainContractUncertain: false },
      }),
      runtimeRequest('growth.measure', {}),
      runtimeRequest('feedback.match', { context: 'retry', observedBehavior: 'retry failed', outcomeOrCorrection: 'retry transient failures', reuseBoundary: 'service requests' }),
    ]

    for (const request of requests) {
      const response = await handleRequest(root, request)
      expect(response.protocol).toBe(PROTOCOL)
      expect(response.status).toBe('success')
    }
  })

  it.each([
    [{ protocol: 'unknown/v1', capability: 'repository.inspect', input: {} }, 'PROTOCOL_UNSUPPORTED'],
    [{ protocol: PROTOCOL, capability: 'unknown', input: {} }, 'CAPABILITY_UNKNOWN'],
    [{ protocol: PROTOCOL, capability: 'repository.inspect', input: {}, extra: true }, 'REQUEST_FIELD_UNKNOWN'],
    [{ protocol: PROTOCOL, capability: 'graph.validate', input: { directory: 'candidate' } }, 'REQUEST_FIELD_UNKNOWN'],
    [{ protocol: PROTOCOL, capability: 'graph.validate', action: 'validate', input: {} }, 'REQUEST_FIELD_INVALID'],
    [{ protocol: PROTOCOL, capability: 'transaction', input: {} }, 'ACTION_UNKNOWN'],
    [{ protocol: PROTOCOL, capability: 'transaction', action: 'remove', input: {} }, 'ACTION_UNKNOWN'],
    [{ protocol: PROTOCOL, capability: 'transaction', action: 'validate', input: { runId: '11111111-1111-4111-8111-111111111111', extra: true } }, 'REQUEST_FIELD_UNKNOWN'],
    [{ protocol: PROTOCOL, capability: 'transaction', action: 'resume', input: { runId: '11111111-1111-4111-8111-111111111111' }, budget: { items: 1 } }, 'REQUEST_FIELD_INVALID'],
    [{ protocol: PROTOCOL, capability: 'transaction', action: 'begin', input: { command: 'init', mode: 'deep', dryRun: false, scope: { kind: 'repository' }, gitEvidencePath: 'evidence', evidencePaths: ['src/service.ts'], runId: '11111111-1111-4111-8111-111111111111' } }, 'REQUEST_FIELD_UNKNOWN'],
    [{ protocol: PROTOCOL, capability: 'transaction', action: 'commit', input: { runId: '11111111-1111-4111-8111-111111111111', approval: { approved: false, candidateFingerprint: '0'.repeat(64), sourceEvidenceFingerprint: '0'.repeat(64), summary: 'reviewed' } } }, 'APPROVAL_INVALID'],
    [{ protocol: PROTOCOL, capability: 'transaction', action: 'commit', input: { runId: '11111111-1111-4111-8111-111111111111' } }, 'REQUEST_FIELD_MISSING'],
    [{ protocol: PROTOCOL, capability: 'transaction', action: 'commit', input: { runId: '11111111-1111-4111-8111-111111111111', approval: { approved: true, candidateFingerprint: '0'.repeat(64), sourceEvidenceFingerprint: '0'.repeat(64), summary: '' } } }, 'REQUEST_FIELD_INVALID'],
    [{ protocol: PROTOCOL, capability: 'frontier.query', input: { depth: 2 } }, 'REQUEST_FIELD_INVALID'],
    [{ protocol: PROTOCOL, capability: 'frontier.query', input: { depth: 2, selectors: { domainIds: ['Service'] } } }, 'REQUEST_FIELD_INVALID'],
    [{ protocol: PROTOCOL, capability: 'frontier.query', input: { depth: 2, selectors: { documentIds: ['service..retry'] } } }, 'REQUEST_FIELD_INVALID'],
    [{ protocol: PROTOCOL, capability: 'feedback.match', input: { context: '', observedBehavior: 'x', outcomeOrCorrection: 'y', reuseBoundary: 'z' } }, 'REQUEST_FIELD_INVALID'],
  ])('rejects strict-envelope or payload violation %#', async (request, code) => {
    const root = await ready()
    const response = await handleRequest(root, request)

    expect(response.status).toBe('failed')
    expect(response.capability).toBe(typeof request.capability === 'string' && request.capability !== 'unknown' ? request.capability : 'unknown')
    expect(response.diagnostics?.[0]?.code).toBe(code)
  })

  it.each([
    [{ items: 1001 }, 'items'],
    [{ bytes: 1024 * 1024 + 1 }, 'bytes'],
    [{ estimatedTokens: 128001 }, 'estimatedTokens'],
  ])('rejects budget hard-limit overflow for %s', async (budget, _field) => {
    const root = await ready()
    const response = await call(root, 'frontier.query', { depth: 1 }, { budget })

    expect(response.status).toBe('failed')
    expect(response.diagnostics?.[0]?.code).toBe('BUDGET_INVALID')
  })

  it.each([
    { items: 1, bytes: 1024 * 1024, estimatedTokens: 128000 },
    { items: 1000, bytes: 1_400, estimatedTokens: 128000 },
    { items: 1000, bytes: 1024 * 1024, estimatedTokens: 400 },
  ])('returns a cursor when any budget dimension is exhausted and completes with a larger budget', async (budget) => {
    const root = await paginationReady()
    const first = await call(root, 'frontier.query', { depth: 1 }, { budget })

    expect(first.status).toBe('incomplete')
    expect(first.cursor).toEqual(expect.any(String))
    expect(Buffer.byteLength(`${JSON.stringify(first, null, 2)}\n`)).toBeLessThanOrEqual(budget.bytes)
    expect(Math.ceil(Buffer.byteLength(JSON.stringify(first)) / 3)).toBeLessThanOrEqual(budget.estimatedTokens)

    const final = await call(root, 'frontier.query', { depth: 1 }, {
      cursor: first.cursor as string,
      budget: { items: 1000, bytes: 1024 * 1024, estimatedTokens: 128000 },
    })
    expect(final.status).toBe('success')
    expect(final.cursor).toBeUndefined()
  })

  it('fails stably when one result item cannot fit under the hard output limits', async () => {
    const huge = {
      ...SERVICE_GUIDE,
      id: 'service.huge',
      relativePath: 'service/manual/huge.md',
      body: `# Huge\n\n${'\\\n'.repeat(300_000)}`,
    }
    const root = await createRepository({ documents: [SERVICE_DOMAIN, huge], baselineRevision: REVISION_A })
    roots.push(root)

    const response = await call(root, 'frontier.query', { depth: 3, selectors: { documentIds: [huge.id] } }, {
      budget: { items: 1000, bytes: 1024 * 1024, estimatedTokens: 128000 },
    })

    expect(response.status).toBe('failed')
    expect(response.cursor).toBeUndefined()
    expect(response.diagnostics?.[0]?.code).toBe('RESULT_ITEM_TOO_LARGE')
  })

  it('returns success with an empty list instead of an incomplete result', async () => {
    const root = await ready()
    const response = await call(root, 'frontier.query', { depth: 2, selectors: { documentIds: ['missing'] } })

    expect(response.status).toBe('success')
    expect(response.data?.items).toEqual([])
  })

  it('rejects cursor tampering, query changes, and Context changes', async () => {
    const root = await ready()
    const input = { depth: 1 }
    const first = await call(root, 'frontier.query', input, { budget: { items: 1, bytes: 1024 * 1024, estimatedTokens: 128000 } })
    const cursor = first.cursor as string

    const tampered = await call(root, 'frontier.query', input, { cursor: `${cursor.slice(0, -1)}A` })
    expect(tampered.status).toBe('failed')
    expect(tampered.diagnostics?.[0]?.code).toMatch(/^CURSOR_(?:INVALID|STALE)$/)

    const changedQuery = await call(root, 'frontier.query', { depth: 1, selectors: { domainIds: ['service'] } }, { cursor })
    expect(changedQuery.status).toBe('failed')
    expect(changedQuery.diagnostics?.[0]?.code).toBe('CURSOR_STALE')

    const changed = { ...CLIENT_DOMAIN, body: '# Client\n\nChanged but valid.\n' }
    await fs.writeFile(path.join(root, 'context/client/domain.md'), (await import('./fixture.js')).documentSource(changed))
    await writeMeta(root, [SERVICE_DOMAIN, SERVICE_GUIDE, changed], { baselineRevision: REVISION_A })
    const changedContext = await call(root, 'frontier.query', input, { cursor })
    expect(changedContext.status).toBe('failed')
    expect(changedContext.diagnostics?.[0]?.code).toBe('CURSOR_STALE')
  })

  it('keeps product failures structured, stable, and free of absolute paths', async () => {
    const root = await ready()
    const response = await handleRequest(root, { protocol: PROTOCOL, capability: 'graph.validate', input: {}, [root]: true })
    const serialized = JSON.stringify(response)

    expect(response.status).toBe('failed')
    expect(serialized).not.toContain(root)
    expect(response.diagnostics?.map(item => item.code)).toEqual([...response.diagnostics ?? []].map(item => item.code).sort())
  })

  it.each([
    ['frontier.query', undefined, { depth: 2, selectors: { codePaths: ['/Users/private/source.ts'] } }],
    ['delta.compute', undefined, {
      gitEvidencePath: '.scratch/evidence/request',
      scope: { kind: 'paths', paths: ['../private.ts'] },
      taskEvidence: { intentKnown: true, scopeComplete: true, newCapabilitySuspected: false, crossDomainContractUncertain: false },
    }],
    ['transaction', 'begin', {
      command: 'update',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath: '.scratch/evidence/request',
      evidencePaths: ['/Users/private/source.ts'],
    }],
    ['transaction', 'begin', {
      command: 'update',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'paths', paths: ['../private.ts'] },
      gitEvidencePath: '.scratch/evidence/request',
      evidencePaths: ['src/service.ts'],
    }],
  ])('rejects unsafe request paths before repository access without echoing them', async (capability, action, input) => {
    const root = await ready()
    const request = { protocol: PROTOCOL, capability, ...(action === undefined ? {} : { action }), input }
    const response = await handleRequest(root, request)

    expect(response.status).toBe('failed')
    expect(response.diagnostics?.[0]?.code).toMatch(/^PATH_/)
    expect(response.diagnostics?.[0]?.path).toBeUndefined()
    expect(JSON.stringify(response)).not.toMatch(/Users|private/)
  })

  it('propagates unexpected Runtime exceptions to the transport adapter', async () => {
    const root = await ready()
    const request = {
      protocol: PROTOCOL,
      capability: 'repository.inspect',
      get input(): never {
        throw new Error('unexpected')
      },
    }

    await expect(handleRequest(root, request)).rejects.toThrow('unexpected')
  })
})
