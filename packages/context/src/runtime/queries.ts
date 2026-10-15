import type { ContextDocument, Metrics } from './document.js'
import type { KnowledgeGraph } from './graph.js'
import type {
  CursorPosition,
  Diagnostic,
  FeedbackMatchInput,
  FrontierQueryInput,
  RepositoryInspectInput,
  RuntimeRequest,
  RuntimeResponse,
} from './protocol.js'
import type { JsonObject, JsonValue } from './stable-json.js'
import { Buffer } from 'node:buffer'
import { bodyFingerprint } from './document.js'
import { documentMetadata, graphMetrics, loadKnowledge, requiresClosure, reviewPendingIds } from './graph.js'
import {
  decodeCursor,
  diagnostic,
  encodeCursor,
  fitBodyChunk,
  paginate,
  resolvedBudget,
  RuntimeFault,
  runtimeResponse,
  sha256,
} from './protocol.js'
import {
  assertSourcePattern,
  declarationMatches,
  decodeUtf8,
  FEEDBACK_ROOT,
  LOCK_ROOT,
  MAX_JSON_TEXT_BYTES,
  pathExists,
  readDirectory,
  readLockOwner,
  readRegularBytes,
  readUtf8File,
  RUNS_ROOT,
} from './repository.js'
import { compactJson, compareCodeUnits } from './stable-json.js'

const TRANSACTION_COMMANDS = new Set(['init', 'update', 'prune'])
const TRANSACTION_PHASES = new Set(['staged', 'validated', 'committing', 'committed', 'restored', 'recovery_required', 'failed'])

function issueDiagnostics(graph: KnowledgeGraph, includeSource = false): readonly Diagnostic[] {
  return [
    ...graph.issues.map(item => diagnostic(item.code, item.message, 'error', item.path)),
    ...(includeSource ? graph.sourceIssues.map(item => diagnostic(item.code, item.message, 'error', item.path)) : []),
  ]
}

function requireFormalReady(graph: KnowledgeGraph): void {
  if (graph.formalState !== 'ready') {
    const first = graph.issues[0]
    throw new RuntimeFault(
      first?.code ?? 'CONTEXT_NOT_READY',
      first?.message ?? 'Formal Context is not ready.',
      first?.path ?? 'context',
    )
  }
}

async function activeRun(root: string): Promise<{ readonly value?: JsonObject, readonly diagnostics: readonly Diagnostic[] }> {
  const lock = await readLockOwner(root)
  if (lock.state === 'absent')
    return { diagnostics: [] }
  if (lock.state === 'corrupt')
    return { diagnostics: [diagnostic('WRITE_LOCK_INVALID', 'The Context write lock owner is invalid.', 'warning', LOCK_ROOT)] }
  const manifestPath = `${RUNS_ROOT}/${lock.runId}/manifest.json`
  try {
    const manifest = JSON.parse(await readUtf8File(root, manifestPath, MAX_JSON_TEXT_BYTES)) as unknown
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest))
      return { diagnostics: [diagnostic('ACTIVE_RUN_INVALID', 'The active transaction manifest is invalid.', 'warning', manifestPath)] }
    const value = manifest as Record<string, unknown>
    if (value.runId !== lock.runId || typeof value.command !== 'string' || !TRANSACTION_COMMANDS.has(value.command)
      || typeof value.phase !== 'string' || !TRANSACTION_PHASES.has(value.phase)) {
      return { diagnostics: [diagnostic('ACTIVE_RUN_INVALID', 'The active transaction manifest identity is invalid.', 'warning', manifestPath)] }
    }
    return { value: { runId: lock.runId, command: value.command, phase: value.phase }, diagnostics: [] }
  }
  catch (error) {
    if (error instanceof RuntimeFault || error instanceof SyntaxError)
      return { diagnostics: [diagnostic('ACTIVE_RUN_INVALID', 'The active transaction could not be inspected safely.', 'warning', LOCK_ROOT)] }
    throw error
  }
}

