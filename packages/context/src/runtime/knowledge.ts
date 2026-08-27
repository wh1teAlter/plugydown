import type { KnowledgeGraph } from './graph.js'
import type { ConvergenceBaseline, Ledger } from './meta.js'
import type { JsonObject } from './types.js'
import { Buffer } from 'node:buffer'
import { GROWTH_GATE_RATIO } from './constants.js'
import { normalizeBody } from './fingerprint.js'
import { estimateTokens } from './frontier.js'
import { compareCodeUnits, stableJson } from './stable-json.js'

/** Measured size of the formal knowledge tree. */
export interface Measurement {
  readonly documentCount: number
  readonly frontMatterBytes: number
  readonly bodyBytes: number
  readonly estimatedTokens: number
  readonly perDomain: Readonly<Record<string, number>>
}

/** Growth relative to the last convergence baseline, and whether it crossed the gate. */
export interface GrowthReport {
  readonly current: Measurement
  readonly baseline?: ConvergenceBaseline
  readonly documentGrowth?: number
  readonly tokenGrowth?: number
  readonly gateCrossed: boolean
  readonly duplicateCandidates: readonly (readonly string[])[]
}

/** Durable, per-baseline suppression record for an already-surfaced prune suggestion. */
export interface GrowthSuggestionState {
  readonly baselineFingerprint?: string
}

/** @returns the current size of the knowledge tree. */
export function measure(graph: KnowledgeGraph): Measurement {
  const perDomain: Record<string, number> = {}
  let frontMatterBytes = 0
  let bodyBytes = 0
  let estimatedTokens = 0

  for (const document of graph.documents.values()) {
    const body = normalizeBody(document.body)
    frontMatterBytes += Buffer.byteLength(document.frontMatter, 'utf8')
    bodyBytes += Buffer.byteLength(body, 'utf8')
    estimatedTokens += estimateTokens(document.frontMatter) + estimateTokens(body)
    perDomain[document.domain] = (perDomain[document.domain] ?? 0) + 1
  }

  return { documentCount: graph.documents.size, frontMatterBytes, bodyBytes, estimatedTokens, perDomain }
}

/** @returns the growth ratio, or undefined when the baseline is zero or absent. */
function ratio(current: number, baseline: number | undefined): number | undefined {
  if (baseline === undefined || baseline <= 0)
    return undefined
  return (current - baseline) / baseline
}

/**
 * Finds documents whose normalized bodies are identical.
 *
 * These are reported as review candidates only. They never trip the growth gate: a genuinely
 * new Domain legitimately increases size, and conflating the two would nag on healthy growth.
 *
 * @param graph the document graph.
 * @returns groups of document IDs sharing a body.
 */
function duplicates(graph: KnowledgeGraph): readonly (readonly string[])[] {
  const byBody = new Map<string, string[]>()
  for (const document of graph.documents.values()) {
    const key = normalizeBody(document.body).trim()
    if (key.length === 0)
      continue
    const group = byBody.get(key) ?? []
    group.push(document.id)
    byBody.set(key, group)
  }

  return [...byBody.values()]
    .filter(group => group.length > 1)
    .map(group => [...group].sort(compareCodeUnits))
    .sort((left, right) => compareCodeUnits(left[0] ?? '', right[0] ?? ''))
}

/**
 * Measures growth against the last convergence baseline.
 *
 * @param graph the document graph.
 * @param ledger the recorded ledger, when one exists.
 * @returns the growth report, including whether the prune gate was crossed.
 */
export function measureGrowth(graph: KnowledgeGraph, ledger: Ledger | undefined): GrowthReport {
  const current = measure(graph)
  const baseline = ledger?.convergence
  const documentGrowth = ratio(current.documentCount, baseline?.documentCount)
  const tokenGrowth = ratio(current.estimatedTokens, baseline?.estimatedTokens)

  return {
    current,
    ...(baseline === undefined ? {} : { baseline }),
    ...(documentGrowth === undefined ? {} : { documentGrowth }),
    ...(tokenGrowth === undefined ? {} : { tokenGrowth }),
    gateCrossed: (documentGrowth ?? 0) >= GROWTH_GATE_RATIO || (tokenGrowth ?? 0) >= GROWTH_GATE_RATIO,
    duplicateCandidates: duplicates(graph),
  }
}

/** @returns a stable identity for a convergence baseline, or undefined before the first one. */
export function convergenceFingerprint(ledger: Ledger | undefined): string | undefined {
  const baseline = ledger?.convergence
  if (baseline === undefined)
    return undefined
  return stableJson({
    source: baseline.source,
    documentCount: baseline.documentCount,
    frontMatterBytes: baseline.frontMatterBytes,
    bodyBytes: baseline.bodyBytes,
    estimatedTokens: baseline.estimatedTokens,
    perDomain: baseline.perDomain,
  })
}

/** @returns whether a gate hit may be suggested now, and the state to keep outside formal knowledge. */
export function decidePruneSuggestion(
  report: GrowthReport,
  ledger: Ledger | undefined,
  state: GrowthSuggestionState = {},
): { readonly suggested: boolean, readonly state: GrowthSuggestionState } {
  const baselineFingerprint = convergenceFingerprint(ledger)
  const suggested = report.gateCrossed && baselineFingerprint !== undefined && state.baselineFingerprint !== baselineFingerprint
  return { suggested, state: suggested ? { baselineFingerprint } : state }
}

/** @returns a growth report as a JSON payload. */
export function growthToJson(report: GrowthReport): JsonObject {
  return {
    current: {
      documentCount: report.current.documentCount,
      frontMatterBytes: report.current.frontMatterBytes,
      bodyBytes: report.current.bodyBytes,
      estimatedTokens: report.current.estimatedTokens,
      perDomain: { ...report.current.perDomain },
    },
    ...(report.baseline === undefined
      ? {}
      : {
          baseline: {
            source: report.baseline.source,
            documentCount: report.baseline.documentCount,
            estimatedTokens: report.baseline.estimatedTokens,
          },
        }),
    ...(report.documentGrowth === undefined ? {} : { documentGrowth: report.documentGrowth }),
    ...(report.tokenGrowth === undefined ? {} : { tokenGrowth: report.tokenGrowth }),
    gateCrossed: report.gateCrossed,
    duplicateCandidates: report.duplicateCandidates.map(group => [...group]),
  }
}
