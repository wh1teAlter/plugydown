import type { ContextDocument, Metrics } from './document.js'
import type { KnowledgeGraph } from './graph.js'
import type { FeedbackMatchInput, FrontierQueryInput, RepositoryInspectInput, RuntimeRequest, RuntimeResponse } from './protocol.js'
import type { JsonObject, JsonValue } from './stable-json.js'
import { bodyFingerprint, frontMatterFingerprint } from './document.js'
import { documentMetadata, graphMetrics, loadKnowledge, requiresClosure } from './graph.js'
import { decodeCursor, diagnostic, encodeCursor, paginate, resolvedBudget, RuntimeFault, runtimeResponse, sha256 } from './protocol.js'
import { assertSourcePath, controlledGlobMatches, FEEDBACK_ROOT, LOCK_ROOT, lstatRepositoryPath, MAX_JSON_TEXT_BYTES, pathExists, readDirectory, readUtf8File, RUNS_ROOT } from './repository.js'
import { compareCodeUnits } from './stable-json.js'

const RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const TRANSACTION_COMMANDS = new Set(['init', 'update', 'prune'])
const TRANSACTION_PHASES = new Set(['staged', 'validated', 'committing', 'committed', 'restored', 'recovery_required', 'failed'])

function issueDiagnostics(graph: KnowledgeGraph): readonly import('./protocol.js').Diagnostic[] {
  return graph.issues.map(item => diagnostic(item.code, item.message, 'error', item.path))
}

function requireReady(graph: KnowledgeGraph): void {
  if (graph.contextState !== 'ready') {
    const first = graph.issues[0]
    throw new RuntimeFault(
      first?.code ?? 'CONTEXT_NOT_READY',
      first?.message ?? 'Formal Context is not ready.',
      first?.path ?? 'context',
    )
  }
}

async function activeRun(root: string): Promise<{ readonly value?: JsonObject, readonly diagnostics: readonly import('./protocol.js').Diagnostic[] }> {
  if (!await pathExists(root, LOCK_ROOT))
    return { diagnostics: [] }
  try {
    const info = await lstatRepositoryPath(root, LOCK_ROOT)
    if (info === undefined || !info.isDirectory())
      return { diagnostics: [diagnostic('WRITE_LOCK_INVALID', 'The Context write lock is not a regular directory.', 'warning', LOCK_ROOT)] }
    const owner = JSON.parse(await readUtf8File(root, `${LOCK_ROOT}/owner.json`, MAX_JSON_TEXT_BYTES)) as unknown
    if (typeof owner !== 'object' || owner === null || Array.isArray(owner)
      || typeof (owner as Record<string, unknown>).runId !== 'string'
      || !RUN_ID.test((owner as Record<string, unknown>).runId as string)) {
      return { diagnostics: [diagnostic('WRITE_LOCK_INVALID', 'The Context write lock owner is invalid.', 'warning', LOCK_ROOT)] }
    }
    const runId = (owner as { runId: string }).runId
    const manifestPath = `${RUNS_ROOT}/${runId}/manifest.json`
    const manifest = JSON.parse(await readUtf8File(root, manifestPath, MAX_JSON_TEXT_BYTES)) as unknown
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest))
      return { diagnostics: [diagnostic('ACTIVE_RUN_INVALID', 'The active transaction manifest is invalid.', 'warning', manifestPath)] }
    const value = manifest as Record<string, unknown>
    if (value.runId !== runId || typeof value.command !== 'string' || !TRANSACTION_COMMANDS.has(value.command)
      || typeof value.phase !== 'string' || !TRANSACTION_PHASES.has(value.phase)) {
      return { diagnostics: [diagnostic('ACTIVE_RUN_INVALID', 'The active transaction manifest identity is invalid.', 'warning', manifestPath)] }
    }
    return { value: { runId, command: value.command, phase: value.phase }, diagnostics: [] }
  }
  catch {
    return { diagnostics: [diagnostic('ACTIVE_RUN_INVALID', 'The active transaction could not be inspected safely.', 'warning', LOCK_ROOT)] }
  }
}

