import type { FrontierSelector } from './frontier.js'
import type { GitInput } from './git.js'
import type { KnowledgeGraph } from './graph.js'
import type { Ledger } from './meta.js'
import type { Operation, TransactionInput } from './transaction.js'
import type { DocumentKind, JsonObject, RuntimeRequest } from './types.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { KNOWLEDGE_ROOT, META_PATH, SCRATCH_ROOT } from './constants.js'
import { computeDelta, deltaToJson } from './delta.js'
import { buildEnvelope, envelopeToJson, isRole, readRoleBody } from './envelope.js'
import { bodyFingerprint, contentHash, frontMatterFingerprint, sourceFingerprint } from './fingerprint.js'
import { pageToJson, queryFrontier } from './frontier.js'
import { gitStateFromInput } from './git.js'
import { buildGraph } from './graph.js'
import { decidePruneSuggestion, growthToJson, measure, measureGrowth } from './knowledge.js'
import { emptyLedger, parseLedger } from './meta.js'
import { readRepositoryFile, repositoryPathExists } from './repository.js'
import { compareCodeUnits, stableJson } from './stable-json.js'
import { runTransaction } from './transaction.js'

/** The knowledge state every capability beyond `repository.inspect` needs. */
export interface KnowledgeState {
  readonly graph: KnowledgeGraph
  readonly ledger?: Ledger
  readonly ledgerIssues: readonly string[]
}

/** @returns the graph and ledger, loading each from its own authoritative source. */
export async function loadKnowledge(root: string): Promise<KnowledgeState> {
  if (!await repositoryPathExists(root, KNOWLEDGE_ROOT))
    return { graph: { documents: new Map(), domains: new Map(), codeIndex: new Map(), issues: [] }, ledgerIssues: [] }
  const graph = await buildGraph(root)

  if (!await repositoryPathExists(root, META_PATH))
    return { graph, ledgerIssues: [] }

  try {
    const parsed = parseLedger(JSON.parse(await readRepositoryFile(root, META_PATH)))
    return parsed.ok
      ? { graph, ledger: parsed.ledger, ledgerIssues: [] }
      : { graph, ledgerIssues: parsed.issues.map(issue => `${issue.code}: ${issue.message}`) }
  }
  catch {
    return { graph, ledgerIssues: ['META_UNREADABLE: The ledger is not readable JSON.'] }
  }
}

/** @returns a string array from a request parameter, or undefined when absent. */
function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value))
    return undefined
  const list = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return list.length > 0 ? list : undefined
}

/** @returns the frontier selector a request declares. */
function selectorOf(request: RuntimeRequest): FrontierSelector {
  const params = request.params ?? {}
  const projection = params.projection === 'body' ? 'body' as const : 'metadata' as const
  const relation = params.relation === 'requires' || params.relation === 'related' || params.relation === 'supersedes'
    ? params.relation
    : undefined

  const domains = stringArray(params.domains)
  const ids = stringArray(params.ids)
  const kinds = stringArray(params.kinds)
  const codePaths = stringArray(params.codePaths)

  return {
    ...(domains === undefined ? {} : { domains }),
    ...(ids === undefined ? {} : { ids }),
    ...(kinds === undefined ? {} : { kinds: kinds as readonly DocumentKind[] }),
    ...(codePaths === undefined ? {} : { codePaths }),
    ...(relation === undefined ? {} : { relation }),
    projection,
  }
}

/** @returns the graph's structural issues as a JSON payload. */
export function graphToJson(graph: KnowledgeGraph): JsonObject {
  return {
    knowledgeRoot: KNOWLEDGE_ROOT,
    documentCount: graph.documents.size,
    domains: [...graph.domains.values()]
      .sort((left, right) => compareCodeUnits(left.id, right.id))
      .map(domain => ({
        id: domain.id,
        hasDomainDocument: domain.hasDomainDocument,
        documentIds: [...domain.documentIds],
      })),
    issues: graph.issues.map(issue => ({ code: issue.code, message: issue.message, path: issue.path })),
  }
}

