import type { KnowledgeGraph } from '../../src/runtime/graph.js'
import type { Ledger } from '../../src/runtime/meta.js'
import { describe, expect, it } from 'vitest'
import { decidePruneSuggestion, measureGrowth } from '../../src/runtime/knowledge.js'

function graph(count: number): KnowledgeGraph {
  const documents = new Map()
  for (let index = 0; index < count; index++) {
    documents.set(`domain.g${index}`, {
      id: `domain.g${index}`,
      description: 'g',
      kind: 'guide',
      domain: 'domain',
      relations: { requires: [], related: [], supersedes: [] },
      code: { paths: [], symbols: [] },
      path: `context/domain/manual/g${index}.md`,
      frontMatter: 'x',
      body: 'body',
    })
  }
  return { documents, domains: new Map(), codeIndex: new Map(), issues: [] }
}

function ledger(count: number): Ledger {
  return {
    toolVersion: '0.1.0',
    fingerprintVersion: '1',
    documents: {},
    convergence: { source: 'init', documentCount: count, frontMatterBytes: count, bodyBytes: count, estimatedTokens: count, perDomain: { domain: count } },
  }
}

describe('growth Gate boundaries', () => {
  it('does not trigger at 49.9 percent and triggers at 50 percent by document count', () => {
    const baseline: Ledger = { ...ledger(1000), convergence: { ...ledger(1000).convergence!, estimatedTokens: 1_000_000 } }
    expect(measureGrowth(graph(1499), baseline).gateCrossed).toBe(false)
    expect(measureGrowth(graph(1500), baseline).gateCrossed).toBe(true)
  })

  it('does not trigger at 49.9 percent and triggers at 50 percent by tokens', () => {
    const baseline: Ledger = { ...ledger(1), convergence: { ...ledger(1).convergence!, estimatedTokens: 100 } }
    const smaller = graph(1)
    const smallerDoc = smaller.documents.get('domain.g0')!
    const smallerMap = new Map(smaller.documents)
    smallerMap.set('domain.g0', { ...smallerDoc, body: 'x'.repeat(444) })
    const exact = graph(1)
    const exactDoc = exact.documents.get('domain.g0')!
    const exactMap = new Map(exact.documents)
    exactMap.set('domain.g0', { ...exactDoc, body: 'x'.repeat(448) })
    expect(measureGrowth({ ...smaller, documents: smallerMap }, baseline).tokenGrowth).toBeLessThan(0.5)
    expect(measureGrowth({ ...exact, documents: exactMap }, baseline).tokenGrowth).toBeGreaterThanOrEqual(0.5)
  })

  it('suppresses a repeated suggestion for the same baseline', () => {
    const report = measureGrowth(graph(150), ledger(100))
    const first = decidePruneSuggestion(report, ledger(100))
    const second = decidePruneSuggestion(report, ledger(100), first.state)
    expect(first.suggested).toBe(true)
    expect(second.suggested).toBe(false)
  })
})
