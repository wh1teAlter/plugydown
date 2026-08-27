import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL } from '../../src/runtime/constants.js'
import { run } from '../../src/runtime/runner.js'
import { createEmptyFixture, removeFixture } from '../helpers/fixture.js'

const created: string[] = []
afterEach(async () => Promise.all(created.splice(0).map(removeFixture)))

describe('candidate ledger source fingerprints', () => {
  it('fingerprints source from the repository rather than the transaction candidate', async () => {
    const root = await createEmptyFixture()
    created.push(root)
    await fs.mkdir(path.join(root, 'src'), { recursive: true })
    await fs.writeFile(path.join(root, 'src/service.ts'), 'export const service = true\n')
    const document = [
      '---',
      'schema: plugydown.context.document/v1',
      'id: service',
      'description: Service boundary.',
      'kind: domain',
      'domain: service',
      'code:',
      '  paths:',
      '    - src/service.ts',
      '---',
      '',
      '# Service',
      '',
      'Boundary.',
      '',
    ].join('\n')
    const response = await run(root, {
      protocol: PROTOCOL,
      capability: 'transaction.run',
      params: { command: 'init', operations: [{ kind: 'write', target: 'context/service/domain.md', contents: document }] },
    })
    expect(response.status).toBe('success')
    const ledger = JSON.parse(await fs.readFile(path.join(root, 'context/meta.json'), 'utf8'))
    expect(ledger.documents.service.sourceFingerprint).toHaveLength(64)
  })
})