/** Result of one capability, before it is wrapped in a response envelope. */
export interface OperationResult {
  readonly status: 'success' | 'incomplete' | 'failed'
  readonly summary: string
  readonly data: JsonObject
  readonly cursor?: string
}

/** Runs `graph.validate`. */
export async function validateGraph(root: string): Promise<OperationResult> {
  const state = await loadKnowledge(root)
  const issues = state.graph.issues.length + state.ledgerIssues.length

  return {
    status: issues === 0 ? 'success' : 'incomplete',
    summary: issues === 0
      ? `The document graph is structurally valid across ${state.graph.domains.size} Domain(s).`
      : `The document graph has ${issues} structural issue(s).`,
    data: { ...graphToJson(state.graph), ledgerIssues: [...state.ledgerIssues] },
  }
}

/** Runs `frontier.query`. */
export async function runFrontier(root: string, request: RuntimeRequest): Promise<OperationResult> {
  const state = await loadKnowledge(root)
  const page = queryFrontier(state.graph, selectorOf(request), request.budget ?? {}, request.cursor)

  return {
    status: 'success',
    summary: page.cursor === undefined
      ? `Selected ${page.items.length} of ${page.totalCandidates} candidate document(s).`
      : `Selected ${page.items.length} of ${page.totalCandidates} candidate document(s); a continuation cursor is available.`,
    data: pageToJson(page),
    ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
  }
}

/** @returns the Git output a request supplies, if any. */
function gitInputOf(request: RuntimeRequest): GitInput | undefined {
  const raw = request.params?.git
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return undefined

  const input = raw as Record<string, unknown>
  return {
    ...(typeof input.revision === 'string' ? { revision: input.revision } : {}),
    ...(typeof input.status === 'string' ? { status: input.status } : {}),
    ...(typeof input.committed === 'string' ? { committed: input.committed } : {}),
    ...(typeof input.midOperation === 'boolean' ? { midOperation: input.midOperation } : {}),
  }
}

/** Runs `delta.compute`. */
export async function runDelta(root: string, request: RuntimeRequest): Promise<OperationResult> {
  const state = await loadKnowledge(root)
  const git = gitStateFromInput(gitInputOf(request))
  const scope = stringArray(request.scope?.ids) ?? []
  const delta = computeDelta(state.graph, state.ledger, git, scope)

  return {
    status: git.available ? 'success' : 'incomplete',
    summary: git.available
      ? `${delta.expandedClosure.length} document(s) may be affected by ${delta.changes.length} change(s).`
      : 'Change detection needs Git output; supply params.git.revision and params.git.status.',
    data: deltaToJson(delta),
  }
}

/** Runs `growth.measure`. */
export async function runGrowth(root: string): Promise<OperationResult> {
  const state = await loadKnowledge(root)
  const report = measureGrowth(state.graph, state.ledger)
  const suggestionPath = path.join(root, SCRATCH_ROOT, 'reports', 'prune-suggestion.json')
  let previousSuggestion: { baselineFingerprint?: string } = {}
  try {
    previousSuggestion = JSON.parse(await fs.readFile(suggestionPath, 'utf8')) as { baselineFingerprint?: string }
  }
  catch {
    /** A missing report means this baseline has not been surfaced yet. */
  }
  const suggestionState = previousSuggestion
  const suggestion = decidePruneSuggestion(report, state.ledger, suggestionState)
  if (suggestion.suggested) {
    await fs.mkdir(path.dirname(suggestionPath), { recursive: true })
    await fs.writeFile(suggestionPath, stableJson(suggestion.state as unknown as JsonObject))
  }

  return {
    status: 'success',
    summary: report.gateCrossed
      ? 'Knowledge growth crossed the prune threshold since the last convergence baseline.'
      : 'Knowledge growth is within the prune threshold.',
    data: { ...growthToJson(report), pruneSuggested: suggestion.suggested, suggestionBaseline: suggestion.state.baselineFingerprint ?? null },
  }
}

