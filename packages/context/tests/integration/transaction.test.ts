import type { Phase, TransactionInput } from '../../src/runtime/transaction.js'
import type { FixtureDocument } from '../helpers/fixture.js'
import fsSync, { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyLedger } from '../../src/runtime/meta.js'
import { runTransaction } from '../../src/runtime/transaction.js'
import { createFixture, documentSource, removeFixture } from '../helpers/fixture.js'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map(removeFixture))
})

const DOMAIN: FixtureDocument = { domain: 'api-client', name: 'domain.md', id: 'api-client', kind: 'domain' }
const GUIDE: FixtureDocument = {
  domain: 'api-client',
  category: 'manual',
  name: 'retry.md',
  id: 'api-client.retry',
  kind: 'guide',
}

/** @returns a fixture repository cleaned up after the test. */
async function repository(documents: readonly FixtureDocument[] = [DOMAIN]): Promise<string> {
  const root = await createFixture(documents)
  created.push(root)
  return root
}

/** @returns transaction input with the given overrides applied. */
function input(root: string, overrides: Partial<TransactionInput> = {}): TransactionInput {
  return {
    root,
    runId: 'r1',
    command: 'update',
    mode: 'synchronize',
    scope: {},
    authorization: { source: 'explicit-invocation' },
    operations: [{
      kind: 'write',
      target: 'context/api-client/manual/retry.md',
      contents: documentSource(GUIDE),
    }],
    ledger: emptyLedger('0.1.0'),
    validate: async () => [],
    review: async () => ({ approved: true }),
    ...overrides,
  }
}

/** @returns the contents of a repository file, or undefined when absent. */
async function read(root: string, target: string): Promise<string | undefined> {
  return fs.readFile(path.join(root, target), 'utf8').catch(() => undefined)
}

describe('successful commit', () => {
  it('writes the candidate and the ledger together', async () => {
    const root = await repository()
    const result = await runTransaction(input(root))

    expect(result.status).toBe('success')
    expect(result.reachedPhase).toBe('verify')
    expect(await read(root, 'context/api-client/manual/retry.md')).toContain('api-client.retry')
    expect(await read(root, 'context/meta.json')).toContain('plugydown.context.meta/v1')
  })

  it('records every applied operation in the journal', async () => {
    const result = await runTransaction(input(await repository()))
    expect(result.journal.operations.every(entry => entry.state === 'applied')).toBe(true)
    expect(result.journal.recovery).toBeUndefined()
  })

  it('commits a delete through recoverable staging', async () => {
    const root = await repository([DOMAIN, GUIDE])
    const result = await runTransaction(input(root, {
      operations: [{ kind: 'delete', target: 'context/api-client/manual/retry.md' }],
    }))

    expect(result.status).toBe('success')
    expect(await read(root, 'context/api-client/manual/retry.md')).toBeUndefined()
  })
})

describe('gates before commit', () => {
  it('stops on deterministic validation and leaves formal knowledge untouched', async () => {
    const root = await repository()
    const result = await runTransaction(input(root, { validate: async () => ['DOCUMENT_ID_DUPLICATE'] }))

    expect(result.status).toBe('incomplete')
    expect(result.reachedPhase).toBe('validate')
    expect(await read(root, 'context/api-client/manual/retry.md')).toBeUndefined()
  })

  it('stops on semantic review without committing', async () => {
    const root = await repository()
    const result = await runTransaction(input(root, {
      review: async () => ({ approved: false, reason: 'Evidence is insufficient.' }),
    }))

    expect(result.status).toBe('incomplete')
    expect(result.reachedPhase).toBe('review')
    expect(result.issues).toContain('Evidence is insufficient.')
    expect(await read(root, 'context/api-client/manual/retry.md')).toBeUndefined()
  })

  it('preserves the candidate for inspection after review declines it', async () => {
    const root = await repository()
    await runTransaction(input(root, { review: async () => ({ approved: false }) }))
    expect(await read(root, '.scratch/runs/update/r1/candidate/context/api-client/manual/retry.md')).toBeDefined()
  })

  it('stops when a target changed after the snapshot', async () => {
    const root = await repository([DOMAIN, GUIDE])
    const result = await runTransaction(input(root, {
      review: async () => {
        await fs.writeFile(path.join(root, 'context/api-client/manual/retry.md'), 'concurrent edit\n')
        return { approved: true }
      },
    }))

    expect(result.status).toBe('incomplete')
    expect(result.reachedPhase).toBe('concurrency-check')
    expect(await read(root, 'context/api-client/manual/retry.md')).toBe('concurrent edit\n')
  })

  it('detects a concurrent ledger edit even when no document changed', async () => {
    const root = await repository()
    const result = await runTransaction(input(root, {
      review: async () => {
        await fs.writeFile(path.join(root, 'context/meta.json'), '{}')
        return { approved: true }
      },
    }))

    expect(result.reachedPhase).toBe('concurrency-check')
    expect(result.status).toBe('incomplete')
  })

  it('does not modify formal knowledge on a dry run', async () => {
    const root = await repository()
    const result = await runTransaction(input(root, {
      authorization: { source: 'explicit-invocation', dryRun: true },
    }))

    expect(result.status).toBe('success')
    expect(await read(root, 'context/api-client/manual/retry.md')).toBeUndefined()
  })
})