export async function repositoryInspect(root: string, request: RuntimeRequest): Promise<RuntimeResponse> {
  const input = request.input as RepositoryInspectInput
  const graph = await loadKnowledge(root)
  const active = await activeRun(root)
  const fingerprint = graph.contextFingerprint ?? graph.contextState
  const selected = [...(input.selectedDocumentIds ?? [])].sort(compareCodeUnits).map((id): JsonObject => {
    const current = graph.ledgers.get(id)
    const recorded = graph.meta?.documents[id]
    if (current === undefined)
      return { id, state: 'missing' }
    return {
      id,
      state: recorded !== undefined && JSON.stringify(current) === JSON.stringify(recorded) ? 'fresh' : 'stale',
      sourceFingerprint: current.sourceFingerprint,
    }
  })
  const offset = decodeCursor(request.cursor, request.capability, request.input, fingerprint)
  const cursorFor = (nextOffset: number): string => encodeCursor(request.capability, request.input, fingerprint, nextOffset)
  const response = (items: readonly JsonObject[], cursor?: string): RuntimeResponse => runtimeResponse(
    'repository.inspect',
    cursor === undefined ? 'success' : 'incomplete',
    {
      data: {
        context: {
          state: graph.contextState,
          ...(graph.contextFingerprint === undefined ? {} : { fingerprint: graph.contextFingerprint }),
        },
        ...(graph.contextState === 'absent' ? {} : { counts: { ...graph.counts } }),
        meta: { state: graph.metaState },
        ...(active.value === undefined ? {} : { activeRun: active.value }),
        ...(input.selectedDocumentIds === undefined ? {} : { selected: [...items] }),
      },
      ...(cursor === undefined ? {} : { cursor }),
      diagnostics: [...issueDiagnostics(graph), ...active.diagnostics],
    },
  )
  const page = paginate(selected, offset, resolvedBudget(request), { response, cursor: cursorFor })
  const cursor = page.nextOffset === undefined ? undefined : cursorFor(page.nextOffset)
  return response(page.items, cursor)
}

function pathSelects(document: ContextDocument, selectedPath: string): boolean {
  return document.codePaths.some(pattern => pattern === selectedPath || (pattern.includes('*') && controlledGlobMatches(pattern, selectedPath)))
}