/** Minimal candidate metadata used by deterministic Feedback matching. */
interface FeedbackCandidate {
  readonly id: string
  readonly description: string
  readonly tags: readonly string[]
  readonly relations: readonly string[]
  readonly path: string
}

/** Reads only the compact metadata allowed for Feedback matching. */
async function feedbackCandidates(root: string): Promise<readonly FeedbackCandidate[]> {
  const candidates: FeedbackCandidate[] = []
  for (const area of ['active', 'candidates'] as const) {
    const directory = path.join(root, SCRATCH_ROOT, 'feedback', area)
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    }
    catch {
      continue
    }
    for (const entry of entries.sort((left, right) => compareCodeUnits(left.name, right.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json'))
        continue
      try {
        const raw = JSON.parse(await fs.readFile(path.join(directory, entry.name), 'utf8')) as Record<string, unknown>
        if (typeof raw.id !== 'string' || typeof raw.description !== 'string')
          continue
        const tags = Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : []
        const relations = Array.isArray(raw.relations) ? raw.relations.filter((relation): relation is string => typeof relation === 'string') : []
        candidates.push({ id: raw.id, description: raw.description, tags, relations, path: `${SCRATCH_ROOT}/feedback/${area}/${entry.name}` })
      }
      catch {
        /** Invalid feedback is ignored by matching and remains available for diagnosis. */
      }
    }
  }
  return candidates
}

/** Runs deterministic Feedback candidate matching; it never promotes or edits formal knowledge. */
export async function runFeedbackMatch(root: string, request: RuntimeRequest): Promise<OperationResult> {
  const params = request.params ?? {}
  const description = typeof params.description === 'string' ? params.description.toLowerCase() : ''
  const tags = new Set(Array.isArray(params.tags) ? params.tags.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.toLowerCase()) : [])
  const relations = new Set(Array.isArray(params.relations) ? params.relations.filter((relation): relation is string => typeof relation === 'string') : [])
  const candidates = await feedbackCandidates(root)
  const matches = candidates.filter((candidate) => {
    const textMatch = description.length === 0 || candidate.description.toLowerCase().includes(description) || description.includes(candidate.description.toLowerCase())
    const tagMatch = tags.size === 0 || candidate.tags.some(tag => tags.has(tag.toLowerCase()))
    const relationMatch = relations.size === 0 || candidate.relations.some(relation => relations.has(relation))
    return textMatch && tagMatch && relationMatch
  })
  return {
    status: 'success',
    summary: matches.length === 0
      ? 'No similar temporary or mature Feedback candidate was found.'
      : `Found ${matches.length} similar Feedback candidate(s); semantic review is still required.`,
    data: {
      candidates: matches.map(candidate => ({ id: candidate.id, description: candidate.description, tags: [...candidate.tags], relations: [...candidate.relations], path: candidate.path })),
      autoPromotion: false,
    },
  }
}

