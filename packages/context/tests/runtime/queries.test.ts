import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { call, CLIENT_DOMAIN, createRepository, removeRepository, REVISION_A, SERVICE_DOMAIN, SERVICE_GUIDE } from './fixture.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(removeRepository)))

const REFLECTION = {
  relativePath: 'service/reflections/retry-learning.md',
  id: 'service.retry-learning',
  kind: 'reflection' as const,
  domain: 'service',
  description: 'Retry corrections for transient failures.',
  relations: { related: ['service.retry'] },
  body: '# Retry learning\n\nRetry only transient failures and preserve permanent errors.\n',
}

async function ready(): Promise<string> {
  const root = await createRepository({ documents: [SERVICE_DOMAIN, SERVICE_GUIDE, CLIENT_DOMAIN, REFLECTION], baselineRevision: REVISION_A })
  roots.push(root)
  return root
}

describe('read queries', () => {
  it('reports absent, ready, and invalid Context/Meta L0 states without returning bodies or Git details', async () => {
    const absent = await createRepository()
    roots.push(absent)
    expect(await call(absent, 'repository.inspect', {})).toMatchObject({
      status: 'success',
      data: { context: { state: 'absent' }, meta: { state: 'absent' } },
    })

    const root = await ready()
    const readyResponse = await call(root, 'repository.inspect', {})
    expect(readyResponse).toMatchObject({
      status: 'success',
      data: { context: { state: 'ready' }, meta: { state: 'valid' }, counts: { domains: 2, documents: 4 } },
    })
    expect(JSON.stringify(readyResponse)).not.toContain('Retry only transient')
    expect(JSON.stringify(readyResponse)).not.toContain('currentRevision')
    expect(JSON.stringify(readyResponse)).not.toContain('relationCount')

    await fs.writeFile(path.join(root, 'context/meta.json'), '{}')
    const invalid = await call(root, 'repository.inspect', {})
    expect(invalid.data).toMatchObject({ context: { state: 'invalid' }, meta: { state: 'invalid' } })
    expect(invalid.diagnostics?.length).toBeGreaterThan(0)
  })

  it('reports a short active write run without blocking read-only queries', async () => {
    const root = await ready()
    const runId = '00000000-0000-4000-8000-000000000001'
    await fs.mkdir(path.join(root, `.scratch/locks/context-write`), { recursive: true })
    await fs.writeFile(path.join(root, `.scratch/locks/context-write/owner.json`), JSON.stringify({ runId }))
    await fs.mkdir(path.join(root, `.scratch/runs/${runId}`), { recursive: true })
    await fs.writeFile(path.join(root, `.scratch/runs/${runId}/manifest.json`), JSON.stringify({ runId, command: 'update', phase: 'staged' }))

    const inspect = await call(root, 'repository.inspect', {})
    expect(inspect.data?.activeRun).toEqual({ runId, command: 'update', phase: 'staged' })
    expect((await call(root, 'frontier.query', { depth: 1 })).status).toBe('success')
  })

  it('does not echo malformed lock owner or manifest identity values', async () => {
    const root = await ready()
    const runId = '00000000-0000-4000-8000-000000000002'
    await fs.mkdir(path.join(root, '.scratch/locks/context-write'), { recursive: true })
    await fs.writeFile(path.join(root, '.scratch/locks/context-write/owner.json'), JSON.stringify({ runId }))
    await fs.mkdir(path.join(root, `.scratch/runs/${runId}`), { recursive: true })
    await fs.writeFile(path.join(root, `.scratch/runs/${runId}/manifest.json`), JSON.stringify({ runId, command: '/tmp', phase: '/tmp' }))

    const inspect = await call(root, 'repository.inspect', {})

    expect(inspect.data?.activeRun).toBeUndefined()
    expect(inspect.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ACTIVE_RUN_INVALID', severity: 'warning' })]))
    expect(JSON.stringify(inspect)).not.toContain('/tmp')
  })

  it('provides L1 Domain metadata, L2 Document metadata, and only L3 bodies', async () => {
    const root = await ready()
    const l1 = await call(root, 'frontier.query', { depth: 1 })
    const l2 = await call(root, 'frontier.query', { depth: 2, selectors: { domainIds: ['service'] } })
    const l3 = await call(root, 'frontier.query', { depth: 3, selectors: { documentIds: ['service.retry'] }, requiresClosure: true })
    const l3Domain = await call(root, 'frontier.query', { depth: 3, selectors: { domainIds: ['service'] } })

    expect((l1.data?.items as unknown[])).toHaveLength(2)
    expect(JSON.stringify(l1.data)).not.toContain('body')
    expect((l2.data?.items as Array<Record<string, unknown>>)[0]?.id).toBe('service')
    expect(JSON.stringify(l2.data)).not.toContain('Retry only transient failures')
    expect(l3.data?.items).toEqual([
      expect.not.objectContaining({ id: 'service', body: expect.anything() }),
      expect.objectContaining({ id: 'service.retry', body: expect.stringContaining('Retry only transient failures') }),
    ])
    expect((l3Domain.data?.items as Array<Record<string, unknown>>).every(item => !('body' in item))).toBe(true)
  })

  it('supports Domain, Document, kind, relation, and code path selectors with explained requires closure', async () => {
    const root = await ready()
    const byDomain = await call(root, 'frontier.query', { depth: 2, selectors: { domainIds: ['client'] } })
    expect((byDomain.data?.items as Array<Record<string, unknown>>).map(item => item.id)).toEqual(['client'])

    const byDocument = await call(root, 'frontier.query', { depth: 2, selectors: { documentIds: ['service.retry'] }, requiresClosure: true })
    expect((byDocument.data?.items as Array<Record<string, unknown>>).map(item => item.id)).toEqual(['service', 'service.retry'])
    expect(JSON.stringify(byDocument.data)).toContain('required by service.retry')

    const byKind = await call(root, 'frontier.query', { depth: 2, selectors: { kinds: ['reflection'] } })
    expect((byKind.data?.items as Array<Record<string, unknown>>).map(item => item.id)).toEqual(['service.retry-learning'])

    const byRelation = await call(root, 'frontier.query', { depth: 2, selectors: { relation: { type: 'requires', documentId: 'service.retry' } } })
    expect((byRelation.data?.items as Array<Record<string, unknown>>).map(item => item.id)).toEqual(['service'])

    const byCode = await call(root, 'frontier.query', { depth: 2, selectors: { codePaths: ['src/retry.ts'] } })
    expect((byCode.data?.items as Array<Record<string, unknown>>).map(item => item.id)).toEqual(['service.retry'])
  })

  it('derives targeted source freshness for compact continuation', async () => {
    const root = await ready()
    const fresh = await call(root, 'repository.inspect', { selectedDocumentIds: ['service.retry', 'missing'] })
    expect(fresh.data?.selected).toEqual([
      expect.objectContaining({ id: 'missing', state: 'missing' }),
      expect.objectContaining({ id: 'service.retry', state: 'fresh' }),
    ])

    await fs.writeFile(path.join(root, 'src/retry.ts'), 'changed\n')
    const stale = await call(root, 'repository.inspect', { selectedDocumentIds: ['service.retry'] })
    expect(stale.data?.selected).toEqual([expect.objectContaining({ id: 'service.retry', state: 'stale' })])
  })

  it('measures current/baseline/delta/per-Domain growth and stable convergence candidates without writes', async () => {
    const { relations: _relations, codePaths: _codePaths, ...guideBase } = SERVICE_GUIDE
    const tinyA = { ...guideBase, id: 'service.a', relativePath: 'service/manual/a.md', body: '# A\n' }
    const tinyB = { ...tinyA, id: 'service.b', relativePath: 'service/manual/b.md' }
    const tinyC = { ...tinyA, id: 'service.c', relativePath: 'service/manual/c.md' }
    const root = await createRepository({ documents: [SERVICE_DOMAIN, tinyA, tinyB, tinyC] })
    roots.push(root)
    const before = JSON.stringify((await call(root, 'repository.inspect', {})).data)
    const first = await call(root, 'growth.measure', {})
    const second = await call(root, 'growth.measure', {})

    expect(first.status).toBe('success')
    expect(first.data).toMatchObject({ current: { documentCount: 4 }, baseline: { source: 'init' }, delta: { documentCount: 0 } })
    expect(first.data?.perDomain).toHaveProperty('service')
    expect(JSON.stringify(first.data?.candidates)).toContain('fragmented')
    expect(first).toEqual(second)
    expect(JSON.stringify((await call(root, 'repository.inspect', {})).data)).toBe(before)
  })

  it('matches temporary Feedback and formal Reflection deterministically without score, promotion, or writes', async () => {
    const root = await ready()
    const feedbackPath = '.scratch/feedback/retry-deadbeef.md'
    await fs.mkdir(path.dirname(path.join(root, feedbackPath)), { recursive: true })
    const feedback = '# Context\nRetry requests\n# Observed behavior\nPermanent errors retried\n# Outcome or correction\nRetry transient failures only\n# Evidence\nsrc/retry.ts\n# Reuse boundary\nService requests\n'
    await fs.writeFile(path.join(root, feedbackPath), feedback)
    const input = { context: 'Retry service requests', observedBehavior: 'Permanent errors retried', outcomeOrCorrection: 'Retry transient failures only', reuseBoundary: 'Service requests' }
    const first = await call(root, 'feedback.match', input)
    const second = await call(root, 'feedback.match', input)

    expect(first.status).toBe('success')
    expect(first.data?.suggestedId).toBe(second.data?.suggestedId)
    expect(first.data?.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'feedback', id: 'retry-deadbeef' }),
      expect.objectContaining({ kind: 'reflection', id: 'service.retry-learning' }),
    ]))
    expect(JSON.stringify(first)).not.toMatch(/score|mature|promot/i)
    expect(await fs.readFile(path.join(root, feedbackPath), 'utf8')).toBe(feedback)
  })

  it('paginates Growth and Feedback candidates instead of truncating them', async () => {
    const root = await ready()
    await fs.mkdir(path.join(root, '.scratch/feedback'), { recursive: true })
    for (const name of ['one-deadbeef', 'two-cafebabe']) {
      await fs.writeFile(path.join(root, `.scratch/feedback/${name}.md`), '# Context\nretry\n# Observed behavior\nretry\n# Outcome or correction\nretry\n# Evidence\nretry\n# Reuse boundary\nretry\n')
    }
    const response = await call(root, 'feedback.match', { context: 'retry', observedBehavior: 'retry', outcomeOrCorrection: 'retry', reuseBoundary: 'retry' }, {
      budget: { items: 1, bytes: 1024 * 1024, estimatedTokens: 128000 },
    })
    expect(response.status).toBe('incomplete')
    expect(response.cursor).toEqual(expect.any(String))
  })

  it('rejects Feedback outside the unified slug plus short content hash naming contract', async () => {
    const root = await ready()
    await fs.mkdir(path.join(root, '.scratch/feedback'), { recursive: true })
    await fs.writeFile(path.join(root, '.scratch/feedback/retry.md'), '# Context\nretry\n# Observed behavior\nretry\n# Outcome or correction\nretry\n# Evidence\nretry\n# Reuse boundary\nretry\n')

    const response = await call(root, 'feedback.match', { context: 'retry', observedBehavior: 'retry', outcomeOrCorrection: 'retry', reuseBoundary: 'retry' })

    expect(response).toMatchObject({ status: 'failed', diagnostics: [{ code: 'FEEDBACK_FILE_INVALID' }] })
  })
})
