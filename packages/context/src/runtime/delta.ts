import type { KnowledgeGraph } from './graph.js'
import type { CursorPosition, DeltaComputeInput, RuntimeRequest, RuntimeResponse, Scope } from './protocol.js'
import type { GitChange } from './repository.js'
import type { JsonObject, JsonValue } from './stable-json.js'
import { impactClosure, loadKnowledge } from './graph.js'
import { decodeCursor, encodeCursor, paginate, resolvedBudget, RuntimeFault, runtimeResponse, sha256 } from './protocol.js'
import { assertGitEvidencePath, assertSourcePattern, declarationMatches, readGitEvidence } from './repository.js'
import { compactJson, compareCodeUnits } from './stable-json.js'

function changedPaths(changes: readonly GitChange[]): readonly string[] {
  const paths = new Set<string>()
  for (const change of changes) {
    paths.add(change.path)
    if (change.previousPath !== undefined)
      paths.add(change.previousPath)
  }
  return [...paths].sort(compareCodeUnits)
}

function scopeContainsDocument(scope: Scope, graph: KnowledgeGraph, documentId: string, gitPaths: readonly string[]): boolean {
  const document = graph.documents.get(documentId)
  if (document === undefined)
    return false
  if (scope.kind === 'repository')
    return true
  if (scope.kind === 'domains')
    return scope.ids.includes(document.domain)
  if (scope.kind === 'documents')
    return scope.ids.includes(documentId)
  const actualPaths = new Set([
    ...(graph.sources.get(documentId) ?? []).map(file => file.path),
    ...gitPaths.filter(candidate => document.codePaths.some(declaration => declarationMatches(declaration, candidate))),
  ])
  return [...actualPaths].some(candidate => scope.paths.some(pattern => declarationMatches(pattern, candidate)))
}

function validateScope(scope: Scope, graph: KnowledgeGraph): void {
  if (scope.kind === 'domains') {
    const unknown = scope.ids.find(id => !graph.domains.has(id))
    if (unknown !== undefined)
      throw new RuntimeFault('SCOPE_DOMAIN_UNKNOWN', 'Delta scope contains an unknown Domain.')
  }
  else if (scope.kind === 'documents') {
    const unknown = scope.ids.find(id => !graph.documents.has(id))
    if (unknown !== undefined)
      throw new RuntimeFault('SCOPE_DOCUMENT_UNKNOWN', 'Delta scope contains an unknown Document.')
  }
  else if (scope.kind === 'paths') {
    for (const pattern of scope.paths)
      assertSourcePattern(pattern)
  }
}

interface SectionItem extends JsonObject {
  section: 'changedPaths' | 'directImpact' | 'expandedImpact' | 'unreferencedPaths' | 'brokenEvidence'
  value: JsonValue
}

function pageData(items: readonly SectionItem[]): {
  readonly changedPaths: readonly JsonValue[]
  readonly directImpact: readonly JsonValue[]
  readonly expandedImpact: readonly JsonValue[]
  readonly unreferencedPaths: readonly JsonValue[]
  readonly brokenEvidence: readonly JsonValue[]
} {
  const result: Record<SectionItem['section'], JsonValue[]> = {
    changedPaths: [],
    directImpact: [],
    expandedImpact: [],
    unreferencedPaths: [],
    brokenEvidence: [],
  }
  for (const item of items)
    result[item.section].push(item.value)
  return result
}