export async function repositoryInspect(root: string, request: RuntimeRequest): Promise<RuntimeResponse> {
  const input = request.input as RepositoryInspectInput
  const selectedIds = [...(input.selectedDocumentIds ?? [])].sort(compareCodeUnits)
  const graph = await loadKnowledge(root, undefined, selectedIds.length === 0
    ? { sourcePolicy: 'formal-only' }
    : { sourcePolicy: 'selected', selectedDocumentIds: selectedIds })
  const active = await activeRun(root)
  const contextFingerprint = graph.contextFingerprint ?? 'formal:absent'
  const unavailable = new Set(graph.sourceIssues.map(item => item.documentId))
  const selected = selectedIds.map((id): JsonObject => {
    const document = graph.documents.get(id)
    if (document === undefined)
      return { id, state: 'missing' }
    const current = graph.ledgers.get(id)
    if (current === undefined || unavailable.has(id))
      return { id, state: 'source_unavailable' }
    const recorded = graph.meta?.documents[id]
    return {
      id,
      state: recorded !== undefined
        && compactJson(current as unknown as JsonValue) === compactJson(recorded as unknown as JsonValue)
        ? 'fresh'
        : 'stale',
      sourceFingerprint: current.sourceFingerprint,
    }
  })
  const stateFingerprint = sha256(compactJson({
    selected,
    activeRun: active.value ?? null,
    activeDiagnostics: active.diagnostics.map(item => item.code),
  }))
  const position = decodeCursor(request.cursor, request.capability, request.input, contextFingerprint, stateFingerprint)
  const cursorFor = (next: CursorPosition): string => encodeCursor(
    request.capability,
    request.input,
    contextFingerprint,
    stateFingerprint,
    next,
  )
  const response = (items: readonly JsonObject[], cursor?: string): RuntimeResponse => runtimeResponse(
    'repository.inspect',
    cursor === undefined ? 'success' : 'incomplete',
    {
      data: {
        context: {
          state: graph.formalState,
          sourceState: graph.sourceState,
          ...(graph.contextFingerprint === undefined ? {} : { fingerprint: graph.contextFingerprint }),
        },
        ...(graph.formalState === 'absent' ? {} : { counts: { ...graph.counts } }),
        meta: { state: graph.metaState },
        ...(active.value === undefined ? {} : { activeRun: active.value }),
        ...(input.selectedDocumentIds === undefined ? {} : { selected: [...items] }),
      },
      ...(cursor === undefined ? {} : { cursor }),
      diagnostics: [...issueDiagnostics(graph), ...active.diagnostics],
    },
  )
  const page = paginate(selected, position, resolvedBudget(request), { response, cursor: cursorFor })
  const cursor = page.nextPosition === undefined ? undefined : cursorFor(page.nextPosition)
  return response(page.items, cursor)
}