/** Runs `role.envelope` for one Internal Role invocation. */
export async function runRoleEnvelope(request: RuntimeRequest): Promise<OperationResult> {
  const params = request.params ?? {}
  const role = params.role
  const goal = params.goal
  const execution = params.execution

  if (!isRole(role)) {
    return {
      status: 'incomplete',
      summary: 'The request must name one of the three supported Internal Roles.',
      data: {},
    }
  }
  if (typeof goal !== 'string' || goal.length === 0) {
    return {
      status: 'incomplete',
      summary: 'The role envelope needs a non-empty goal.',
      data: {},
    }
  }
  if (execution !== undefined && execution !== 'native-agent' && execution !== 'inline') {
    return {
      status: 'incomplete',
      summary: 'Role execution must be native-agent or inline.',
      data: {},
    }
  }

  const mode = execution === 'native-agent' ? 'native-agent' : 'inline'
  let roleBody: string | undefined
  if (mode === 'inline') {
    const pluginRoot = params.pluginRoot
    if (typeof pluginRoot !== 'string' || pluginRoot.length === 0) {
      return {
        status: 'incomplete',
        summary: 'Inline role execution requires a pluginRoot containing the private role resource.',
        data: {},
      }
    }
    roleBody = await readRoleBody(pluginRoot, role)
    if (roleBody === undefined) {
      return {
        status: 'incomplete',
        summary: 'Inline role execution could not read the private role resource from pluginRoot.',
        data: {},
      }
    }
  }

  const scope = typeof params.scope === 'object' && params.scope !== null && !Array.isArray(params.scope)
    ? params.scope as JsonObject
    : request.scope
  const envelope = buildEnvelope({
    role,
    goal,
    ...(scope === undefined ? {} : { scope }),
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    ...(typeof params.sourceState === 'string' ? { sourceState: params.sourceState } : {}),
    ...(Array.isArray(params.inputs) ? { inputs: params.inputs.filter((item): item is string => typeof item === 'string') } : {}),
    ...(Array.isArray(params.allowedReads) ? { allowedReads: params.allowedReads.filter((item): item is string => typeof item === 'string') } : {}),
    ...(request.budget === undefined ? {} : { budget: request.budget }),
    execution: mode,
  }, roleBody)

  return {
    status: 'success',
    summary: mode === 'inline'
      ? 'Inline role envelope built; the role executes in the caller context and shares its context.'
      : 'Native-agent role envelope built; the host dispatches the role in an independent context.',
    data: envelopeToJson(envelope),
  }
}

/** @returns operation entries supplied by a command caller, rejecting malformed writes. */
function operationsOf(value: unknown): readonly Operation[] | undefined {
  if (!Array.isArray(value))
    return undefined
  const operations: Operation[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item))
      return undefined
    const raw = item as Record<string, unknown>
    if ((raw.kind !== 'write' && raw.kind !== 'replace' && raw.kind !== 'delete') || typeof raw.target !== 'string' || raw.target.length === 0 || !raw.target.startsWith(`${KNOWLEDGE_ROOT}/`))
      return undefined
    if (raw.kind !== 'delete' && typeof raw.contents !== 'string')
      return undefined
    operations.push({
      kind: raw.kind,
      target: raw.target,
      ...(raw.kind === 'delete' ? {} : { contents: raw.contents as string }),
    })
  }
  return operations
}

/** @returns a deterministic ledger describing the candidate's current formal knowledge. */
async function ledgerForCandidate(
  sourceRoot: string,
  candidateRoot: string,
  sourceState?: string,
  baselineRevision?: string,
  previous?: Ledger,
  convergenceSource?: 'init' | 'prune',
): Promise<Ledger> {
  const graph = await buildGraph(candidateRoot)
  const documents: Record<string, Ledger['documents'][string]> = {}
  for (const document of graph.documents.values()) {
    const resolved = []
    for (const declared of document.code.paths) {
      if (declared.includes('*') || declared.includes('?') || declared.includes('[') || declared.includes('{'))
        continue
      try {
        const source = await fs.readFile(path.join(sourceRoot, declared), 'utf8')
        resolved.push({ path: declared, contentHash: contentHash(source) })
      }
      catch {
        /** Missing source is represented by the declaration and remains reviewable. */
      }
    }
    documents[document.id] = {
      frontMatterFingerprint: frontMatterFingerprint(document),
      bodyFingerprint: bodyFingerprint(document),
      sourceFingerprint: sourceFingerprint(document.code.paths, resolved),
      ...(sourceState === undefined ? {} : { validatedSourceState: sourceState }),
      status: 'valid',
    }
  }

  const current = measure(graph)
  const treeFingerprint = contentHash(stableJson(Object.fromEntries(
    Object.entries(documents).sort(([left], [right]) => compareCodeUnits(left, right)),
  ) as unknown as JsonObject))
  const baseline = baselineRevision === undefined
    ? previous?.repository?.baseline
    : { revision: baselineRevision, treeFingerprint, ...(sourceState === undefined ? {} : { verifiedAt: sourceState }) }
  const convergence = convergenceSource === undefined
    ? previous?.convergence
    : convergenceSource === 'init'
      ? {
          source: 'init' as const,
          documentCount: current.documentCount,
          frontMatterBytes: current.frontMatterBytes,
          bodyBytes: current.bodyBytes,
          estimatedTokens: current.estimatedTokens,
          perDomain: current.perDomain,
        }
      : {
          source: 'prune' as const,
          documentCount: current.documentCount,
          frontMatterBytes: current.frontMatterBytes,
          bodyBytes: current.bodyBytes,
          estimatedTokens: current.estimatedTokens,
          perDomain: current.perDomain,
        }

  return {
    ...emptyLedger(previous?.toolVersion ?? '0.1.0'),
    ...(baseline === undefined ? {} : { repository: { baseline } }),
    documents,
    ...(convergence === undefined ? {} : { convergence }),
  }
}