function frontierCandidates(graph: KnowledgeGraph, input: FrontierQueryInput): readonly { readonly document: ContextDocument, readonly reasons: readonly string[] }[] {
  const selectors = input.selectors
  if (input.depth === 1) {
    let ids = [...graph.domains.keys()]
    if (selectors?.domainIds !== undefined)
      ids = ids.filter(id => selectors.domainIds?.includes(id))
    if (selectors?.documentIds !== undefined) {
      const selectedDomains = new Set(selectors.documentIds.map(id => graph.documents.get(id)?.domain).filter((id): id is string => id !== undefined))
      ids = ids.filter(id => selectedDomains.has(id))
    }
    if (selectors?.kinds !== undefined && !selectors.kinds.includes('domain'))
      ids = []
    if (selectors?.relation !== undefined) {
      const related = graph.documents.get(selectors.relation.documentId)?.relations[selectors.relation.type] ?? []
      const domains = new Set(related.map(id => graph.documents.get(id)?.domain).filter((id): id is string => id !== undefined))
      ids = ids.filter(id => domains.has(id))
    }
    if (selectors?.codePaths !== undefined) {
      const domains = new Set([...graph.documents.values()]
        .filter(document => selectors.codePaths?.some(candidate => pathSelects(document, candidate)))
        .map(document => document.domain))
      ids = ids.filter(id => domains.has(id))
    }
    return ids.sort(compareCodeUnits).flatMap((id) => {
      const domainDocumentId = graph.domains.get(id)?.domainDocumentId
      const document = domainDocumentId === undefined ? undefined : graph.documents.get(domainDocumentId)
      return document === undefined ? [] : [{ document, reasons: ['selected Domain'] }]
    })
  }

  const seeds = new Map<string, Set<string>>()
  const add = (id: string, reason: string): void => {
    if (!graph.documents.has(id))
      return
    const reasons = seeds.get(id) ?? new Set<string>()
    reasons.add(reason)
    seeds.set(id, reasons)
  }
  selectors?.documentIds?.forEach(id => add(id, 'selected Document'))
  selectors?.domainIds?.forEach((domain) => {
    for (const id of graph.domains.get(domain)?.documentIds ?? [])
      add(id, `selected Domain ${domain}`)
  })
  if (selectors?.kinds !== undefined) {
    for (const document of graph.documents.values()) {
      if (selectors.kinds.includes(document.kind)
        && (selectors.domainIds === undefined || selectors.domainIds.includes(document.domain))) {
        add(document.id, `selected kind ${document.kind}`)
      }
    }
  }
  if (selectors?.relation !== undefined) {
    for (const id of graph.documents.get(selectors.relation.documentId)?.relations[selectors.relation.type] ?? [])
      add(id, `${selectors.relation.type} from ${selectors.relation.documentId}`)
  }
  selectors?.codePaths?.forEach((candidate) => {
    for (const document of graph.documents.values()) {
      if (pathSelects(document, candidate))
        add(document.id, `code path ${candidate}`)
    }
  })
  if (input.requiresClosure === true) {
    for (const item of requiresClosure(graph, [...seeds.keys()]))
      item.reasons.forEach(reason => add(item.id, reason))
  }
  return [...seeds.entries()]
    .map(([id, reasons]) => ({ document: graph.documents.get(id) as ContextDocument, reasons: [...reasons].sort(compareCodeUnits) }))
    .sort((left, right) => {
      const leftDomain = left.document.kind === 'domain' ? 0 : 1
      const rightDomain = right.document.kind === 'domain' ? 0 : 1
      return leftDomain - rightDomain || compareCodeUnits(left.document.id, right.document.id)
    })
}

export async function frontierQuery(root: string, request: RuntimeRequest): Promise<RuntimeResponse> {
  const input = request.input as FrontierQueryInput
  input.selectors?.codePaths?.forEach(assertSourcePath)
  const graph = await loadKnowledge(root)
  requireReady(graph)
  const fingerprint = graph.contextFingerprint as string
  const explicitBodyIds = new Set(input.selectors?.documentIds ?? [])
  const items = frontierCandidates(graph, input).map(({ document, reasons }): JsonObject => ({
    ...documentMetadata(document, reasons),
    ...(input.depth === 3 && explicitBodyIds.has(document.id) ? { body: document.body } : {}),
  }))
  const offset = decodeCursor(request.cursor, request.capability, request.input, fingerprint)
  const cursorFor = (nextOffset: number): string => encodeCursor(request.capability, request.input, fingerprint, nextOffset)
  const response = (pageItems: readonly JsonObject[], cursor?: string): RuntimeResponse => runtimeResponse(
    'frontier.query',
    cursor === undefined ? 'success' : 'incomplete',
    {
      data: { contextFingerprint: fingerprint, items: [...pageItems] },
      ...(cursor === undefined ? {} : { cursor }),
    },
  )
  const page = paginate(items, offset, resolvedBudget(request), { response, cursor: cursorFor })
  const cursor = page.nextOffset === undefined ? undefined : cursorFor(page.nextOffset)
  return response(page.items, cursor)
}

export async function graphValidate(root: string): Promise<RuntimeResponse> {
  const graph = await loadKnowledge(root)
  if (graph.contextState !== 'ready') {
    return runtimeResponse('graph.validate', 'failed', { diagnostics: issueDiagnostics(graph).length === 0
      ? [diagnostic('CONTEXT_NOT_READY', 'Formal Context is absent or invalid.', 'error', 'context')]
      : issueDiagnostics(graph) })
  }
  return runtimeResponse('graph.validate', 'success', {
    data: {
      contextFingerprint: graph.contextFingerprint as string,
      domainCount: graph.domains.size,
      documentCount: graph.documents.size,
      relationCount: graph.relationCount,
      sourceDeclarationCount: graph.sourceDeclarationCount,
    },
  })
}

