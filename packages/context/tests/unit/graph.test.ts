import { afterEach, describe, expect, it } from 'vitest'
import { buildGraph, requiresClosure } from '../../src/runtime/graph.js'
import { createFixture, removeFixture } from '../helpers/fixture.js'

const created: string[] = []

/** @returns a fixture root that is cleaned up after the test. */
async function fixture(documents: Parameters<typeof createFixture>[0]): Promise<string> {
  const root = await createFixture(documents)
  created.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(created.splice(0).map(removeFixture))
})

const DOMAIN = { domain: 'api-client', name: 'domain.md', id: 'api-client', kind: 'domain' } as const

describe('graph construction', () => {
  it('builds a valid graph with no issues', async () => {
    const graph = await buildGraph(await fixture([
      DOMAIN,
      { domain: 'api-client', category: 'manual', name: 'retry.md', id: 'api-client.retry', kind: 'guide' },
    ]))

    expect(graph.issues).toEqual([])
    expect(graph.documents.size).toBe(2)
    expect(graph.domains.get('api-client')?.documentIds).toEqual(['api-client', 'api-client.retry'])
  })

  it('reports a Domain without a domain document', async () => {
    const graph = await buildGraph(await fixture([
      { domain: 'billing', category: 'manual', name: 'a.md', id: 'billing.a', kind: 'guide' },
    ]))
    expect(graph.issues.map(issue => issue.code)).toContain('DOMAIN_DOCUMENT_MISSING')
  })

  it('reports a document whose declared domain does not match its directory', async () => {
    const graph = await buildGraph(await fixture([
      DOMAIN,
      { domain: 'api-client', declaredDomain: 'billing', category: 'manual', name: 'a.md', id: 'billing.a', kind: 'guide' },
    ]))
    expect(graph.issues.map(issue => issue.code)).toContain('DOCUMENT_DOMAIN_MISMATCH')
  })

  it('reports duplicate document IDs', async () => {
    const graph = await buildGraph(await fixture([
      DOMAIN,
      { domain: 'api-client', category: 'manual', name: 'a.md', id: 'api-client.dup', kind: 'guide' },
      { domain: 'api-client', category: 'design', name: 'b.md', id: 'api-client.dup', kind: 'decision' },
    ]))
    expect(graph.issues.map(issue => issue.code)).toContain('DOCUMENT_ID_DUPLICATE')
  })

  it('reports a dangling relation', async () => {
    const graph = await buildGraph(await fixture([
      { ...DOMAIN, requires: ['api-client.missing'] },
    ]))
    expect(graph.issues.map(issue => issue.code)).toContain('DOCUMENT_RELATION_DANGLING')
  })

  it('reports a self relation', async () => {
    const graph = await buildGraph(await fixture([{ ...DOMAIN, related: ['api-client'] }]))
    expect(graph.issues.map(issue => issue.code)).toContain('DOCUMENT_RELATION_SELF')
  })

  it('reports a requires cycle', async () => {
    const graph = await buildGraph(await fixture([
      DOMAIN,
      { domain: 'api-client', category: 'manual', name: 'a.md', id: 'api-client.a', kind: 'guide', requires: ['api-client.b'] },
      { domain: 'api-client', category: 'manual', name: 'b.md', id: 'api-client.b', kind: 'guide', requires: ['api-client.a'] },
    ]))
    expect(graph.issues.map(issue => issue.code)).toContain('DOCUMENT_REQUIRES_CYCLE')
  })

  it('tolerates a related cycle, which carries no reading obligation', async () => {
    const graph = await buildGraph(await fixture([
      DOMAIN,
      { domain: 'api-client', category: 'manual', name: 'a.md', id: 'api-client.a', kind: 'guide', related: ['api-client.b'] },
      { domain: 'api-client', category: 'manual', name: 'b.md', id: 'api-client.b', kind: 'guide', related: ['api-client.a'] },
    ]))
    expect(graph.issues.map(issue => issue.code)).not.toContain('DOCUMENT_REQUIRES_CYCLE')
  })

  it('rejects a non-domain document at the Domain root', async () => {
    const graph = await buildGraph(await fixture([
      DOMAIN,
      { domain: 'api-client', name: 'stray.md', id: 'api-client.stray', kind: 'guide' },
    ]))
    expect(graph.issues.map(issue => issue.code)).toContain('DOCUMENT_PLACEMENT_INVALID')
  })

  it('indexes declared code paths', async () => {
    const graph = await buildGraph(await fixture([
      { ...DOMAIN, codePaths: ['src/api/retry.ts'] },
    ]))
    expect(graph.codeIndex.get('src/api/retry.ts')).toEqual(['api-client'])
  })
})

describe('requires closure', () => {
  it('collects transitive prerequisites', async () => {
    const graph = await buildGraph(await fixture([
      DOMAIN,
      { domain: 'api-client', category: 'manual', name: 'a.md', id: 'api-client.a', kind: 'guide', requires: ['api-client.b'] },
      { domain: 'api-client', category: 'manual', name: 'b.md', id: 'api-client.b', kind: 'guide', requires: ['api-client'] },
    ]))
    expect(requiresClosure(graph, ['api-client.a'])).toEqual(['api-client', 'api-client.a', 'api-client.b'])
  })
})