export async function deltaCompute(root: string, request: RuntimeRequest): Promise<RuntimeResponse> {
  const input = request.input as DeltaComputeInput
  assertGitEvidencePath(input.gitEvidencePath)
  if (input.scope.kind === 'paths')
    input.scope.paths.forEach(assertSourcePattern)
  const graph = await loadKnowledge(root, undefined, { sourcePolicy: 'all-tolerant' })
  if (graph.formalState !== 'ready') {
    const first = graph.issues[0]
    throw new RuntimeFault(first?.code ?? 'CONTEXT_NOT_READY', first?.message ?? 'Delta requires ready formal Context.', first?.path ?? 'context')
  }
  validateScope(input.scope, graph)
  const evidence = await readGitEvidence(root, input.gitEvidencePath)
  const paths = changedPaths(evidence.changes)
  const direct = new Map<string, string[]>()
  const unreferenced: string[] = []
  for (const changedPath of paths) {
    if (changedPath.startsWith('context/') || changedPath.startsWith('.scratch/'))
      continue
    let mapped = false
    for (const document of graph.documents.values()) {
      for (const declaration of document.codePaths) {
        if (!declarationMatches(declaration, changedPath))
          continue
        mapped = true
        const current = graph.ledgers.get(document.id)
        const recorded = graph.meta?.documents[document.id]
        if (current !== undefined && recorded !== undefined && current.sourceFingerprint === recorded.sourceFingerprint)
          continue
        const reasons = direct.get(document.id) ?? []
        reasons.push(`code.paths ${declaration} matches ${changedPath}`)
        direct.set(document.id, reasons)
      }
    }
    // No Document cites this path as evidence, so no recorded knowledge can have gone stale
    // because of it. Reported so a Recorder can judge whether an anchor is warranted; per D32
    // only broken evidence blocks Light.
    if (!mapped)
      unreferenced.push(changedPath)
  }
  for (const [id, reasons] of direct)
    direct.set(id, [...new Set(reasons)].sort(compareCodeUnits))
  const closure = impactClosure(graph, direct)
  const brokenEvidence: JsonValue[] = graph.sourceIssues.map(problem => ({
    documentId: problem.documentId,
    code: problem.code,
    sourcePattern: problem.sourcePattern,
  }))
  const baseline = graph.meta?.repository?.baseline
  if (baseline !== undefined && baseline.revision !== evidence.currentRevision && !evidence.hasDiff)
    brokenEvidence.push({ code: 'GIT_DIFF_MISSING', reason: 'repository baseline differs from HEAD but diff.bin is missing' })

  const blockers: string[] = []
  if (baseline === undefined)
    blockers.push('repository baseline is absent')
  if (!input.taskEvidence.intentKnown)
    blockers.push('task intent is not known')
  if (!input.taskEvidence.scopeComplete)
    blockers.push('task scope is incomplete')
  if (input.taskEvidence.newCapabilitySuspected)
    blockers.push('a new capability is suspected')
  if (input.taskEvidence.crossDomainContractUncertain)
    blockers.push('a cross-Domain contract is uncertain')
  if (evidence.midOperation)
    blockers.push('Git is in a mid-operation state')
  if (brokenEvidence.length > 0)
    blockers.push('evidence is incomplete')
  const outsideScope = closure.filter(item => !scopeContainsDocument(input.scope, graph, item.documentId, paths))
  if (outsideScope.length > 0)
    blockers.push('impact closure extends outside authorized scope')
  const uniqueBlockers = [...new Set(blockers)].sort(compareCodeUnits)
  // Unlike Light, the baseline keeps the unreferenced check: advancing it asserts the recorded
  // source state covers this revision, which is false while changes sit outside every declaration.
  const baselineEligible = input.scope.kind === 'repository'
    && !evidence.midOperation
    && brokenEvidence.length === 0
    && unreferenced.length === 0
    && input.taskEvidence.scopeComplete

  const stream: SectionItem[] = [
    ...evidence.changes.map(change => ({ section: 'changedPaths' as const, value: { ...change } })),
    ...[...direct.entries()].sort(([left], [right]) => compareCodeUnits(left, right)).map(([documentId, reasons]) => ({
      section: 'directImpact' as const,
      value: { documentId, changedPaths: paths.filter(changedPath => reasons.some(reason => reason.endsWith(` ${changedPath}`))), reasons },
    })),
    ...closure.map(item => ({ section: 'expandedImpact' as const, value: { documentId: item.documentId, reasons: [...item.reasons] } })),
    ...unreferenced.sort(compareCodeUnits).map(value => ({ section: 'unreferencedPaths' as const, value })),
    ...brokenEvidence.sort((left, right) => compareCodeUnits(compactJson(left), compactJson(right))).map(value => ({ section: 'brokenEvidence' as const, value })),
  ]
  const contextFingerprint = graph.contextFingerprint as string
  const stateFingerprint = sha256(compactJson({
    gitEvidenceFingerprint: evidence.fingerprint,
    sourceFingerprint: graph.sourceFingerprint ?? 'source:unavailable',
    brokenEvidence,
  }))
  const position = decodeCursor(request.cursor, request.capability, request.input, contextFingerprint, stateFingerprint)
  const cursorFor = (next: CursorPosition): string => encodeCursor(
    request.capability,
    request.input,
    contextFingerprint,
    stateFingerprint,
    next,
  )
  const response = (pageItems: readonly SectionItem[], cursor?: string): RuntimeResponse => {
    const sections = pageData(pageItems)
    return runtimeResponse('delta.compute', cursor === undefined ? 'success' : 'incomplete', {
      data: {
        ...(baseline === undefined ? {} : { repositoryBaseline: baseline.revision }),
        currentRevision: evidence.currentRevision,
        changedPaths: [...sections.changedPaths],
        directImpact: [...sections.directImpact],
        expandedImpact: [...sections.expandedImpact],
        unreferencedPaths: [...sections.unreferencedPaths],
        brokenEvidence: [...sections.brokenEvidence],
        light: { eligible: uniqueBlockers.length === 0, blockers: uniqueBlockers },
        repositoryBaselineEligible: baselineEligible,
      },
      ...(cursor === undefined ? {} : { cursor }),
    })
  }
  const page = paginate(stream, position, resolvedBudget(request), { response, cursor: cursorFor })
  const cursor = page.nextPosition === undefined ? undefined : cursorFor(page.nextPosition)
  return response(page.items, cursor)
}