/** @returns whether formal knowledge is structurally valid and has a readable ledger. */
async function formalKnowledgeIsValid(root: string): Promise<boolean> {
  if (!await repositoryPathExists(root, KNOWLEDGE_ROOT) || !await repositoryPathExists(root, META_PATH))
    return false
  const state = await loadKnowledge(root)
  if (state.graph.issues.length > 0 || state.ledgerIssues.length > 0 || state.ledger === undefined)
    return false
  const graphIds = [...state.graph.documents.keys()].sort(compareCodeUnits)
  const ledgerIds = Object.keys(state.ledger.documents).sort(compareCodeUnits)
  return stableJson(graphIds) === stableJson(ledgerIds)
}

/** @returns whether a present formal tree needs diagnosis instead of initialization. */
async function formalKnowledgeExists(root: string): Promise<boolean> {
  return repositoryPathExists(root, KNOWLEDGE_ROOT)
}

/** Runs the deterministic Init preflight and candidate transaction. */
export async function runInit(root: string, request: RuntimeRequest): Promise<OperationResult> {
  if (await formalKnowledgeIsValid(root)) {
    return {
      status: 'incomplete',
      summary: 'Formal knowledge is already initialized; run update instead of overwriting it.',
      data: { knowledgeRoot: KNOWLEDGE_ROOT, action: 'update' },
    }
  }
  if (await formalKnowledgeExists(root)) {
    const state = await loadKnowledge(root)
    const issues = [...state.graph.issues.map(issue => `${issue.code}: ${issue.message}`), ...state.ledgerIssues]
    return {
      status: 'incomplete',
      summary: 'Formal knowledge is present but cannot be safely initialized over; diagnose its damage before any manual rebuild.',
      data: { knowledgeRoot: KNOWLEDGE_ROOT, action: 'diagnose', issues },
    }
  }

  const runRoot = path.join(root, SCRATCH_ROOT, 'runs', 'init')
  try {
    const runs = await fs.readdir(runRoot, { withFileTypes: true })
    if (runs.some(entry => entry.isDirectory())) {
      return {
        status: 'incomplete',
        summary: 'A recoverable init run exists; resume it after reviewing its candidate.',
        data: { knowledgeRoot: KNOWLEDGE_ROOT, action: 'resume' },
      }
    }
  }
  catch {
    /** No run directory means a normal first initialization. */
  }

  const params = request.params ?? {}
  const operations = operationsOf(params.operations)
  if (operations === undefined || operations.length === 0) {
    return {
      status: 'incomplete',
      summary: 'Init needs a Recorder candidate with at least one formal document operation.',
      data: { knowledgeRoot: KNOWLEDGE_ROOT, action: 'collect-evidence' },
    }
  }

  const runId = request.runId ?? (typeof params.runId === 'string' ? params.runId : 'init')
  const sourceState = typeof params.sourceState === 'string' ? params.sourceState : undefined
  const revision = typeof params.revision === 'string' ? params.revision : undefined
  const previous = (await loadKnowledge(root)).ledger
  const input: TransactionInput = {
    root,
    runId,
    command: 'init',
    mode: 'bootstrap',
    scope: request.scope ?? {},
    authorization: { source: 'explicit-invocation', ...(params.dryRun === true ? { dryRun: true } : {}) },
    operations,
    ledger: emptyLedger('0.1.0'),
    prepareLedger: candidate => ledgerForCandidate(root, candidate, sourceState, revision, previous, 'init'),
    validate: async (candidate) => {
      const state = await loadKnowledge(candidate)
      const issues = [...state.graph.issues.map(issue => `${issue.code}: ${issue.message}`), ...state.ledgerIssues]
      if (state.graph.domains.size === 0)
        issues.push('INIT_DOMAIN_MISSING: Init must establish at least one Domain.')
      for (const domain of state.graph.domains.values()) {
        if (!domain.hasDomainDocument)
          issues.push(`INIT_DOMAIN_DOCUMENT_MISSING: Domain "${domain.id}" must contain domain.md.`)
      }
      return issues
    },
    review: async () => ({ approved: params.reviewApproved !== false }),
  }
  const result = await runTransaction(input)
  return {
    status: result.status === 'success' ? 'success' : result.status,
    summary: result.summary,
    data: {
      command: 'init',
      runId: result.runId,
      mode: 'bootstrap',
      reachedPhase: result.reachedPhase,
      committed: [...result.committed],
      issues: [...result.issues],
      journal: JSON.parse(stableJson(result.journal as unknown as JsonObject)) as JsonObject,
    },
  }
}

