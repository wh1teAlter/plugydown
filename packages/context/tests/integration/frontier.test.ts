import type { FixtureDocument } from '../helpers/fixture.js'
import { afterEach, describe, expect, it } from 'vitest'
import { queryFrontier } from '../../src/runtime/frontier.js'
import { buildGraph } from '../../src/runtime/graph.js'
import { createFixture, removeFixture } from '../helpers/fixture.js'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map(removeFixture))
})

/** @returns a graph built from a temporary fixture repository. */
async function graphOf(documents: readonly FixtureDocument[]): ReturnType<typeof buildGraph> {
  const root = await createFixture(documents)
  created.push(root)
  return buildGraph(root)
}

/** @returns a Domain plus `count` guides inside it. */
function domainWithGuides(domain: string, count: number): FixtureDocument[] {
  const documents: FixtureDocument[] = [{ domain, name: 'domain.md', id: domain, kind: 'domain' }]
  for (let index = 0; index < count; index += 1) {
    documents.push({
      domain,
      category: 'manual',
      name: `g${index}.md`,
      id: `${domain}.g${index}`,
      kind: 'guide',
      body: `# g${index}\n\n${'body '.repeat(200)}\n`,
    })
  }
  return documents
}

describe('selection', () => {
  it('returns every document when nothing is filtered', async () => {
    const page = queryFrontier(await graphOf(domainWithGuides('api-client', 3)), {})
    expect(page.items).toHaveLength(4)
    expect(page.cursor).toBeUndefined()
  })

  it('filters by domain', async () => {
    const graph = await graphOf([...domainWithGuides('api-client', 2), ...domainWithGuides('billing', 2)])
    const page = queryFrontier(graph, { domains: ['billing'] })
    expect(page.items.every(item => item.domain === 'billing')).toBe(true)
    expect(page.items).toHaveLength(3)
  })

  it('filters by kind', async () => {
    const page = queryFrontier(await graphOf(domainWithGuides('api-client', 3)), { kinds: ['domain'] })
    expect(page.items.map(item => item.id)).toEqual(['api-client'])
  })

  it('selects documents claiming a changed code path', async () => {
    const graph = await graphOf([
      { domain: 'api-client', name: 'domain.md', id: 'api-client', kind: 'domain' },
      { domain: 'api-client', category: 'manual', name: 'retry.md', id: 'api-client.retry', kind: 'guide', codePaths: ['src/api/retry.ts'] },
    ])
    const page = queryFrontier(graph, { codePaths: ['src/api/retry.ts'] })
    expect(page.items.map(item => item.id)).toEqual(['api-client.retry'])
  })

  it('follows a declared relation', async () => {
    const graph = await graphOf([
      { domain: 'api-client', name: 'domain.md', id: 'api-client', kind: 'domain' },
      { domain: 'api-client', category: 'manual', name: 'a.md', id: 'api-client.a', kind: 'guide', requires: ['api-client'] },
    ])
    const page = queryFrontier(graph, { ids: ['api-client.a'], relation: 'requires' })
    expect(page.items.map(item => item.id)).toContain('api-client')
  })
})

describe('projection', () => {
  it('omits bodies by default', async () => {
    const page = queryFrontier(await graphOf(domainWithGuides('api-client', 1)), {})
    expect(page.items.every(item => item.body === undefined)).toBe(true)
  })

  it('includes normalized bodies on request', async () => {
    const page = queryFrontier(await graphOf(domainWithGuides('api-client', 1)), { projection: 'body' })
    expect(page.items.every(item => typeof item.body === 'string')).toBe(true)
  })
})

describe('budgets and continuation', () => {
  it('bounds a page by item count and returns a cursor', async () => {
    const graph = await graphOf(domainWithGuides('api-client', 9))
    const page = queryFrontier(graph, {}, { items: 4 })
    expect(page.items).toHaveLength(4)
    expect(page.cursor).toBeDefined()
    expect(page.totalCandidates).toBe(10)
  })

  it('bounds a page by byte budget', async () => {
    const graph = await graphOf(domainWithGuides('api-client', 9))
    const page = queryFrontier(graph, { projection: 'body' }, { bytes: 2000 })
    expect(page.items.length).toBeLessThan(10)
    expect(page.cursor).toBeDefined()
  })

  it('bounds a page by conservative token budget', async () => {
    const graph = await graphOf(domainWithGuides('api-client', 9))
    const page = queryFrontier(graph, { projection: 'body' }, { estimatedTokens: 500 })
    expect(page.items.length).toBeLessThan(10)
    expect(page.cursor).toBeDefined()
  })

  it('always returns at least one item so a single oversized document cannot stall', async () => {
    const graph = await graphOf(domainWithGuides('api-client', 2))
    const page = queryFrontier(graph, { projection: 'body' }, { bytes: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.cursor).toBeDefined()
  })

  it('continues without repeating or dropping documents', async () => {
    const graph = await graphOf(domainWithGuides('api-client', 9))
    const seen: string[] = []
    let cursor: string | undefined

    do {
      const page = queryFrontier(graph, {}, { items: 3 }, cursor)
      seen.push(...page.items.map(item => item.id))
      cursor = page.cursor
    } while (cursor !== undefined)

    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toHaveLength(10)
  })
})
