import type { FixtureDocument } from '../helpers/fixture.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL } from '../../src/runtime/constants.js'
import { run } from '../../src/runtime/runner.js'
import { createEmptyFixture, documentSource, removeFixture } from '../helpers/fixture.js'

const created: string[] = []
afterEach(async () => Promise.all(created.splice(0).map(removeFixture)))

const domain: FixtureDocument = { domain: 'service', name: 'domain.md', id: 'service', kind: 'domain', body: '# Service\n\nBoundary.\n' }
const guide: FixtureDocument = { domain: 'service', category: 'manual', name: 'retry.md', id: 'service.retry', kind: 'guide', body: '# Retry\n\nUse bounded retries.\n' }
const covered: FixtureDocument = { domain: 'service', category: 'manual', name: 'covered.md', id: 'service.covered', kind: 'guide', codePaths: ['src/service.ts'], body: '# Covered\n\nUnique source mapping.\n' }

async function setup(documents: readonly FixtureDocument[]): Promise<string> {
  const root = await createEmptyFixture()
  created.push(root)
  const operations = documents.map(document => ({ kind: 'write', target: `context/${document.domain}/${document.category === undefined ? document.name : `${document.category}/${document.name}`}`, contents: documentSource(document) }))
  const response = await run(root, { protocol: PROTOCOL, capability: 'transaction.run', runId: 'init', params: { command: 'init', revision: 'r1', operations } })
  expect(response.status).toBe('success')
  return root
}

describe('prune workflow', () => {
  it('commits a convergence that reduces every tracked size metric', async () => {
    const root = await setup([domain, guide])
    const response = await run(root, { protocol: PROTOCOL, capability: 'transaction.run', runId: 'prune', params: { command: 'prune', operations: [{ kind: 'delete', target: 'context/service/manual/retry.md' }] } })
    expect(response.status).toBe('success')
    expect((response.data as Record<string, unknown>).after).toBeDefined()
    await expect(fs.stat(path.join(root, 'context/service/manual/retry.md'))).rejects.toThrow()
    const ledger = JSON.parse(await fs.readFile(path.join(root, 'context/meta.json'), 'utf8'))
    expect(ledger.convergence.source).toBe('prune')
  })

  it('rejects a fake decrease that removes unique code-path coverage', async () => {
    const root = await setup([domain, covered])
    const response = await run(root, { protocol: PROTOCOL, capability: 'transaction.run', runId: 'prune', params: { command: 'prune', operations: [{ kind: 'delete', target: 'context/service/manual/covered.md' }] } })
    expect(response.status).toBe('incomplete')
    expect(JSON.stringify(response.data)).toContain('PRUNE_COVERAGE_DECREASED')
    expect(await fs.readFile(path.join(root, 'context/service/manual/covered.md'), 'utf8')).toContain('service.covered')
  })
})
