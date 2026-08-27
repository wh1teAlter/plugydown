import type { FixtureDocument } from '../helpers/fixture.js'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computeDelta } from '../../src/runtime/delta.js'
import { gitStateFromInput, parseNameStatus, parseStatus } from '../../src/runtime/git.js'
import { buildGraph } from '../../src/runtime/graph.js'
import { measureGrowth } from '../../src/runtime/knowledge.js'
import { parseLedger } from '../../src/runtime/meta.js'
import { createFixture, removeFixture, writeLedger } from '../helpers/fixture.js'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map(removeFixture))
})

/** Runs git inside a fixture repository. */
function git(root: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  })
}

/** @returns an initialized Git repository containing the given documents. */
async function repository(documents: readonly FixtureDocument[]): Promise<string> {
  const root = await createFixture(documents)
  created.push(root)
  git(root, 'init', '--initial-branch=main')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'initial')
  return root
}

/**
 * Collects Git output the way the calling agent would.
 *
 * The runtime deliberately cannot spawn processes, so the caller supplies this. The test
 * plays that role.
 *
 * @param root the repository to inspect.
 * @returns raw Git output for `gitStateFromInput`.
 */
function collectGit(root: string): { revision: string, status: string, midOperation: boolean } {
  const read = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' })

  return {
    revision: read('rev-parse', 'HEAD').trim(),
    status: read('status', '--porcelain=v1', '-z', '--untracked-files=all'),
    midOperation: false,
  }
}

const DOMAIN: FixtureDocument = { domain: 'api-client', name: 'domain.md', id: 'api-client', kind: 'domain' }
const RETRY: FixtureDocument = {
  domain: 'api-client',
  category: 'manual',
  name: 'retry.md',
  id: 'api-client.retry',
  kind: 'guide',
  codePaths: ['src/api/retry.ts'],
}

describe('porcelain parsing', () => {
  it('parses NUL-delimited status entries', () => {
    expect(parseStatus('M  src/a.ts\0?? src/b.ts\0')).toEqual([
      { path: 'src/a.ts', kind: 'modified', staged: true },
      { path: 'src/b.ts', kind: 'untracked', staged: false },
    ])
  })

  it('survives a path containing a newline', () => {
    expect(parseStatus('M  src/we\nird.ts\0')).toEqual([
      { path: 'src/we\nird.ts', kind: 'modified', staged: true },
    ])
  })

  it('consumes both paths of a rename', () => {
    expect(parseNameStatus('R100\0src/old.ts\0src/new.ts\0M\0src/other.ts\0').map(change => change.path))
      .toEqual(['src/new.ts', 'src/other.ts'])
  })
})

describe('repository state', () => {
  it('reports unavailable without Git input', () => {
    expect(gitStateFromInput(undefined)).toMatchObject({ available: false, midOperation: false })
    expect(gitStateFromInput({ status: 'M  a.ts\0' })).toMatchObject({ available: false })
  })

  it('reports a clean repository', async () => {
    const state = gitStateFromInput(collectGit(await repository([DOMAIN])))
    expect(state.available).toBe(true)
    expect(state.midOperation).toBe(false)
    expect(state.changes).toEqual([])
  })

  it('reports untracked and modified files', async () => {
    const root = await repository([DOMAIN, RETRY])
    await fs.mkdir(path.join(root, 'src', 'api'), { recursive: true })
    await fs.writeFile(path.join(root, 'src', 'api', 'retry.ts'), 'export const retry = 1\n')
    const state = gitStateFromInput(collectGit(root))
    expect(state.changes.map((change: { kind: string }) => change.kind)).toContain('untracked')
  })
})

