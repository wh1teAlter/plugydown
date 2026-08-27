import type { Change, GitState } from './git.js'
import type { KnowledgeGraph } from './graph.js'
import type { Ledger } from './meta.js'
import type { JsonObject } from './types.js'
import { compareCodeUnits } from './stable-json.js'

/** One document the delta believes needs attention, with the reason it was included. */
export interface ImpactedDocument {
  readonly id: string
  readonly reason: string
  readonly direct: boolean
}

/** Whether a Light update is defensible, and why not when it is not. */
export interface ModeSignals {
  readonly lightEligible: boolean
  readonly blockers: readonly string[]
}

/** The complete delta report. */
export interface Delta {
  readonly requestedScope: readonly string[]
  readonly resolvedScope: readonly string[]
  readonly baselineRevision?: string
  readonly currentRevision?: string
  readonly worktreeDirty: boolean
  readonly changes: readonly Change[]
  readonly directImpact: readonly ImpactedDocument[]
  readonly expandedClosure: readonly ImpactedDocument[]
  readonly unmappedPaths: readonly string[]
  readonly brokenRelations: readonly string[]
  readonly signals: ModeSignals
  readonly baselineEligible: boolean
}

/** @returns the concrete directory prefix a declared path or glob constrains. */
function prefixOf(declared: string): string {
  const wildcard = declared.search(/[*?[{]/)
  if (wildcard < 0)
    return declared
  const cut = declared.lastIndexOf('/', wildcard)
  return cut < 0 ? '' : declared.slice(0, cut)
}

/** @returns whether a changed path falls under a declared path or bounded glob. */
export function pathMatches(declared: string, changed: string): boolean {
  if (declared === changed)
    return true
  const prefix = prefixOf(declared)
  return prefix.length > 0 && changed.startsWith(`${prefix}/`)
}

/**
 * Projects source changes onto the documents that claim them.
 *
 * @param graph the document graph.
 * @param changes the changed paths.
 * @returns impacted documents and the changed paths no document claims.
 */
function projectChanges(graph: KnowledgeGraph, changes: readonly Change[]): {
  readonly impacted: readonly ImpactedDocument[]
  readonly unmapped: readonly string[]
} {
  const impacted = new Map<string, string>()
  const unmapped: string[] = []

  for (const change of changes) {
    let claimed = false
    for (const [declared, owners] of graph.codeIndex) {
      if (!pathMatches(declared, change.path))
        continue
      claimed = true
      for (const id of owners) {
        if (!impacted.has(id))
          impacted.set(id, `code.paths "${declared}" matches changed "${change.path}"`)
      }
    }
    if (!claimed && !change.path.startsWith('context/'))
      unmapped.push(change.path)
  }

  return {
    impacted: [...impacted.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([id, reason]) => ({ id, reason, direct: true })),
    unmapped: [...new Set(unmapped)].sort(compareCodeUnits),
  }
}

/**
 * Expands direct impact along `requires` and Domain membership.
 *
 * Every expansion records why it happened. An impact set the caller cannot explain is one
 * they cannot review, which defeats the point of computing it.
 *
 * @param graph the document graph.
 * @param direct the directly impacted documents.
 * @returns the direct set plus everything reached from it.
 */
function expand(graph: KnowledgeGraph, direct: readonly ImpactedDocument[]): readonly ImpactedDocument[] {
  const closure = new Map<string, ImpactedDocument>()
  for (const item of direct)
    closure.set(item.id, item)

  const pending = direct.map(item => item.id)
  while (pending.length > 0) {
    const id = pending.pop()
    if (id === undefined)
      continue

    for (const [candidateId, candidate] of graph.documents) {
      if (closure.has(candidateId))
        continue
      if (candidate.relations.requires.includes(id)) {
        closure.set(candidateId, { id: candidateId, reason: `requires impacted document "${id}"`, direct: false })
        pending.push(candidateId)
      }
    }
  }

  const domainDocument = (domain: string): string | undefined =>
    [...graph.documents.values()].find(document => document.domain === domain && document.kind === 'domain')?.id

  for (const item of [...closure.values()]) {
    const document = graph.documents.get(item.id)
    if (document === undefined)
      continue
    const anchor = domainDocument(document.domain)
    if (anchor !== undefined && !closure.has(anchor))
      closure.set(anchor, { id: anchor, reason: `owns Domain "${document.domain}" of an impacted document`, direct: false })
  }

  return [...closure.values()].sort((left, right) => compareCodeUnits(left.id, right.id))
}

/**
 * Computes the delta between recorded knowledge and the repository as it is now.
 *
 * @param graph the current document graph.
 * @param ledger the recorded ledger, when one exists.
 * @param git the current repository state.
 * @param requestedScope Domain or document IDs the caller declared.
 * @returns the delta report.
 */
export function computeDelta(
  graph: KnowledgeGraph,
  ledger: Ledger | undefined,
  git: GitState,
  requestedScope: readonly string[] = [],
): Delta {
  const { impacted, unmapped } = projectChanges(graph, git.changes)
  const closure = expand(graph, impacted)

  const brokenRelations = graph.issues
    .filter(issue => issue.code === 'DOCUMENT_RELATION_DANGLING' || issue.code === 'DOCUMENT_REQUIRES_CYCLE')
    .map(issue => issue.message)

  const worktreeDirty = git.changes.some(change => !change.staged || change.kind === 'untracked')
  const knownIds = new Set(Object.keys(ledger?.documents ?? {}))
  const newDocuments = [...graph.documents.keys()].filter(id => !knownIds.has(id))

  const blockers: string[] = []
  if (ledger === undefined)
    blockers.push('No ledger has been recorded yet.')
  if (graph.issues.some(issue => issue.code !== 'DOCUMENT_RELATION_DANGLING'))
    blockers.push('The document graph has structural issues.')
  if (brokenRelations.length > 0)
    blockers.push('The document graph has broken relations.')
  if (unmapped.length > 0)
    blockers.push('Changed paths are not claimed by any document.')
  if (newDocuments.length > 0)
    blockers.push('The graph contains documents the ledger has never validated.')
  if (closure.length === 0 && git.changes.length > 0)
    blockers.push('No document could be mapped to the observed changes.')

  const baselineEligible = git.available
    && !git.midOperation
    && !worktreeDirty
    && requestedScope.length === 0
    && graph.issues.length === 0

  return {
    requestedScope: [...requestedScope].sort(compareCodeUnits),
    resolvedScope: closure.map(item => item.id),
    ...(ledger?.repository?.baseline?.revision === undefined ? {} : { baselineRevision: ledger.repository.baseline.revision }),
    ...(git.revision === undefined ? {} : { currentRevision: git.revision }),
    worktreeDirty,
    changes: git.changes,
    directImpact: impacted,
    expandedClosure: closure,
    unmappedPaths: unmapped,
    brokenRelations,
    signals: { lightEligible: blockers.length === 0, blockers },
    baselineEligible,
  }
}

/** @returns a delta report as a JSON payload. */
export function deltaToJson(delta: Delta): JsonObject {
  return {
    requestedScope: [...delta.requestedScope],
    resolvedScope: [...delta.resolvedScope],
    ...(delta.baselineRevision === undefined ? {} : { baselineRevision: delta.baselineRevision }),
    ...(delta.currentRevision === undefined ? {} : { currentRevision: delta.currentRevision }),
    worktreeDirty: delta.worktreeDirty,
    changes: delta.changes.map(change => ({ path: change.path, kind: change.kind, staged: change.staged })),
    directImpact: delta.directImpact.map(item => ({ id: item.id, reason: item.reason })),
    expandedClosure: delta.expandedClosure.map(item => ({ id: item.id, reason: item.reason, direct: item.direct })),
    unmappedPaths: [...delta.unmappedPaths],
    brokenRelations: [...delta.brokenRelations],
    signals: { lightEligible: delta.signals.lightEligible, blockers: [...delta.signals.blockers] },
    baselineEligible: delta.baselineEligible,
  }
}