/** Runs a generic transaction request used by command orchestrators. */
export async function runTransactionCapability(root: string, request: RuntimeRequest): Promise<OperationResult> {
  const params = request.params ?? {}
  const command = params.command
  if (command !== 'init' && command !== 'update' && command !== 'prune') {
    return { status: 'incomplete', summary: 'Transaction command must be init, update, or prune.', data: {} }
  }
  if (command === 'init')
    return runInit(root, request)
  if (command === 'update')
    return runUpdate(root, request)
  if (command === 'prune')
    return runPrune(root, request)
  const operations = operationsOf(params.operations)
  if (operations === undefined)
    return { status: 'incomplete', summary: 'Transaction operations must be a list of safe file operations.', data: {} }
  const runId = request.runId ?? (typeof params.runId === 'string' ? params.runId : `${command}-run`)
  const mode = typeof params.mode === 'string' ? params.mode : command === 'prune' ? 'converge' : 'synchronize'
  const sourceState = typeof params.sourceState === 'string' ? params.sourceState : undefined
  const revision = typeof params.revision === 'string' ? params.revision : undefined
  const previous = (await loadKnowledge(root)).ledger
  const input: TransactionInput = {
    root,
    runId,
    command,
    mode,
    scope: request.scope ?? {},
    authorization: { source: params.authorization === 'confirmed-suggestion' ? 'confirmed-suggestion' : 'explicit-invocation', ...(params.dryRun === true ? { dryRun: true } : {}) },
    operations,
    ledger: emptyLedger('0.1.0'),
    prepareLedger: candidate => ledgerForCandidate(
      root,
      candidate,
      sourceState,
      revision,
      previous,
      command === 'prune' ? 'prune' : 'init',
    ),
    validate: async (candidate) => {
      const state = await loadKnowledge(candidate)
      return [...state.graph.issues.map(issue => `${issue.code}: ${issue.message}`), ...state.ledgerIssues]
    },
    review: async () => ({ approved: params.reviewApproved !== false }),
  }
  const result = await runTransaction(input)
  return {
    status: result.status,
    summary: result.summary,
    data: {
      command,
      runId,
      mode,
      reachedPhase: result.reachedPhase,
      committed: [...result.committed],
      issues: [...result.issues],
      journal: JSON.parse(stableJson(result.journal as unknown as JsonObject)) as JsonObject,
    },
  }
}