describe('fault injection', () => {
  /** @returns the result of a transaction that throws in the given phase. */
  async function inject(root: string, phase: Phase, overrides: Partial<TransactionInput> = {}): ReturnType<typeof runTransaction> {
    return runTransaction(input(root, {
      ...overrides,
      faults: { [phase]: () => { throw new Error(`injected ${phase} failure`) } },
    }))
  }

  it.each(['snapshot', 'stage', 'validate', 'review', 'concurrency-check'] as const)(
    'leaves formal knowledge untouched when %s throws',
    async (phase) => {
      const root = await repository()
      const result = await inject(root, phase)

      expect(result.status).toBe('failed')
      expect(await read(root, 'context/api-client/manual/retry.md')).toBeUndefined()
      expect(result.journal.recovery).toBeUndefined()
    },
  )

  it('restores every applied file when the commit throws midway', async () => {
    const root = await repository([DOMAIN, GUIDE])
    const before = await read(root, 'context/api-client/manual/retry.md')

    const result = await inject(root, 'commit', {
      operations: [
        { kind: 'write', target: 'context/api-client/manual/retry.md', contents: 'rewritten\n' },
        { kind: 'write', target: 'context/api-client/manual/second.md', contents: 'new\n' },
      ],
    })

    expect(result.status).toBe('failed')
    expect(result.journal.recovery?.outcome).toBe('recovered')
    expect(await read(root, 'context/api-client/manual/retry.md')).toBe(before)
    expect(await read(root, 'context/api-client/manual/second.md')).toBeUndefined()
  })

  it('reports failed, not recovered, when a restore cannot be performed', async () => {
    const root = await repository([DOMAIN, GUIDE])
    const target = path.join(root, 'context/api-client/manual/retry.md')
    let applied = false

    const result = await runTransaction(input(root, {
      operations: [{ kind: 'write', target: 'context/api-client/manual/retry.md', contents: 'rewritten\n' }],
      faults: {
        commit: () => {
          /** Make the just-committed file unwritable so the restore genuinely fails. */
          if (applied)
            return
          applied = true
          fsSync.chmodSync(target, 0o444)
          throw new Error('injected commit failure')
        },
      },
    }))

    /** Restore the mode first so the fixture can be cleaned up regardless of assertions. */
    fsSync.chmodSync(target, 0o644)

    expect(result.status).toBe('failed')
    expect(result.journal.recovery?.outcome).toBe('failed')
    expect(result.summary).toContain('could not be fully restored')
    expect(result.issues.join(' ')).toContain('not in a known-good state')
  })

  it('reports a mismatch when verification finds committed bytes differ', async () => {
    const root = await repository()
    const result = await runTransaction(input(root, {
      faults: {
        verify: () => { throw new Error('injected verify failure') },
      },
    }))

    expect(result.status).toBe('failed')
    expect(result.journal.recovery?.outcome).toBeDefined()
  })
})

describe('journal', () => {
  it('names the phase it stopped in', async () => {
    const result = await runTransaction(input(await repository(), { validate: async () => ['issue'] }))
    expect(result.journal.phase).toBe('validate')
  })

  it('switches to the recovery phase once recovery ran', async () => {
    const root = await repository([DOMAIN, GUIDE])
    const result = await runTransaction(input(root, {
      operations: [{ kind: 'write', target: 'context/api-client/manual/retry.md', contents: 'x\n' }],
      faults: { commit: () => { throw new Error('boom') } },
    }))
    expect(result.journal.phase).toBe('recovery')
  })
})