function subtract(current: Metrics, baseline: Metrics | undefined): JsonObject {
  return {
    documentCount: current.documentCount - (baseline?.documentCount ?? 0),
    frontMatterBytes: current.frontMatterBytes - (baseline?.frontMatterBytes ?? 0),
    bodyBytes: current.bodyBytes - (baseline?.bodyBytes ?? 0),
    estimatedTokens: current.estimatedTokens - (baseline?.estimatedTokens ?? 0),
  }
}

function growthCandidates(graph: KnowledgeGraph): readonly JsonObject[] {
  const candidates: JsonObject[] = []
  const duplicates = new Map<string, string[]>()
  for (const document of graph.documents.values()) {
    const key = `${frontMatterFingerprint(document)}:${bodyFingerprint(document)}`
    const ids = duplicates.get(key) ?? []
    ids.push(document.id)
    duplicates.set(key, ids)
  }
  for (const ids of duplicates.values()) {
    if (ids.length > 1)
      candidates.push({ kind: 'duplicate', documentIds: ids.sort(compareCodeUnits), reasons: ['identical normalized front matter and body'] })
  }
  for (const [domainId, domain] of graph.domains) {
    const small = domain.documentIds.filter(id => (graph.documents.get(id)?.bodyBytes ?? 0) < 256)
    if (small.length >= 3)
      candidates.push({ kind: 'fragmented', documentIds: small.sort(compareCodeUnits), reasons: [`${domainId} contains at least three bodies below 256 bytes`] })
    if (domain.documentIds.length >= 4 && domain.documentIds.length * 2 > graph.documents.size)
      candidates.push({ kind: 'concentrated', documentIds: [...domain.documentIds], reasons: [`${domainId} owns more than half of all Documents`] })
  }
  for (const document of graph.documents.values()) {
    const incoming = [...graph.documents.values()].some(candidate => candidate.relations.requires.includes(document.id) || candidate.relations.related.includes(document.id))
    const outgoing = document.relations.requires.length + document.relations.related.length
    if (document.kind !== 'domain' && !incoming && outgoing === 0 && document.codePaths.length === 0)
      candidates.push({ kind: 'orphaned', documentIds: [document.id], reasons: ['no code paths or current requires/related edges'] })
  }
  return candidates.sort((left, right) => compareCodeUnits(JSON.stringify(left), JSON.stringify(right)))
}

export async function growthMeasure(root: string, request: RuntimeRequest): Promise<RuntimeResponse> {
  const graph = await loadKnowledge(root)
  requireReady(graph)
  const metrics = graphMetrics(graph)
  const baseline = graph.meta?.convergence
  const candidates = growthCandidates(graph)
  const fingerprint = graph.contextFingerprint as string
  const offset = decodeCursor(request.cursor, request.capability, request.input, fingerprint)
  const perDomain: JsonObject = {}
  for (const [id, values] of Object.entries(metrics.perDomain).sort(([left], [right]) => compareCodeUnits(left, right)))
    perDomain[id] = { ...values }
  const cursorFor = (nextOffset: number): string => encodeCursor(request.capability, request.input, fingerprint, nextOffset)
  const response = (pageItems: readonly JsonObject[], cursor?: string): RuntimeResponse => runtimeResponse(
    'growth.measure',
    cursor === undefined ? 'success' : 'incomplete',
    {
      data: {
        current: { ...metrics.current },
        ...(baseline === undefined ? {} : { baseline: { ...baseline, perDomain: Object.fromEntries(Object.entries(baseline.perDomain)) as unknown as JsonValue } }),
        delta: subtract(metrics.current, baseline),
        perDomain,
        candidates: [...pageItems],
      },
      ...(cursor === undefined ? {} : { cursor }),
    },
  )
  const page = paginate(candidates, offset, resolvedBudget(request), { response, cursor: cursorFor })
  const cursor = page.nextOffset === undefined ? undefined : cursorFor(page.nextOffset)
  return response(page.items, cursor)
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim()
}