function pathSelects(document: ContextDocument, selector: string): boolean {
  // ponytail: two-way declarationMatches approximates set overlap between a declaration and a
  // selector that may itself be a glob. A mid-segment wildcard on both sides (`packages/*/a.ts`
  // selected by `packages/foo/**`) is missed; upgrade to interval intersection if that shows up.
  return document.codePaths.some(pattern =>
    declarationMatches(pattern, selector) || declarationMatches(selector, pattern))
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

interface FrontierItem {
  readonly metadata: JsonObject
  readonly body?: string
}

export async function frontierQuery(root: string, request: RuntimeRequest): Promise<RuntimeResponse> {
  const input = request.input as FrontierQueryInput
  input.selectors?.codePaths?.forEach(assertSourcePattern)
  const graph = await loadKnowledge(root, undefined, { sourcePolicy: 'formal-only' })
  requireFormalReady(graph)
  const contextFingerprint = graph.contextFingerprint as string
  const stateFingerprint = contextFingerprint
  const explicitBodyIds = new Set(input.selectors?.documentIds ?? [])
  const items: readonly FrontierItem[] = frontierCandidates(graph, input).map(({ document, reasons }) => ({
    metadata: documentMetadata(document, reasons),
    ...(input.depth === 3 && explicitBodyIds.has(document.id) ? { body: document.body } : {}),
  }))
  const position = decodeCursor(request.cursor, request.capability, request.input, contextFingerprint, stateFingerprint)
  if (position.itemOffset > items.length || (position.itemOffset === items.length && request.cursor !== undefined))
    throw new RuntimeFault('CURSOR_INVALID', 'The continuation cursor points beyond the current result stream.')
  const cursorFor = (next: CursorPosition): string => encodeCursor(
    request.capability,
    request.input,
    contextFingerprint,
    stateFingerprint,
    next,
  )
  const response = (pageItems: readonly JsonObject[], cursor?: string): RuntimeResponse => runtimeResponse(
    'frontier.query',
    cursor === undefined ? 'success' : 'incomplete',
    {
      data: { contextFingerprint, items: [...pageItems] },
      ...(cursor === undefined ? {} : { cursor }),
    },
  )
  if (items.length === 0)
    return response([])

  const current = items[position.itemOffset] as FrontierItem
  if (current.body !== undefined) {
    const startByte = position.bodyByteOffset ?? 0
    const totalBytes = Buffer.byteLength(current.body, 'utf8')
    const continuation = (endByte: number): string | undefined => {
      if (endByte < totalBytes)
        return cursorFor({ itemOffset: position.itemOffset, bodyByteOffset: endByte })
      return position.itemOffset + 1 < items.length ? cursorFor({ itemOffset: position.itemOffset + 1 }) : undefined
    }
    const chunk = fitBodyChunk(
      current.body,
      startByte,
      resolvedBudget(request),
      (candidate, cursor) => response([{ ...current.metadata, body: candidate }], cursor),
      continuation,
    )
    return response([{ ...current.metadata, body: chunk }], continuation(chunk.endByte))
  }
  if (position.bodyByteOffset !== undefined)
    throw new RuntimeFault('CURSOR_INVALID', 'The continuation cursor points inside an item without a body.')

  // Metadata pages use the shared paginator so an item that fits the hard limit but not the
  // caller budget fails with BUDGET_TOO_SMALL instead of emitting a non-advancing cursor.
  // Pagination stops at the first body item: bodies are chunked by the branch above.
  const nextBody = items.findIndex((item, index) => index >= position.itemOffset && item.body !== undefined)
  const runEnd = nextBody === -1 ? items.length : nextBody
  const page = paginate(
    items.slice(position.itemOffset, runEnd).map(item => item.metadata),
    { itemOffset: 0 },
    resolvedBudget(request),
    {
      response,
      cursor: next => cursorFor({ itemOffset: position.itemOffset + next.itemOffset }),
    },
  )
  const consumed = position.itemOffset + page.items.length
  const cursor = consumed < items.length ? cursorFor({ itemOffset: consumed }) : undefined
  return response(page.items, cursor)
}

export async function graphValidate(root: string): Promise<RuntimeResponse> {
  const graph = await loadKnowledge(root, undefined, { sourcePolicy: 'all-strict' })
  // A Document whose cited sources moved since it was last proven is pending review, not broken:
  // the tree is still valid and every capability still works. Code changing ahead of knowledge is
  // the normal state of an active repository, so it is reported for the next Update to settle and
  // never fails validation. Structural and evidence faults still do.
  const pendingReview = reviewPendingIds(graph).map(id =>
    diagnostic('DOCUMENT_REVIEW_PENDING', `Document "${id}" cites sources that changed since it was last reviewed.`, 'warning', graph.documents.get(id)?.path ?? 'context/meta.json'))
  if (graph.formalState !== 'ready' || graph.sourceState !== 'ready') {
    const diagnostics = [...issueDiagnostics(graph, true), ...pendingReview]
    return runtimeResponse('graph.validate', 'failed', { diagnostics: diagnostics.length === 0
      ? [diagnostic('CONTEXT_NOT_READY', 'Formal Context is absent or invalid.', 'error', 'context')]
      : diagnostics })
  }
  return runtimeResponse('graph.validate', 'success', {
    data: {
      contextFingerprint: graph.contextFingerprint as string,
      domainCount: graph.domains.size,
      documentCount: graph.documents.size,
      relationCount: graph.relationCount,
      sourceDeclarationCount: graph.sourceDeclarationCount,
    },
    ...(pendingReview.length === 0 ? {} : { diagnostics: pendingReview }),
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
    const key = `${document.kind}:${bodyFingerprint(document)}`
    const ids = duplicates.get(key) ?? []
    ids.push(document.id)
    duplicates.set(key, ids)
  }
  for (const ids of duplicates.values()) {
    if (ids.length > 1)
      candidates.push({ kind: 'duplicate', documentIds: ids.sort(compareCodeUnits), reasons: ['same kind and identical normalized body'] })
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
  return candidates.sort((left, right) => compareCodeUnits(compactJson(left), compactJson(right)))
}

export async function growthMeasure(root: string, request: RuntimeRequest): Promise<RuntimeResponse> {
  const graph = await loadKnowledge(root, undefined, { sourcePolicy: 'formal-only' })
  requireFormalReady(graph)
  const metrics = graphMetrics(graph)
  const baseline = graph.meta?.convergence
  const stream: JsonObject[] = []
  for (const [id, current] of Object.entries(metrics.perDomain).sort(([left], [right]) => compareCodeUnits(left, right))) {
    const domainBaseline = baseline?.perDomain[id]
    stream.push({ section: 'domain', value: {
      id,
      current: { ...current },
      ...(domainBaseline === undefined ? {} : { baseline: { ...domainBaseline } }),
      delta: subtract(current, domainBaseline),
    } })
  }
  growthCandidates(graph).forEach(value => stream.push({ section: 'candidate', value }))
  const contextFingerprint = graph.contextFingerprint as string
  const stateFingerprint = contextFingerprint
  const position = decodeCursor(request.cursor, request.capability, request.input, contextFingerprint, stateFingerprint)
  const cursorFor = (next: CursorPosition): string => encodeCursor(request.capability, request.input, contextFingerprint, stateFingerprint, next)
  const response = (pageItems: readonly JsonObject[], cursor?: string): RuntimeResponse => runtimeResponse(
    'growth.measure',
    cursor === undefined ? 'success' : 'incomplete',
    {
      data: {
        current: { ...metrics.current },
        ...(baseline === undefined ? {} : { baseline: { ...baseline, perDomain: Object.fromEntries(Object.entries(baseline.perDomain)) as unknown as JsonValue } }),
        delta: subtract(metrics.current, baseline),
        perDomain: pageItems.filter(item => item.section === 'domain').map(item => item.value as JsonValue),
        candidates: pageItems.filter(item => item.section === 'candidate').map(item => item.value as JsonValue),
      },
      ...(cursor === undefined ? {} : { cursor }),
    },
  )
  const page = paginate(stream, position, resolvedBudget(request), { response, cursor: cursorFor })
  const cursor = page.nextPosition === undefined ? undefined : cursorFor(page.nextPosition)
  return response(page.items, cursor)
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

function terms(value: string): ReadonlySet<string> {
  return new Set(normalize(value).match(/[\p{L}\p{N}]+/gu) ?? [])
}

interface FeedbackFields {
  readonly context: string
  readonly observedBehavior: string
  readonly outcomeOrCorrection: string
  readonly evidence: string
  readonly reuseBoundary: string
}

const FEEDBACK_HEADINGS = ['Context', 'Observed behavior', 'Outcome or correction', 'Evidence', 'Reuse boundary'] as const
const FEEDBACK_FILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{8}\.md$/

function feedbackSections(source: string): FeedbackFields | undefined {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const bodies: string[][] = FEEDBACK_HEADINGS.map(() => [])
  let heading = -1
  for (const line of normalized.split('\n')) {
    if (line.startsWith('# ')) {
      const expected = FEEDBACK_HEADINGS[heading + 1]
      if (expected === undefined || line !== `# ${expected}`)
        return undefined
      heading += 1
      continue
    }
    if (heading < 0) {
      if (line.trim().length > 0)
        return undefined
      continue
    }
    ;(bodies[heading] as string[]).push(line)
  }
  if (heading !== FEEDBACK_HEADINGS.length - 1 || bodies.some(lines => lines.join('\n').trim().length === 0))
    return undefined
  return {
    context: (bodies[0] as string[]).join('\n').trim(),
    observedBehavior: (bodies[1] as string[]).join('\n').trim(),
    outcomeOrCorrection: (bodies[2] as string[]).join('\n').trim(),
    evidence: (bodies[3] as string[]).join('\n').trim(),
    reuseBoundary: (bodies[4] as string[]).join('\n').trim(),
  }
}

function feedbackIdentity(fields: Omit<FeedbackFields, 'evidence'>): JsonObject {
  return {
    context: normalize(fields.context),
    observedBehavior: normalize(fields.observedBehavior),
    outcomeOrCorrection: normalize(fields.outcomeOrCorrection),
    reuseBoundary: normalize(fields.reuseBoundary),
  }
}

function asciiSlug(fields: Pick<FeedbackFields, 'context' | 'observedBehavior'>): string {
  const normalized = normalize(`${fields.context} ${fields.observedBehavior}`)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
  const found = normalized.match(/[a-z0-9]+/g) ?? []
  const slug = found.slice(0, 4).join('-').slice(0, 48).replace(/-+$/g, '')
  return slug.length === 0 ? 'feedback' : slug
}

function suggestedFeedbackId(fields: Omit<FeedbackFields, 'evidence'>): string {
  return `${asciiSlug(fields)}-${sha256(compactJson(feedbackIdentity(fields))).slice(0, 8)}`
}

interface MatchSource { readonly kind: 'feedback' | 'reflection', readonly id: string, readonly path: string, readonly text: string }

async function matchSources(root: string, graph: KnowledgeGraph): Promise<{ readonly sources: readonly MatchSource[], readonly fingerprint: string }> {
  const sources: MatchSource[] = []
  const feedbackFacts: JsonObject[] = []
  if (await pathExists(root, FEEDBACK_ROOT)) {
    for (const entry of await readDirectory(root, FEEDBACK_ROOT)) {
      if (entry.kind !== 'file' || !FEEDBACK_FILE_NAME.test(entry.name))
        throw new RuntimeFault('FEEDBACK_FILE_INVALID', 'Feedback storage contains an invalid entry.', FEEDBACK_ROOT)
      const sourcePath = `${FEEDBACK_ROOT}/${entry.name}`
      const bytes = await readRegularBytes(root, sourcePath, MAX_JSON_TEXT_BYTES)
      const source = decodeUtf8(bytes, sourcePath)
      const fields = feedbackSections(source)
      if (fields === undefined)
        throw new RuntimeFault('FEEDBACK_FORMAT_INVALID', 'Feedback Markdown does not use the fixed short structure.', FEEDBACK_ROOT)
      const expected = suggestedFeedbackId(fields)
      if (entry.name !== `${expected}.md`)
        throw new RuntimeFault('FEEDBACK_IDENTITY_INVALID', 'Feedback filename does not match its normalized identity.', FEEDBACK_ROOT)
      sources.push({ kind: 'feedback', id: expected, path: sourcePath, text: Object.values(fields).join('\n') })
      feedbackFacts.push({ path: sourcePath, hash: sha256(bytes) })
    }
  }
  for (const document of graph.documents.values()) {
    if (document.kind === 'reflection')
      sources.push({ kind: 'reflection', id: document.id, path: document.path, text: `${document.description}\n${document.body}` })
  }
  return {
    sources: sources.sort((left, right) => compareCodeUnits(`${left.kind}\0${left.id}`, `${right.kind}\0${right.id}`)),
    fingerprint: sha256(compactJson(feedbackFacts.sort((left, right) => compareCodeUnits(String(left.path), String(right.path))))),
  }
}

export async function feedbackMatch(root: string, request: RuntimeRequest): Promise<RuntimeResponse> {
  const input = request.input as FeedbackMatchInput
  const graph = await loadKnowledge(root, undefined, { sourcePolicy: 'formal-only' })
  if (graph.formalState === 'invalid')
    requireFormalReady(graph)
  const queryText = `${input.context}\n${input.observedBehavior}\n${input.outcomeOrCorrection}\n${input.reuseBoundary}`
  const queryTerms = terms(queryText)
  const matched = await matchSources(root, graph)
  const matches = matched.sources.flatMap((source): JsonObject[] => {
    const overlap = [...terms(source.text)].filter(term => queryTerms.has(term)).sort(compareCodeUnits)
    if (overlap.length === 0)
      return []
    return [{ kind: source.kind, id: source.id, path: source.path, reasons: overlap.slice(0, 12).map(term => `shared term: ${term}`) }]
  })
  const suggestedId = suggestedFeedbackId({
    context: input.context,
    observedBehavior: input.observedBehavior,
    outcomeOrCorrection: input.outcomeOrCorrection,
    reuseBoundary: input.reuseBoundary,
  })
  const contextFingerprint = graph.contextFingerprint ?? 'formal:absent'
  const stateFingerprint = matched.fingerprint
  const position = decodeCursor(request.cursor, request.capability, request.input, contextFingerprint, stateFingerprint)
  const cursorFor = (next: CursorPosition): string => encodeCursor(request.capability, request.input, contextFingerprint, stateFingerprint, next)
  const response = (pageItems: readonly JsonObject[], cursor?: string): RuntimeResponse => runtimeResponse(
    'feedback.match',
    cursor === undefined ? 'success' : 'incomplete',
    {
      data: { suggestedId, matches: [...pageItems] },
      ...(cursor === undefined ? {} : { cursor }),
    },
  )
  const page = paginate(matches, position, resolvedBudget(request), { response, cursor: cursorFor })
  const cursor = page.nextPosition === undefined ? undefined : cursorFor(page.nextPosition)
  return response(page.items, cursor)
}
