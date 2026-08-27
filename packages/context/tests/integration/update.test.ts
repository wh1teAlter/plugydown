import type { FixtureDocument } from '../helpers/fixture.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL } from '../../src/runtime/constants.js'
import { run } from '../../src/runtime/runner.js'
import { createEmptyFixture, documentSource, removeFixture } from '../helpers/fixture.js'

const created: string[] = []
afterEach(async () => Promise.all(created.splice(0).map(removeFixture)))

const DOMAIN: FixtureDocument = {
  domain: 'service',
  name: 'domain.md',
  id: 'service',
  kind: 'domain',
  description: 'Service boundary.',
  codePaths: ['src/service.ts'],
  body: '# Service\n\nStable boundary.\n',
}

function op(document: FixtureDocument) {
  return { kind: 'write', target: `context/${document.domain}/${document.category === undefined ? document.name : `${document.category}/${document.name}`}`, contents: documentSource(document) }
}

async function initialized(): Promise<string> {
  const root = await createEmptyFixture()
  created.push(root)
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src/service.ts'), 'export const service = true\n')
  const response = await run(root, {
    protocol: PROTOCOL,
    capability: 'transaction.run',
    runId: 'init',
    params: { command: 'init', revision: 'r1', sourceState: 'r1', operations: [op(DOMAIN)] },
  })
  expect(response.status).toBe('success')
  return root
}

function updateRequest(overrides: Record<string, unknown> = {}) {
  const guide: FixtureDocument = { domain: 'service', category: 'manual', name: 'retry.md', id: 'service.retry', kind: 'guide', body: '# Retry\n\nUse bounded retries.\n' }
  return {
    protocol: PROTOCOL,
    capability: 'transaction.run',
    runId: 'update',
    params: {
      command: 'update',
      revision: 'r2',
      sourceState: 'r2',
      intentKnown: true,
      committedChangesCovered: true,
      git: { revision: 'r2', committed: 'A\0src/service.ts\0' },
      operations: [op(guide)],
      ...overrides,
    },
  }
}

describe('update workflow', () => {
  it('selects Light when all deterministic conditions are met', async () => {
    const response = await run(await initialized(), updateRequest())
    expect(response.status).toBe('success')
    expect(response.data).toMatchObject({ strategy: 'light', repositoryBaselineAdvanced: true })
  })

  it('selects Deep when intent is not established', async () => {
    const response = await run(await initialized(), updateRequest({ intentKnown: false }))
    expect(response.status).toBe('success')
    expect(response.data).toMatchObject({ strategy: 'deep' })
    expect(String((response.data as Record<string, unknown>).escalationReason)).toContain('intended')
  })

  it('escalates when the caller reports unknown impact', async () => {
    const response = await run(await initialized(), updateRequest({ unknownImpact: true }))
    expect(response.data).toMatchObject({ strategy: 'deep' })
    expect(String((response.data as Record<string, unknown>).escalationReason)).toContain('unknown')
  })

  it('updates a local scope without advancing the repository baseline', async () => {
    const root = await initialized()
    const response = await run(root, { ...updateRequest(), scope: { ids: ['service'] } })
    expect(response.status).toBe('success')
    expect(response.data).toMatchObject({ repositoryBaselineAdvanced: false })
    const ledger = JSON.parse(await fs.readFile(path.join(root, 'context/meta.json'), 'utf8'))
    expect(ledger.repository.baseline.revision).toBe('r1')
  })

  it('does not advance the baseline for a dirty worktree', async () => {
    const root = await initialized()
    const response = await run(root, updateRequest({ committedChangesCovered: false, git: { revision: 'r2', status: ' M src/service.ts' } }))
    expect(response.status).toBe('success')
    expect(response.data).toMatchObject({ repositoryBaselineAdvanced: false })
  })

  it('does not advance the baseline during a Git mid-operation state', async () => {
    const response = await run(await initialized(), updateRequest({ git: { revision: 'r2', midOperation: true, committed: 'A\0src/service.ts\0' } }))
    expect(response.status).toBe('success')
    expect(response.data).toMatchObject({ repositoryBaselineAdvanced: false })
  })

  it('returns no-op success when implementation detail changed but knowledge remains accurate', async () => {
    const response = await run(await initialized(), updateRequest({ knowledgeAccurate: true }))
    expect(response.status).toBe('success')
    expect(response.data).toMatchObject({ strategy: 'none', pruneSuggested: false })
  })

  it('suggests Prune only once for the same convergence baseline', async () => {
    const root = await initialized()
    const firstGuide: FixtureDocument = {
      domain: 'service',
      category: 'manual',
      name: 'first.md',
      id: 'service.first',
      kind: 'guide',
      body: '# First\n\nNew knowledge.\n',
    }
    const first = await run(root, updateRequest({
      operations: [op(firstGuide)],
      committedChangesCovered: false,
      git: { revision: 'r2', status: ' M src/service.ts' },
    }))
    expect(first.data).toMatchObject({ pruneSuggested: true })
    const secondGuide: FixtureDocument = {
      domain: 'service',
      category: 'manual',
      name: 'second.md',
      id: 'service.second',
      kind: 'guide',
      body: '# Second\n\nMore new knowledge.\n',
    }
    const second = await run(root, {
      ...updateRequest({
        operations: [op(secondGuide)],
        committedChangesCovered: false,
        git: { revision: 'r2', status: ' M src/service.ts' },
      }),
      runId: 'update-second',
    })
    expect(second.data).toMatchObject({ pruneSuggested: false })
  })

  it('rejects a candidate that targets outside formal knowledge', async () => {
    const response = await run(await initialized(), updateRequest({ operations: [{ kind: 'write', target: 'src/unsafe.ts', contents: 'unsafe\n' }] }))
    expect(response.status).toBe('incomplete')
    expect(response.summary).toContain('candidate')
  })
})