function terms(value: string): ReadonlySet<string> {
  return new Set(normalize(value).match(/[\p{L}\p{N}]+/gu) ?? [])
}

function feedbackSections(source: string): string | undefined {
  const headings = ['Context', 'Observed behavior', 'Outcome or correction', 'Evidence', 'Reuse boundary']
  const positions = headings.map(heading => source.indexOf(`# ${heading}`))
  if (positions.some((position, index) => position < 0 || (index > 0 && position <= (positions[index - 1] as number))))
    return undefined
  return source
}

interface MatchSource { readonly kind: 'feedback' | 'reflection', readonly id: string, readonly path: string, readonly text: string }

const FEEDBACK_FILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{8}\.md$/

async function matchSources(root: string, graph: KnowledgeGraph): Promise<readonly MatchSource[]> {
  const sources: MatchSource[] = []
  if (await pathExists(root, FEEDBACK_ROOT)) {
    for (const entry of await readDirectory(root, FEEDBACK_ROOT)) {
      const sourcePath = `${FEEDBACK_ROOT}/${entry.name}`
      if (entry.kind !== 'file' || !FEEDBACK_FILE_NAME.test(entry.name))
        throw new RuntimeFault('FEEDBACK_FILE_INVALID', 'Feedback storage contains an invalid entry.', sourcePath)
      const source = await readUtf8File(root, sourcePath, MAX_JSON_TEXT_BYTES)
      if (feedbackSections(source) === undefined)
        throw new RuntimeFault('FEEDBACK_FORMAT_INVALID', 'Feedback Markdown does not use the fixed short structure.', sourcePath)
      sources.push({ kind: 'feedback', id: entry.name.slice(0, -3), path: sourcePath, text: source })
    }
  }
  for (const document of graph.documents.values()) {
    if (document.kind === 'reflection')
      sources.push({ kind: 'reflection', id: document.id, path: document.path, text: `${document.description}\n${document.body}` })
  }
  return sources.sort((left, right) => compareCodeUnits(`${left.kind}\0${left.id}`, `${right.kind}\0${right.id}`))
}

export async function feedbackMatch(root: string, request: RuntimeRequest): Promise<RuntimeResponse> {
  const input = request.input as FeedbackMatchInput
  const graph = await loadKnowledge(root)
  if (graph.contextState === 'invalid')
    requireReady(graph)
  const queryText = `${input.context}\n${input.observedBehavior}\n${input.outcomeOrCorrection}\n${input.reuseBoundary}`
  const queryTerms = terms(queryText)
  const matches = (await matchSources(root, graph)).flatMap((source): JsonObject[] => {
    const overlap = [...terms(source.text)].filter(term => queryTerms.has(term)).sort(compareCodeUnits)
    if (overlap.length === 0)
      return []
    return [{ kind: source.kind, id: source.id, path: source.path, reasons: overlap.slice(0, 12).map(term => `shared term: ${term}`) }]
  })
  const slugTerms = [...terms(`${input.context} ${input.observedBehavior}`)].slice(0, 4)
  const slug = slugTerms.length === 0 ? 'feedback' : slugTerms.join('-').slice(0, 48)
  const suggestedId = `${slug}-${sha256(normalize(queryText)).slice(0, 8)}`
  const fingerprint = graph.contextFingerprint ?? graph.contextState
  const offset = decodeCursor(request.cursor, request.capability, request.input, fingerprint)
  const cursorFor = (nextOffset: number): string => encodeCursor(request.capability, request.input, fingerprint, nextOffset)
  const response = (pageItems: readonly JsonObject[], cursor?: string): RuntimeResponse => runtimeResponse(
    'feedback.match',
    cursor === undefined ? 'success' : 'incomplete',
    {
      data: { suggestedId, matches: [...pageItems] },
      ...(cursor === undefined ? {} : { cursor }),
    },
  )
  const page = paginate(matches, offset, resolvedBudget(request), { response, cursor: cursorFor })
  const cursor = page.nextOffset === undefined ? undefined : cursorFor(page.nextOffset)
  return response(page.items, cursor)
}