/** Runs Prune with a before/after coverage and size contract. */
export async function runPrune(root: string, request: RuntimeRequest): Promise<OperationResult> {
  const state = await loadKnowledge(root)
  if (state.ledger === undefined || state.graph.issues.length > 0 || state.ledgerIssues.length > 0)
    return { status: 'incomplete', summary: 'Prune needs valid formal knowledge and a readable ledger.', data: {} }
  const params = request.params ?? {}
  const operations = operationsOf(params.operations)
  if (operations === undefined || operations.length === 0)
    return { status: 'incomplete', summary: 'Prune needs a Recorder convergence candidate.', data: {} }

  const before = measure(state.graph)
  const beforeCoverage = new Set([...state.graph.codeIndex.keys()])
  const runId = request.runId ?? (typeof params.runId === 'string' ? params.runId : 'prune-run')
  const input: TransactionInput = {
    root,
    runId,
    command: 'prune',
    mode: 'converge',
    scope: request.scope ?? {},
    authorization: { source: params.authorization === 'confirmed-suggestion' ? 'confirmed-suggestion' : 'explicit-invocation', ...(params.dryRun === true ? { dryRun: true } : {}) },
    operations,
    ledger: state.ledger,
    prepareLedger: (candidate) => {
      const { convergence: _convergence, ...withoutConvergence } = state.ledger as Ledger
      return ledgerForCandidate(root, candidate, typeof params.sourceState === 'string' ? params.sourceState : undefined, undefined, withoutConvergence, 'prune')
    },
    validate: async (candidate) => {
      const candidateState = await loadKnowledge(candidate)
      const issues = [...candidateState.graph.issues.map(issue => `${issue.code}: ${issue.message}`), ...candidateState.ledgerIssues]
      const after = measure(candidateState.graph)
      const afterCoverage = new Set([...candidateState.graph.codeIndex.keys()])
      for (const declared of beforeCoverage) {
        if (!afterCoverage.has(declared))
          issues.push(`PRUNE_COVERAGE_DECREASED: code.paths coverage lost for "${declared}".`)
      }
      if (after.documentCount >= before.documentCount || after.frontMatterBytes >= before.frontMatterBytes || after.bodyBytes >= before.bodyBytes || after.estimatedTokens >= before.estimatedTokens)
        issues.push('PRUNE_SIZE_NOT_REDUCED: document count, bytes, and estimated tokens must all decrease.')
      return issues
    },
    review: async () => ({ approved: params.reviewApproved !== false }),
  }
  const result = await runTransaction(input)
  return {
    status: result.status,
    summary: result.summary,
    data: {
      command: 'prune',
      runId,
      mode: 'converge',
      before: JSON.parse(stableJson(before as unknown as JsonObject)) as JsonObject,
      ...(result.status === 'success' ? { after: JSON.parse(stableJson(measure((await loadKnowledge(root)).graph) as unknown as JsonObject)) as JsonObject } : {}),
      reachedPhase: result.reachedPhase,
      committed: [...result.committed],
      issues: [...result.issues],
      journal: JSON.parse(stableJson(result.journal as unknown as JsonObject)) as JsonObject,
    },
  }
}