describe('delta', () => {
  it('projects a changed source path onto the document that claims it', async () => {
    const root = await repository([DOMAIN, RETRY])
    await fs.mkdir(path.join(root, 'src', 'api'), { recursive: true })
    await fs.writeFile(path.join(root, 'src', 'api', 'retry.ts'), 'export const retry = 1\n')

    const graph = await buildGraph(root)
    const delta = computeDelta(graph, undefined, gitStateFromInput(collectGit(root)))
    expect(delta.directImpact.map(item => item.id)).toContain('api-client.retry')
  })

  it('expands to the Domain document and explains why', async () => {
    const root = await repository([DOMAIN, RETRY])
    await fs.mkdir(path.join(root, 'src', 'api'), { recursive: true })
    await fs.writeFile(path.join(root, 'src', 'api', 'retry.ts'), 'export const retry = 1\n')

    const graph = await buildGraph(root)
    const delta = computeDelta(graph, undefined, gitStateFromInput(collectGit(root)))
    const anchor = delta.expandedClosure.find(item => item.id === 'api-client')
    expect(anchor?.direct).toBe(false)
    expect(anchor?.reason).toContain('Domain')
  })

  it('reports changed paths no document claims', async () => {
    const root = await repository([DOMAIN])
    await fs.writeFile(path.join(root, 'unowned.ts'), 'export const x = 1\n')

    const graph = await buildGraph(root)
    const delta = computeDelta(graph, undefined, gitStateFromInput(collectGit(root)))
    expect(delta.unmappedPaths).toContain('unowned.ts')
    expect(delta.signals.lightEligible).toBe(false)
  })

  it('refuses to advance the baseline while the worktree is dirty', async () => {
    const root = await repository([DOMAIN])
    await fs.writeFile(path.join(root, 'dirty.ts'), 'export const x = 1\n')

    const delta = computeDelta(await buildGraph(root), undefined, gitStateFromInput(collectGit(root)))
    expect(delta.worktreeDirty).toBe(true)
    expect(delta.baselineEligible).toBe(false)
  })

  it('allows the baseline to advance on a clean, valid repository', async () => {
    const root = await repository([DOMAIN])
    const delta = computeDelta(await buildGraph(root), undefined, gitStateFromInput(collectGit(root)))
    expect(delta.baselineEligible).toBe(true)
  })

  it('blocks Light when the ledger has never validated a document', async () => {
    const root = await repository([DOMAIN])
    await writeLedger(root, {})
    const parsed = parseLedger(JSON.parse(await fs.readFile(path.join(root, 'context', 'meta.json'), 'utf8')))
    const delta = computeDelta(await buildGraph(root), parsed.ok ? parsed.ledger : undefined, gitStateFromInput(collectGit(root)))
    expect(delta.signals.blockers.join(' ')).toContain('never validated')
  })
})

describe('growth gate', () => {
  /** @returns a growth report for a Domain of `count` guides against a baseline. */
  async function growth(count: number, baseline: Record<string, unknown>): Promise<ReturnType<typeof measureGrowth>> {
    const documents: FixtureDocument[] = [DOMAIN]
    for (let index = 0; index < count; index += 1)
      documents.push({ domain: 'api-client', category: 'manual', name: `g${index}.md`, id: `api-client.g${index}`, kind: 'guide' })

    const root = await createFixture(documents)
    created.push(root)
    await writeLedger(root, { convergence: baseline })
    const parsed = parseLedger(JSON.parse(await fs.readFile(path.join(root, 'context', 'meta.json'), 'utf8')))
    return measureGrowth(await buildGraph(root), parsed.ok ? parsed.ledger : undefined)
  }

  const baseline = (documentCount: number): Record<string, unknown> => ({
    source: 'init',
    documentCount,
    frontMatterBytes: 0,
    bodyBytes: 0,
    estimatedTokens: 1_000_000,
    perDomain: {},
  })

  it('does not trip below the threshold', async () => {
    expect((await growth(9, baseline(7))).gateCrossed).toBe(false)
  })

  it('trips exactly at the threshold', async () => {
    expect((await growth(9, baseline(6))).gateCrossed).toBe(true)
  })

  it('trips above the threshold', async () => {
    expect((await growth(11, baseline(6))).gateCrossed).toBe(true)
  })

  it('does not trip without a baseline', async () => {
    const root = await createFixture([DOMAIN])
    created.push(root)
    expect(measureGrowth(await buildGraph(root), undefined).gateCrossed).toBe(false)
  })

  it('reports duplicate bodies without tripping the gate', async () => {
    const body = '# Same\n\nIdentical body.\n'
    const root = await createFixture([
      DOMAIN,
      { domain: 'api-client', category: 'manual', name: 'a.md', id: 'api-client.a', kind: 'guide', body },
      { domain: 'api-client', category: 'manual', name: 'b.md', id: 'api-client.b', kind: 'guide', body },
    ])
    created.push(root)
    await writeLedger(root, { convergence: baseline(3) })
    const parsed = parseLedger(JSON.parse(await fs.readFile(path.join(root, 'context', 'meta.json'), 'utf8')))
    const report = measureGrowth(await buildGraph(root), parsed.ok ? parsed.ledger : undefined)

    expect(report.duplicateCandidates).toEqual([['api-client.a', 'api-client.b']])
    expect(report.gateCrossed).toBe(false)
  })
})
