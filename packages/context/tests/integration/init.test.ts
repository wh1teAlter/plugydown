import type { FixtureDocument } from '../helpers/fixture.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL } from '../../src/runtime/constants.js'
import { run } from '../../src/runtime/runner.js'
import { createEmptyFixture, createFixture, documentSource, removeFixture } from '../helpers/fixture.js'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map(removeFixture))
})

const DOMAIN: FixtureDocument = {
  domain: 'service',
  name: 'domain.md',
  id: 'service',
  kind: 'domain',
  description: 'The fixture service boundary.',
  codePaths: ['src/service.ts'],
  body: '# Service\n\nThe bounded service surface.\n',
}

/** @returns one Init request with a Recorder candidate that establishes a valid Domain. */
function initRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: PROTOCOL,
    capability: 'transaction.run',
    runId: 'first-init',
    params: {
      command: 'init',
      revision: 'abc123',
      sourceState: 'abc123',
      operations: [{ kind: 'write', target: 'context/service/domain.md', contents: documentSource(DOMAIN) }],
      ...overrides,
    },
  }
}

describe('init workflow', () => {
  it('commits a valid minimum Domain set and convergence baseline', async () => {
    const root = await createEmptyFixture()
    created.push(root)
    await fs.mkdir(path.join(root, 'src'), { recursive: true })
    await fs.writeFile(path.join(root, 'src/service.ts'), 'export const service = true\n')

    const response = await run(root, initRequest())

    expect(response.status).toBe('success')
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')).toContain('id: service')
    await expect(fs.stat(path.join(root, 'context/service/design'))).rejects.toThrow()
    await expect(fs.stat(path.join(root, 'context/index.md'))).rejects.toThrow()
    const ledger = JSON.parse(await fs.readFile(path.join(root, 'context/meta.json'), 'utf8'))
    expect(ledger.convergence).toMatchObject({ source: 'init', documentCount: 1 })
    expect(ledger.repository.baseline.revision).toBe('abc123')
  })

  it('suggests Update instead of overwriting valid formal knowledge', async () => {
    const root = await createFixture([DOMAIN])
    created.push(root)
    await fs.writeFile(path.join(root, 'context/meta.json'), JSON.stringify({
      $schema: 'plugydown.context.meta/v1',
      toolVersion: '0.1.0',
      fingerprintVersion: '1',
      documents: {
        service: { frontMatterFingerprint: 'a', bodyFingerprint: 'b', status: 'valid' },
      },
    }))

    const response = await run(root, initRequest())

    expect(response.status).toBe('incomplete')
    expect(response.summary).toContain('update')
  })

  it('does not inspect or change an unrelated knowledge directory', async () => {
    const root = await createEmptyFixture()
    created.push(root)
    const unrelated = path.join(root, 'legacy-knowledge')
    await fs.mkdir(unrelated, { recursive: true })
    await fs.writeFile(path.join(unrelated, 'keep.md'), 'unchanged\n')

    const response = await run(root, initRequest())

    expect(response.status).toBe('success')
    expect(await fs.readFile(path.join(unrelated, 'keep.md'), 'utf8')).toBe('unchanged\n')
  })

  it('returns incomplete without a Recorder candidate and leaves formal knowledge absent', async () => {
    const root = await createEmptyFixture()
    created.push(root)

    const response = await run(root, {
      protocol: PROTOCOL,
      capability: 'transaction.run',
      params: { command: 'init' },
    })

    expect(response.status).toBe('incomplete')
    expect(response.summary).toContain('Recorder candidate')
    await expect(fs.stat(path.join(root, 'context'))).rejects.toThrow()
  })

  it('leaves a recoverable candidate on semantic evidence failure', async () => {
    const root = await createEmptyFixture()
    created.push(root)

    const response = await run(root, initRequest({ reviewApproved: false }))

    expect(response.status).toBe('incomplete')
    expect(await fs.readFile(path.join(root, '.scratch/runs/init/first-init/candidate/context/service/domain.md'), 'utf8')).toContain('id: service')
    await expect(fs.stat(path.join(root, 'context'))).rejects.toThrow()
  })
})