/** Runs Update with deterministic Light/Deep selection and baseline advancement rules. */
export async function runUpdate(root: string, request: RuntimeRequest): Promise<OperationResult> {
  const state = await loadKnowledge(root)
  if (state.ledger === undefined || state.graph.issues.length > 0 || state.ledgerIssues.length > 0) {
    return {
      status: 'incomplete',
      summary: 'Update needs valid formal knowledge and a readable ledger before it can synchronize changes.',
      data: { issues: [...state.graph.issues.map(issue => `${issue.code}: ${issue.message}`), ...state.ledgerIssues] },
    }
  }

  const params = request.params ?? {}
  const git = gitStateFromInput(gitInputOf(request))
  if (!git.available) {
    return {
      status: 'incomplete',
      summary: 'Update needs Git output; supply params.git.revision and params.git.status.',
      data: {},
    }
  }
  const scope = stringArray(request.scope?.ids) ?? []
  const delta = computeDelta(state.graph, state.ledger, git, scope)
  if (params.knowledgeAccurate === true) {
    return {
      status: 'success',
      summary: 'The observed implementation change does not require a knowledge update.',
      data: { delta: deltaToJson(delta), strategy: 'none', pruneSuggested: false },
    }
  }

  const operations = operationsOf(params.operations)
  if (operations === undefined || operations.length === 0) {
    return {
      status: 'incomplete',
      summary: 'Update needs a Recorder synchronization candidate for the declared change scope.',
      data: { delta: deltaToJson(delta) },
    }
  }

  const intentKnown = params.intentKnown === true
  const unknownImpact = params.unknownImpact === true
  const forceDeep = params.forceDeep === true
  const light = delta.signals.lightEligible && intentKnown && !unknownImpact && !forceDeep
  const strategy = light ? 'light' as const : 'deep' as const
  const escalationReason = light
    ? undefined
    : forceDeep
      ? 'The caller requested a Deep investigation.'
      : unknownImpact
        ? 'The Light edit discovered unknown impact.'
        : !intentKnown
            ? 'The available task evidence does not explain the intended change.'
            : delta.signals.blockers.join(' ') || 'The Light conditions were not all satisfied.'

  const allRepository = scope.length === 0
  const advanceBaseline = allRepository
    && delta.baselineEligible
    && params.committedChangesCovered === true
    && git.revision !== undefined
  const runId = request.runId ?? (typeof params.runId === 'string' ? params.runId : 'update-run')
  const sourceState = typeof params.sourceState === 'string' ? params.sourceState : git.revision
  const input: TransactionInput = {
    root,
    runId,
    command: 'update',
    mode: strategy,
    scope: request.scope ?? {},
    authorization: { source: params.authorization === 'confirmed-suggestion' ? 'confirmed-suggestion' : 'explicit-invocation', ...(params.dryRun === true ? { dryRun: true } : {}) },
    operations,
    ledger: state.ledger,
    prepareLedger: candidate => ledgerForCandidate(root, candidate, sourceState, advanceBaseline ? git.revision : undefined, state.ledger),
    validate: async (candidate) => {
      const candidateState = await loadKnowledge(candidate)
      return [...candidateState.graph.issues.map(issue => `${issue.code}: ${issue.message}`), ...candidateState.ledgerIssues]
    },
    review: async () => ({ approved: params.reviewApproved !== false }),
  }
  const result = await runTransaction(input)
  const updated = result.status === 'success' ? await loadKnowledge(root) : undefined
  const growth = updated === undefined ? undefined : measureGrowth(updated.graph, updated.ledger)
  let pruneSuggested = false
  if (growth !== undefined) {
    const currentLedger = updated?.ledger
    const suggestionPath = path.join(root, SCRATCH_ROOT, 'reports', 'prune-suggestion.json')
    let previousSuggestion: { baselineFingerprint?: string } = {}
    try {
      previousSuggestion = JSON.parse(await fs.readFile(suggestionPath, 'utf8')) as { baselineFingerprint?: string }
    }
    catch {
      /** Missing state means this baseline has not been surfaced yet. */
    }
    const suggestion = decidePruneSuggestion(growth, currentLedger, previousSuggestion)
    pruneSuggested = suggestion.suggested
    if (suggestion.suggested) {
      await fs.mkdir(path.dirname(suggestionPath), { recursive: true })
      await fs.writeFile(suggestionPath, stableJson(suggestion.state as unknown as JsonObject))
    }
  }
  return {
    status: result.status,
    summary: result.summary,
    data: {
      command: 'update',
      runId,
      strategy,
      ...(escalationReason === undefined ? {} : { escalationReason }),
      delta: deltaToJson(delta),
      repositoryBaselineAdvanced: result.status === 'success' && advanceBaseline,
      ...(growth === undefined ? {} : { pruneSuggested }),
      reachedPhase: result.reachedPhase,
      committed: [...result.committed],
      issues: [...result.issues],
      journal: JSON.parse(stableJson(result.journal as unknown as JsonObject)) as JsonObject,
    },
  }
}
