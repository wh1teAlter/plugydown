import { describe, expect, it } from 'vitest'
import { PHASES, runDirectory } from '../../src/runtime/transaction.js'

describe('phase order', () => {
  it('is fixed and total', () => {
    expect([...PHASES]).toEqual([
      'snapshot',
      'stage',
      'validate',
      'review',
      'concurrency-check',
      'commit',
      'verify',
    ])
  })

  it('places every gate before commit', () => {
    const commit = PHASES.indexOf('commit')
    for (const gate of ['validate', 'review', 'concurrency-check'] as const)
      expect(PHASES.indexOf(gate)).toBeLessThan(commit)
  })

  it('places verification after commit', () => {
    expect(PHASES.indexOf('verify')).toBeGreaterThan(PHASES.indexOf('commit'))
  })
})

describe('staging layout', () => {
  it('isolates runs by command and run ID inside the disposable workspace', () => {
    expect(runDirectory('update', 'r1')).toBe('.scratch/runs/update/r1')
    expect(runDirectory('prune', 'r2')).toBe('.scratch/runs/prune/r2')
  })

  it('never places a run inside formal knowledge', () => {
    expect(runDirectory('init', 'r1').startsWith('context/')).toBe(false)
  })
})
