import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL } from '../../src/runtime/constants.js'
import { run } from '../../src/runtime/runner.js'
import { createEmptyFixture, removeFixture } from '../helpers/fixture.js'

const created: string[] = []

afterEach(async () => Promise.all(created.splice(0).map(removeFixture)))

const domain = [
  '---',
  'schema: plugydown.context.document/v1',
  'id: service',
  'description: Service boundary.',
  'kind: domain',
  'domain: service',
  '---',
  '',
  '# Service',
  '',
  'Boundary.',
  '',
].join('\n')
const guide = [
  '---',
  'schema: plugydown.context.document/v1',
  'id: service.retry',
  'description: Retry guide.',
  'kind: guide',
  'domain: service',
  '---',
  '',
  '# Retry',
  '',
  'Use bounded retries.',
  '',
].join('\n')

function request(command: 'init' | 'update' | 'prune', operations: unknown[]) {
  return {
    protocol: PROTOCOL,
    capability: 'transaction.run',
    runId: command,
    params: {
      command,
      revision: 'r2',
      sourceState: 'r2',
      ...(command === 'update'
        ? { intentKnown: true, committedChangesCovered: true, git: { revision: 'r2', committed: 'M\0src/service.ts\0' } }
        : {}),
      operations,
    },
  }
}

async function snapshot(root: string): Promise<Readonly<Record<string, string>>> {
  const context = path.join(root, 'context')
  const result: Record<string, string> = {}
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory())
        await walk(file)
      else
        result[path.relative(context, file)] = await fs.readFile(file, 'utf8')
    }
  }
  await walk(context)
  return result
}

describe('unrelated knowledge directory independence', () => {
  it('produces byte-identical Init, Update, and Prune outcomes', async () => {
    const plain = await createEmptyFixture()
    const unrelated = await createEmptyFixture()
    created.push(plain, unrelated)
    for (const root of [plain, unrelated]) {
      await fs.mkdir(path.join(root, 'src'), { recursive: true })
      await fs.writeFile(path.join(root, 'src/service.ts'), 'export const service = true\n')
    }
    const ignoredDirectory = path.join(unrelated, 'llm' + 'doc')
    await fs.mkdir(ignoredDirectory)
    await fs.writeFile(path.join(ignoredDirectory, 'keep.md'), 'unrelated knowledge\n')

    for (const root of [plain, unrelated]) {
      expect((await run(root, request('init', [{ kind: 'write', target: 'context/service/domain.md', contents: domain }]))).status).toBe('success')
      expect((await run(root, request('update', [{ kind: 'write', target: 'context/service/manual/retry.md', contents: guide }]))).status).toBe('success')
      expect((await run(root, request('prune', [{ kind: 'delete', target: 'context/service/manual/retry.md' }]))).status).toBe('success')
    }

    expect(await snapshot(unrelated)).toEqual(await snapshot(plain))
    expect(await fs.readFile(path.join(ignoredDirectory, 'keep.md'), 'utf8')).toBe('unrelated knowledge\n')
  })
})
