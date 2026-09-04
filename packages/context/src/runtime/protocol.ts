import type { JsonObject, JsonValue } from './stable-json.js'
import { Buffer } from 'node:buffer'
import { createHash, timingSafeEqual } from 'node:crypto'
import { compactJson, compareCodeUnits, stableJson } from './stable-json.js'

export const PROTOCOL = 'plugydown.context.runtime/v1'

export const READ_CAPABILITIES = [
  'repository.inspect',
  'frontier.query',
  'graph.validate',
  'delta.compute',
  'growth.measure',
  'feedback.match',
] as const

export type ReadCapability = typeof READ_CAPABILITIES[number]
export const TRANSACTION_ACTIONS = ['begin', 'validate', 'commit', 'resume'] as const
export type TransactionAction = typeof TRANSACTION_ACTIONS[number]
export type Capability = ReadCapability | 'transaction'
export type RuntimeStatus = 'success' | 'no_change' | 'dry_run' | 'incomplete' | 'failed'
export type Severity = 'error' | 'warning' | 'info'

export interface Diagnostic {
  readonly code: string
  readonly severity: Severity
  readonly message: string
  readonly path?: string
}

export interface Budget {
  readonly items: number
  readonly bytes: number
  readonly estimatedTokens: number
}

export const DEFAULT_BUDGET: Budget = {
  items: 100,
  bytes: 256 * 1024,
  estimatedTokens: 32_000,
}

export const MAX_BUDGET: Budget = {
  items: 1_000,
  bytes: 1024 * 1024,
  estimatedTokens: 128_000,
}

export type Scope
  = | { readonly kind: 'repository' }
    | { readonly kind: 'domains', readonly ids: readonly string[] }
    | { readonly kind: 'documents', readonly ids: readonly string[] }
    | { readonly kind: 'paths', readonly paths: readonly string[] }

export interface RepositoryInspectInput {
  readonly selectedDocumentIds?: readonly string[]
}

export interface FrontierSelectors {
  readonly domainIds?: readonly string[]
  readonly documentIds?: readonly string[]
  readonly kinds?: readonly string[]
  readonly relation?: { readonly type: 'requires' | 'related', readonly documentId: string }
  readonly codePaths?: readonly string[]
}

export interface FrontierQueryInput {
  readonly depth: 1 | 2 | 3
  readonly selectors?: FrontierSelectors
  readonly requiresClosure?: boolean
}

export interface DeltaComputeInput {
  readonly gitEvidencePath: string
  readonly scope: Scope
  readonly taskEvidence: {
    readonly intentKnown: boolean
    readonly scopeComplete: boolean
    readonly newCapabilitySuspected: boolean
    readonly crossDomainContractUncertain: boolean
  }
}

export interface FeedbackMatchInput {
  readonly context: string
  readonly observedBehavior: string
  readonly outcomeOrCorrection: string
  readonly reuseBoundary: string
}

export type TransactionCommand = 'init' | 'update' | 'prune'
export type TransactionMode = 'light' | 'deep'

export interface TransactionBeginInput {
  readonly command: TransactionCommand
  readonly mode: TransactionMode
  readonly dryRun: boolean
  readonly scope: Scope
  readonly gitEvidencePath: string
  readonly evidencePaths: readonly string[]
}

export interface TransactionValidateInput { readonly runId: string }

export interface TransactionApproval {
  readonly approved: boolean
  readonly candidateFingerprint: string
  readonly sourceEvidenceFingerprint: string
  readonly summary: string
}

export interface TransactionCommitInput {
  readonly runId: string
  readonly approval: TransactionApproval
}

export interface TransactionResumeInput {
  readonly runId: string
  readonly disposition?: 'continue' | 'abandon'
}

export type CapabilityInput
  = | RepositoryInspectInput
    | FrontierQueryInput
    | DeltaComputeInput
    | FeedbackMatchInput
    | TransactionBeginInput
    | TransactionCommitInput
    | TransactionResumeInput
    | TransactionValidateInput
    | Record<string, never>

export interface RuntimeRequest {
  readonly protocol: typeof PROTOCOL
  readonly capability: Capability
  readonly action?: TransactionAction
  readonly input: CapabilityInput
  readonly budget?: Budget
  readonly cursor?: string
}

export interface RuntimeResponse {
  readonly protocol: typeof PROTOCOL
  readonly capability: Capability | 'unknown'
  readonly status: RuntimeStatus
  readonly data?: JsonObject
  readonly cursor?: string
  readonly diagnostics?: readonly Diagnostic[]
}

/** Product-level failure represented inside a legal Runtime response. */
export class RuntimeFault extends Error {
  readonly code: string
  readonly diagnostics: readonly Diagnostic[]

  constructor(code: string, message: string, path?: string) {
    super(message)
    this.name = 'RuntimeFault'
    this.code = code
    this.diagnostics = [{ code, severity: 'error', message, ...(path === undefined ? {} : { path }) }]
  }
}

export function diagnostic(code: string, message: string, severity: Severity = 'error', path?: string): Diagnostic {
  return { code, severity, message, ...(path === undefined ? {} : { path }) }
}

const MAX_DIAGNOSTICS = 100
const MAX_DIAGNOSTIC_MESSAGE = 512
const MAX_DIAGNOSTIC_PATH = 1_024

function cleanDiagnosticText(value: string, maximum: number): string {
  const cleaned = [...value].map((character) => {
    const codePoint = character.codePointAt(0) as number
    return codePoint <= 0x1F || codePoint === 0x7F ? ' ' : character
  }).join('').trim()
  return cleaned.length <= maximum ? cleaned : cleaned.slice(0, maximum)
}

// Mirrors repository.ts's path-safety rule. It is duplicated rather than shared because
// repository imports this module, so importing back would make the graph cyclic; keep the two
// in step, and never let this final wire filter be the weaker of the pair.
const DIAGNOSTIC_PATH_VARIABLE = /\$|%[A-Z_]\w*%/i

function safeDiagnosticPath(value: string): string | undefined {
  const cleaned = cleanDiagnosticText(value, MAX_DIAGNOSTIC_PATH)
  if (cleaned.length === 0 || cleaned.length !== value.length || cleaned.startsWith('/') || cleaned.includes('\\')
    || /^[a-z]:/i.test(cleaned) || DIAGNOSTIC_PATH_VARIABLE.test(cleaned) || cleaned.includes('~')
    || cleaned.split('/').some(part => part.length === 0 || part === '.' || part === '..')) {
    return undefined
  }
  return cleaned
}

function boundedDiagnostic(value: Diagnostic): Diagnostic {
  const path = value.path === undefined ? undefined : safeDiagnosticPath(value.path)
  return {
    code: cleanDiagnosticText(value.code, 128),
    severity: value.severity,
    message: cleanDiagnosticText(value.message, MAX_DIAGNOSTIC_MESSAGE),
    ...(path === undefined ? {} : { path }),
  }
}

export function sortDiagnostics(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  const sorted = diagnostics.map(boundedDiagnostic).sort((left, right) => compareCodeUnits(
    `${left.code}\0${left.path ?? ''}\0${left.message}`,
    `${right.code}\0${right.path ?? ''}\0${right.message}`,
  ))
  if (sorted.length <= MAX_DIAGNOSTICS)
    return sorted
  const omitted = sorted.length - (MAX_DIAGNOSTICS - 1)
  return [
    ...sorted.slice(0, MAX_DIAGNOSTICS - 1),
    diagnostic('DIAGNOSTICS_OMITTED', `${omitted} additional diagnostics were omitted.`, 'warning'),
  ]
}

export function runtimeResponse(
  capability: Capability | 'unknown',
  status: RuntimeStatus,
  options: { readonly data?: JsonObject, readonly cursor?: string, readonly diagnostics?: readonly Diagnostic[] } = {},
): RuntimeResponse {
  const diagnostics = options.diagnostics === undefined ? undefined : sortDiagnostics(options.diagnostics)
  if (capability !== 'transaction') {
    if (status === 'failed' && (options.data !== undefined || options.cursor !== undefined || diagnostics === undefined || diagnostics.length === 0))
      throw new TypeError('A failed read response requires diagnostics and forbids data/cursor.')
    if (status === 'success' && (options.data === undefined || options.cursor !== undefined))
      throw new TypeError('A successful read response requires data and forbids a cursor.')
    if (status === 'incomplete' && (options.data === undefined || options.cursor === undefined))
      throw new TypeError('An incomplete read response requires data and a cursor.')
    if (status === 'no_change' || status === 'dry_run')
      throw new TypeError('Read capabilities do not use transaction-only statuses.')
  }
  return {
    protocol: PROTOCOL,
    capability,
    status,
    ...(options.data === undefined ? {} : { data: options.data }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(diagnostics === undefined || diagnostics.length === 0 ? {} : { diagnostics }),
  }
}

/**
 * The D47 transaction outcome union. Each variant carries exactly the fields its outcome
 * allows, so status/outcome/field combinations are enforced by construction rather than
 * re-validated against a parallel matrix.
 */
export type TransactionOutcome
  = | { readonly outcome: 'staged', readonly runId: string, readonly candidatePath: string }
    | { readonly outcome: 'ready_for_review', readonly runId: string, readonly candidateFingerprint: string, readonly sourceEvidenceFingerprint: string }
    | { readonly outcome: 'committed' | 'candidate_completed', readonly runId: string, readonly contextFingerprint: string, readonly approvedCandidateFingerprint: string, readonly approvedSourceEvidenceFingerprint: string }
    | { readonly outcome: 'abandoned', readonly runId: string }
    | { readonly outcome: 'no_change', readonly runId: string, readonly contextFingerprint: string }
    | { readonly outcome: 'validated', readonly runId: string, readonly candidateFingerprint: string, readonly sourceEvidenceFingerprint: string }
    | { readonly outcome: 'active_run', readonly runId: string }
    | { readonly outcome: 'candidate_edit_required' | 'candidate_stale' | 'approval_mismatch', readonly runId: string }
    | { readonly outcome: 'manual_recovery', readonly runId?: string }
    | { readonly outcome: 'snapshot_stale', readonly runId: string }
    | { readonly outcome: 'backup_restored', readonly runId: string, readonly contextFingerprint: string }
    | { readonly outcome: 'no_trusted_copy', readonly runId: string }
    | { readonly outcome: 'mechanical_failure', readonly runId: string }

const TRANSACTION_SHAPES = {
  staged: { status: 'success', nextAction: 'edit_candidate' },
  ready_for_review: { status: 'success', nextAction: 'semantic_review' },
  committed: { status: 'success' },
  candidate_completed: { status: 'success' },
  abandoned: { status: 'success' },
  no_change: { status: 'no_change' },
  validated: { status: 'dry_run' },
  active_run: { status: 'incomplete', nextAction: 'resume' },
  candidate_edit_required: { status: 'incomplete', nextAction: 'edit_candidate' },
  candidate_stale: { status: 'incomplete', nextAction: 'validate' },
  approval_mismatch: { status: 'incomplete', nextAction: 'semantic_review' },
  manual_recovery: { status: 'incomplete', manualRecoveryRequired: true },
  snapshot_stale: { status: 'failed', nextAction: 'restart_transaction' },
  backup_restored: { status: 'failed' },
  no_trusted_copy: { status: 'failed', manualRecoveryRequired: true },
  mechanical_failure: { status: 'failed' },
} as const satisfies Record<TransactionOutcome['outcome'], { readonly status: RuntimeStatus } & JsonObject>

/** Builds the one legal response for a transaction outcome, deriving status and next action. */
export function transactionResponse(
  result: TransactionOutcome,
  diagnostics?: readonly Diagnostic[],
): RuntimeResponse {
  const { status, ...derived } = TRANSACTION_SHAPES[result.outcome]
  const sorted = diagnostics === undefined ? undefined : sortDiagnostics(diagnostics)
  return {
    protocol: PROTOCOL,
    capability: 'transaction',
    status,
    data: { ...result, ...derived } as JsonObject,
    ...(sorted === undefined || sorted.length === 0 ? {} : { diagnostics: sorted }),
  }
}

export function failureResponse(capability: Capability | 'unknown', error: unknown): RuntimeResponse {
  if (error instanceof RuntimeFault)
    return runtimeResponse(capability, 'failed', { diagnostics: error.diagnostics })
  return runtimeResponse(capability, 'failed', {
    diagnostics: [diagnostic('INTERNAL_ERROR', 'The Runtime encountered an unexpected internal error.')],
  })
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], subject: string): void {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(value).filter(key => !allowedSet.has(key)).sort(compareCodeUnits)
  if (unknown.length > 0)
    throw new RuntimeFault('REQUEST_FIELD_UNKNOWN', `${subject} contains an unknown field.`)
  const missing = required.filter(key => !(key in value))
  if (missing.length > 0)
    throw new RuntimeFault('REQUEST_FIELD_MISSING', `${subject} requires field "${missing[0]}".`)
}

function text(value: unknown, field: string, maximum = 65_536): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum)
    throw new RuntimeFault('REQUEST_FIELD_INVALID', `Request field "${field}" must be a non-empty string within its limit.`)
  return value
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean')
    throw new RuntimeFault('REQUEST_FIELD_INVALID', `Request field "${field}" must be boolean.`)
  return value
}

function uniqueStrings(value: unknown, field: string, options: { readonly nonEmpty?: boolean, readonly maximum?: number } = {}): readonly string[] {
  const maximum = options.maximum ?? 10_000
  if (!Array.isArray(value) || value.length > maximum || (options.nonEmpty === true && value.length === 0))
    throw new RuntimeFault('REQUEST_FIELD_INVALID', `Request field "${field}" must be a bounded string array.`)
  if (value.some(item => typeof item !== 'string' || item.length === 0) || new Set(value).size !== value.length)
    throw new RuntimeFault('REQUEST_FIELD_INVALID', `Request field "${field}" must contain unique non-empty strings.`)
  return value as string[]
}

const DOMAIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DOCUMENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/

function uniqueIds(value: unknown, field: string, pattern: RegExp, kind: 'Domain' | 'Document', nonEmpty = false): readonly string[] {
  const ids = uniqueStrings(value, field, { nonEmpty })
  if (ids.some(id => !pattern.test(id)))
    throw new RuntimeFault('REQUEST_FIELD_INVALID', `Request field "${field}" must contain valid ${kind} IDs.`)
  return ids
}

function emptyInput(value: unknown, capability: string): Record<string, never> {
  if (!isRecord(value))
    throw new RuntimeFault('REQUEST_INPUT_INVALID', `${capability} input must be an object.`)
  assertExactKeys(value, [], [], `${capability} input`)
  return {}
}

function parseInspectInput(value: unknown): RepositoryInspectInput {
  if (!isRecord(value))
    throw new RuntimeFault('REQUEST_INPUT_INVALID', 'repository.inspect input must be an object.')
  assertExactKeys(value, ['selectedDocumentIds'], [], 'repository.inspect input')
  return value.selectedDocumentIds === undefined
    ? {}
    : { selectedDocumentIds: uniqueIds(value.selectedDocumentIds, 'selectedDocumentIds', DOCUMENT_ID, 'Document') }
}

const DOCUMENT_KINDS = ['domain', 'architecture', 'decision', 'guide', 'reference', 'reflection'] as const

function parseSelectors(value: unknown): FrontierSelectors | undefined {
  if (value === undefined)
    return undefined
  if (!isRecord(value))
    throw new RuntimeFault('REQUEST_FIELD_INVALID', 'frontier.query selectors must be an object.')
  assertExactKeys(value, ['domainIds', 'documentIds', 'kinds', 'relation', 'codePaths'], [], 'frontier.query selectors')
  const selectors: { -readonly [K in keyof FrontierSelectors]?: FrontierSelectors[K] } = {}
  if (value.domainIds !== undefined)
    selectors.domainIds = uniqueIds(value.domainIds, 'selectors.domainIds', DOMAIN_ID, 'Domain')
  if (value.documentIds !== undefined)
    selectors.documentIds = uniqueIds(value.documentIds, 'selectors.documentIds', DOCUMENT_ID, 'Document')
  if (value.codePaths !== undefined)
    selectors.codePaths = uniqueStrings(value.codePaths, 'selectors.codePaths')
  if (value.kinds !== undefined) {
    const kinds = uniqueStrings(value.kinds, 'selectors.kinds')
    if (kinds.some(kind => !(DOCUMENT_KINDS as readonly string[]).includes(kind)))
      throw new RuntimeFault('REQUEST_FIELD_INVALID', 'selectors.kinds contains an unknown Document kind.')
    selectors.kinds = kinds
  }
  if (value.relation !== undefined) {
    if (!isRecord(value.relation))
      throw new RuntimeFault('REQUEST_FIELD_INVALID', 'selectors.relation must be an object.')
    assertExactKeys(value.relation, ['type', 'documentId'], ['type', 'documentId'], 'selectors.relation')
    if (value.relation.type !== 'requires' && value.relation.type !== 'related')
      throw new RuntimeFault('REQUEST_FIELD_INVALID', 'selectors.relation.type must be requires or related.')
    selectors.relation = {
      type: value.relation.type,
      documentId: uniqueIds([value.relation.documentId], 'selectors.relation.documentId', DOCUMENT_ID, 'Document', true)[0] as string,
    }
  }
  return selectors
}

function parseFrontierInput(value: unknown): FrontierQueryInput {
  if (!isRecord(value))
    throw new RuntimeFault('REQUEST_INPUT_INVALID', 'frontier.query input must be an object.')
  assertExactKeys(value, ['depth', 'selectors', 'requiresClosure'], ['depth'], 'frontier.query input')
  if (value.depth !== 1 && value.depth !== 2 && value.depth !== 3)
    throw new RuntimeFault('REQUEST_FIELD_INVALID', 'frontier.query depth must be 1, 2, or 3.')
  const selectors = parseSelectors(value.selectors)
  if (value.depth > 1 && (selectors === undefined || Object.keys(selectors).length === 0))
    throw new RuntimeFault('REQUEST_FIELD_INVALID', 'frontier.query depth 2 and 3 require a selector.')
  if (value.depth === 1 && value.requiresClosure !== undefined)
    throw new RuntimeFault('REQUEST_FIELD_INVALID', 'requiresClosure is only valid for depth 2 or 3.')
  return {
    depth: value.depth,
    ...(selectors === undefined ? {} : { selectors }),
    ...(value.requiresClosure === undefined ? {} : { requiresClosure: boolean(value.requiresClosure, 'requiresClosure') }),
  }
}

function parseScope(value: unknown): Scope {
  if (!isRecord(value) || typeof value.kind !== 'string')
    throw new RuntimeFault('REQUEST_FIELD_INVALID', 'scope must be a discriminated object.')
  if (value.kind === 'repository') {
    assertExactKeys(value, ['kind'], ['kind'], 'scope')
    return { kind: 'repository' }
  }
  if (value.kind === 'domains' || value.kind === 'documents') {
    assertExactKeys(value, ['kind', 'ids'], ['kind', 'ids'], 'scope')
    return {
      kind: value.kind,
      ids: uniqueIds(value.ids, 'scope.ids', value.kind === 'domains' ? DOMAIN_ID : DOCUMENT_ID, value.kind === 'domains' ? 'Domain' : 'Document', true),
    }
  }
  if (value.kind === 'paths') {
    assertExactKeys(value, ['kind', 'paths'], ['kind', 'paths'], 'scope')
    return { kind: 'paths', paths: uniqueStrings(value.paths, 'scope.paths', { nonEmpty: true }) }
  }
  throw new RuntimeFault('REQUEST_FIELD_INVALID', 'scope.kind is unknown.')
}

function parseDeltaInput(value: unknown): DeltaComputeInput {
  if (!isRecord(value))
    throw new RuntimeFault('REQUEST_INPUT_INVALID', 'delta.compute input must be an object.')
  assertExactKeys(value, ['gitEvidencePath', 'scope', 'taskEvidence'], ['gitEvidencePath', 'scope', 'taskEvidence'], 'delta.compute input')
  if (!isRecord(value.taskEvidence))
    throw new RuntimeFault('REQUEST_FIELD_INVALID', 'taskEvidence must be an object.')
  assertExactKeys(
    value.taskEvidence,
    ['intentKnown', 'scopeComplete', 'newCapabilitySuspected', 'crossDomainContractUncertain'],
    ['intentKnown', 'scopeComplete', 'newCapabilitySuspected', 'crossDomainContractUncertain'],
    'taskEvidence',
  )
  return {
    gitEvidencePath: text(value.gitEvidencePath, 'gitEvidencePath', 1_024),
    scope: parseScope(value.scope),
    taskEvidence: {
      intentKnown: boolean(value.taskEvidence.intentKnown, 'taskEvidence.intentKnown'),
      scopeComplete: boolean(value.taskEvidence.scopeComplete, 'taskEvidence.scopeComplete'),
      newCapabilitySuspected: boolean(value.taskEvidence.newCapabilitySuspected, 'taskEvidence.newCapabilitySuspected'),
      crossDomainContractUncertain: boolean(value.taskEvidence.crossDomainContractUncertain, 'taskEvidence.crossDomainContractUncertain'),
    },
  }
}

function parseFeedbackInput(value: unknown): FeedbackMatchInput {
  if (!isRecord(value))
    throw new RuntimeFault('REQUEST_INPUT_INVALID', 'feedback.match input must be an object.')
  const fields = ['context', 'observedBehavior', 'outcomeOrCorrection', 'reuseBoundary'] as const
  assertExactKeys(value, fields, fields, 'feedback.match input')
  return {
    context: text(value.context, 'context'),
    observedBehavior: text(value.observedBehavior, 'observedBehavior'),
    outcomeOrCorrection: text(value.outcomeOrCorrection, 'outcomeOrCorrection'),
    reuseBoundary: text(value.reuseBoundary, 'reuseBoundary'),
  }
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const FINGERPRINT = /^[a-f0-9]{64}$/

function parseRunId(value: unknown): string {
  const runId = text(value, 'runId', 64)
  if (!UUID.test(runId))
    throw new RuntimeFault('RUN_ID_INVALID', 'runId must be a Runtime-generated UUID.')
  return runId
}

function parseTransactionInput(action: TransactionAction, value: unknown): TransactionBeginInput | TransactionCommitInput | TransactionResumeInput | TransactionValidateInput {
  if (!isRecord(value))
    throw new RuntimeFault('REQUEST_INPUT_INVALID', `transaction.${action} input must be an object.`)
  if (action === 'begin') {
    const fields = ['command', 'mode', 'dryRun', 'scope', 'gitEvidencePath', 'evidencePaths'] as const
    assertExactKeys(value, fields, fields, 'transaction.begin input')
    if (value.command !== 'init' && value.command !== 'update' && value.command !== 'prune')
      throw new RuntimeFault('REQUEST_FIELD_INVALID', 'transaction.begin command is unknown.')
    if (value.mode !== 'light' && value.mode !== 'deep')
      throw new RuntimeFault('REQUEST_FIELD_INVALID', 'transaction.begin mode must be light or deep.')
    return {
      command: value.command,
      mode: value.mode,
      dryRun: boolean(value.dryRun, 'dryRun'),
      scope: parseScope(value.scope),
      gitEvidencePath: text(value.gitEvidencePath, 'gitEvidencePath', 1_024),
      evidencePaths: uniqueStrings(value.evidencePaths, 'evidencePaths', { nonEmpty: true }),
    }
  }
  if (action === 'validate') {
    assertExactKeys(value, ['runId'], ['runId'], `transaction.${action} input`)
    return { runId: parseRunId(value.runId) }
  }
  if (action === 'resume') {
    assertExactKeys(value, ['runId', 'disposition'], ['runId'], 'transaction.resume input')
    if (value.disposition !== undefined && value.disposition !== 'continue' && value.disposition !== 'abandon')
      throw new RuntimeFault('REQUEST_FIELD_INVALID', 'transaction.resume disposition must be continue or abandon.')
    return {
      runId: parseRunId(value.runId),
      ...(value.disposition === undefined ? {} : { disposition: value.disposition }),
    }
  }
  assertExactKeys(value, ['runId', 'approval'], ['runId', 'approval'], 'transaction.commit input')
  if (!isRecord(value.approval))
    throw new RuntimeFault('REQUEST_FIELD_INVALID', 'transaction.commit approval must be an object.')
  const fields = ['approved', 'candidateFingerprint', 'sourceEvidenceFingerprint', 'summary'] as const
  assertExactKeys(value.approval, fields, fields, 'transaction.commit approval')
  if (typeof value.approval.candidateFingerprint !== 'string' || !FINGERPRINT.test(value.approval.candidateFingerprint)
    || typeof value.approval.sourceEvidenceFingerprint !== 'string' || !FINGERPRINT.test(value.approval.sourceEvidenceFingerprint)) {
    throw new RuntimeFault('APPROVAL_INVALID', 'Approval fingerprints must be lowercase SHA-256 values.')
  }
  if (boolean(value.approval.approved, 'approval.approved') !== true)
    throw new RuntimeFault('APPROVAL_INVALID', 'Approval must explicitly be true.')
  return {
    runId: parseRunId(value.runId),
    approval: {
      approved: true,
      candidateFingerprint: value.approval.candidateFingerprint,
      sourceEvidenceFingerprint: value.approval.sourceEvidenceFingerprint,
      summary: text(value.approval.summary, 'approval.summary', 2_048),
    },
  }
}

function parseBudget(value: unknown): Budget | undefined {
  if (value === undefined)
    return undefined
  if (!isRecord(value))
    throw new RuntimeFault('BUDGET_INVALID', 'budget must be an object.')
  assertExactKeys(value, ['items', 'bytes', 'estimatedTokens'], [], 'budget')
  const result: { -readonly [K in keyof Budget]: number } = { ...DEFAULT_BUDGET }
  for (const field of ['items', 'bytes', 'estimatedTokens'] as const) {
    const candidate = value[field]
    if (candidate === undefined)
      continue
    if (!Number.isInteger(candidate) || (candidate as number) < 1 || (candidate as number) > MAX_BUDGET[field])
      throw new RuntimeFault('BUDGET_INVALID', `budget.${field} must be a positive integer no greater than ${MAX_BUDGET[field]}.`)
    result[field] = candidate as number
  }
  return result
}

const PAGED = new Set<Capability>(['repository.inspect', 'frontier.query', 'delta.compute', 'growth.measure', 'feedback.match'])

export function parseRequest(raw: unknown): RuntimeRequest {
  if (!isRecord(raw))
    throw new RuntimeFault('REQUEST_INVALID', 'A Runtime request must be an object.')
  assertExactKeys(raw, ['protocol', 'capability', 'action', 'input', 'budget', 'cursor'], ['protocol', 'capability', 'input'], 'request')
  if (raw.protocol !== PROTOCOL)
    throw new RuntimeFault('PROTOCOL_UNSUPPORTED', `The request protocol must be ${PROTOCOL}.`)
  if (typeof raw.capability !== 'string' || (!(READ_CAPABILITIES as readonly string[]).includes(raw.capability) && raw.capability !== 'transaction'))
    throw new RuntimeFault('CAPABILITY_UNKNOWN', 'The request capability is unknown.')
  const capability = raw.capability as Capability
  if (capability === 'transaction' && (typeof raw.action !== 'string' || !(TRANSACTION_ACTIONS as readonly string[]).includes(raw.action)))
    throw new RuntimeFault('ACTION_UNKNOWN', 'transaction requests require a known action.')
  if (capability !== 'transaction' && raw.action !== undefined)
    throw new RuntimeFault('REQUEST_FIELD_INVALID', 'action is only valid for transaction requests.')
  if (!PAGED.has(capability) && (raw.budget !== undefined || raw.cursor !== undefined))
    throw new RuntimeFault('REQUEST_FIELD_INVALID', `${capability} does not accept budget or cursor.`)
  if (raw.cursor !== undefined && (typeof raw.cursor !== 'string' || raw.cursor.length === 0 || raw.cursor.length > 4_096))
    throw new RuntimeFault('CURSOR_INVALID', 'cursor must be a bounded non-empty string.')

  let input: CapabilityInput
  switch (capability) {
    case 'repository.inspect':
      input = parseInspectInput(raw.input)
      break
    case 'frontier.query':
      input = parseFrontierInput(raw.input)
      break
    case 'graph.validate':
      input = emptyInput(raw.input, capability)
      break
    case 'delta.compute':
      input = parseDeltaInput(raw.input)
      break
    case 'growth.measure':
      input = emptyInput(raw.input, capability)
      break
    case 'feedback.match':
      input = parseFeedbackInput(raw.input)
      break
    case 'transaction':
      input = parseTransactionInput(raw.action as TransactionAction, raw.input)
      break
  }
  return {
    protocol: PROTOCOL,
    capability,
    ...(capability === 'transaction' ? { action: raw.action as TransactionAction } : {}),
    input,
    ...(raw.budget === undefined ? {} : { budget: parseBudget(raw.budget) as Budget }),
    ...(raw.cursor === undefined ? {} : { cursor: raw.cursor }),
  }
}

export function requestCapability(raw: unknown): Capability | 'unknown' {
  if (!isRecord(raw) || typeof raw.capability !== 'string')
    return 'unknown'
  return (READ_CAPABILITIES as readonly string[]).includes(raw.capability) || raw.capability === 'transaction' ? raw.capability as Capability : 'unknown'
}

export function resolvedBudget(request: RuntimeRequest): Budget {
  return request.budget ?? DEFAULT_BUDGET
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export interface CursorPosition extends JsonObject {
  itemOffset: number
  bodyByteOffset?: number
}

interface CursorCore extends JsonObject {
  protocolVersion: string
  capability: string
  inputFingerprint: string
  contextFingerprint: string
  stateFingerprint: string
  itemOffset: number
  bodyByteOffset?: number
}

interface CursorPayload extends CursorCore {
  integrityHash: string
}

function cursorCore(
  capability: Capability,
  input: CapabilityInput,
  contextFingerprint: string,
  stateFingerprint: string,
  position: CursorPosition,
): CursorCore {
  return {
    protocolVersion: PROTOCOL,
    capability,
    inputFingerprint: sha256(compactJson(input as JsonValue)),
    contextFingerprint,
    stateFingerprint,
    itemOffset: position.itemOffset,
    ...(position.bodyByteOffset === undefined ? {} : { bodyByteOffset: position.bodyByteOffset }),
  }
}

export function encodeCursor(
  capability: Capability,
  input: CapabilityInput,
  contextFingerprint: string,
  stateFingerprint: string,
  position: CursorPosition,
): string {
  const core = cursorCore(capability, input, contextFingerprint, stateFingerprint, position)
  const payload: CursorPayload = { ...core, integrityHash: sha256(compactJson(core as JsonValue)) }
  return Buffer.from(compactJson(payload), 'utf8').toString('base64url')
}

export function decodeCursor(
  cursor: string | undefined,
  capability: Capability,
  input: CapabilityInput,
  contextFingerprint: string,
  stateFingerprint: string,
): CursorPosition {
  if (cursor === undefined)
    return { itemOffset: 0 }
  if (!/^[\w-]+$/.test(cursor))
    throw new RuntimeFault('CURSOR_INVALID', 'The continuation cursor is malformed or has been tampered with.')
  let parsed: unknown
  try {
    const bytes = Buffer.from(cursor, 'base64url')
    if (bytes.toString('base64url') !== cursor)
      throw new Error('non-canonical base64url')
    parsed = JSON.parse(bytes.toString('utf8'))
  }
  catch {
    throw new RuntimeFault('CURSOR_INVALID', 'The continuation cursor is malformed or has been tampered with.')
  }
  if (!isRecord(parsed))
    throw new RuntimeFault('CURSOR_INVALID', 'The continuation cursor is malformed or has been tampered with.')
  const keys = Object.keys(parsed).sort(compareCodeUnits)
  const expectedKeys = [
    'capability',
    'contextFingerprint',
    'inputFingerprint',
    'integrityHash',
    'itemOffset',
    'protocolVersion',
    'stateFingerprint',
    ...(parsed.bodyByteOffset === undefined ? [] : ['bodyByteOffset']),
  ].sort(compareCodeUnits)
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)
    || typeof parsed.integrityHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(parsed.integrityHash)
    || !Number.isSafeInteger(parsed.itemOffset)
    || (parsed.itemOffset as number) < 0
    || (parsed.bodyByteOffset !== undefined
      && (!Number.isSafeInteger(parsed.bodyByteOffset) || (parsed.bodyByteOffset as number) < 0))) {
    throw new RuntimeFault('CURSOR_INVALID', 'The continuation cursor is malformed or has been tampered with.')
  }
  const position: CursorPosition = {
    itemOffset: parsed.itemOffset as number,
    ...(parsed.bodyByteOffset === undefined ? {} : { bodyByteOffset: parsed.bodyByteOffset as number }),
  }
  const core = cursorCore(capability, input, contextFingerprint, stateFingerprint, position)
  const expected = Buffer.from(sha256(compactJson(core as JsonValue)), 'hex')
  const actual = Buffer.from(parsed.integrityHash, 'hex')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new RuntimeFault('CURSOR_STALE', 'The continuation cursor does not match this query or Context tree.')
  if (parsed.protocolVersion !== core.protocolVersion
    || parsed.capability !== core.capability
    || parsed.inputFingerprint !== core.inputFingerprint
    || parsed.contextFingerprint !== core.contextFingerprint
    || parsed.stateFingerprint !== core.stateFingerprint) {
    throw new RuntimeFault('CURSOR_STALE', 'The continuation cursor does not match this query or Context tree.')
  }
  return position
}

export function estimateTokens(value: JsonValue): number {
  return Math.ceil(Buffer.byteLength(compactJson(value), 'utf8') / 3)
}

export interface Page<T extends JsonValue> {
  readonly items: readonly T[]
  readonly nextPosition?: CursorPosition
}

export interface PaginationEnvelope<T extends JsonValue> {
  readonly response: (items: readonly T[], cursor?: string) => RuntimeResponse
  readonly cursor: (position: CursorPosition) => string
}

export function responseFits(response: RuntimeResponse, budget: Budget): boolean {
  const value = response as unknown as JsonValue
  return Buffer.byteLength(stableJson(value), 'utf8') <= budget.bytes
    && estimateTokens(value) <= budget.estimatedTokens
}

/** Applies all public output limits to the exact serialized response without silently truncating a list. */
export function paginate<T extends JsonValue>(
  items: readonly T[],
  position: CursorPosition,
  budget: Budget,
  envelope: PaginationEnvelope<T>,
): Page<T> {
  if (position.bodyByteOffset !== undefined)
    throw new RuntimeFault('CURSOR_INVALID', 'The continuation cursor points inside a body where only whole items are valid.')
  if (position.itemOffset > items.length)
    throw new RuntimeFault('CURSOR_INVALID', 'The continuation cursor points beyond the current result stream.')
  const selected: T[] = []
  let index = Math.min(position.itemOffset, items.length)
  for (; index < items.length; index += 1) {
    const item = items[index] as T
    if (selected.length >= budget.items)
      break
    const candidate = [...selected, item]
    const nextPosition = index + 1 < items.length ? { itemOffset: index + 1 } : undefined
    const cursor = nextPosition === undefined ? undefined : envelope.cursor(nextPosition)
    if (!responseFits(envelope.response(candidate, cursor), budget)) {
      if (selected.length === 0) {
        if (!responseFits(envelope.response([item], cursor), MAX_BUDGET))
          throw new RuntimeFault('RESULT_ITEM_TOO_LARGE', 'A single result item exceeds the Runtime output hard limits.')
        throw new RuntimeFault('BUDGET_TOO_SMALL', 'The requested output budget cannot contain the next complete result item.')
      }
      break
    }
    selected.push(item)
  }
  const page: Page<T> = { items: selected, ...(index < items.length ? { nextPosition: { itemOffset: index } } : {}) }
  const cursor = page.nextPosition === undefined ? undefined : envelope.cursor(page.nextPosition)
  if (!responseFits(envelope.response(page.items, cursor), budget))
    throw new RuntimeFault('BUDGET_TOO_SMALL', 'The requested output budget cannot contain the required response envelope.')
  return page
}

export interface BodyChunk extends JsonObject {
  text: string
  startByte: number
  endByte: number
  totalBytes: number
  complete: boolean
}

/** Selects the largest UTF-8 code-point-aligned chunk that fits the exact response envelope. */
export function fitBodyChunk(
  body: string,
  startByte: number,
  budget: Budget,
  response: (chunk: BodyChunk, cursor?: string) => RuntimeResponse,
  cursor: (endByte: number) => string | undefined,
): BodyChunk {
  const boundaries = [0]
  let byteOffset = 0
  for (const codePoint of body) {
    byteOffset += Buffer.byteLength(codePoint, 'utf8')
    boundaries.push(byteOffset)
  }
  const startIndex = boundaries.indexOf(startByte)
  if (startIndex < 0 || startIndex === boundaries.length - 1)
    throw new RuntimeFault('CURSOR_INVALID', 'The continuation cursor does not point to a valid UTF-8 body boundary.')

  const makeChunk = (endIndex: number): BodyChunk => {
    const endByte = boundaries[endIndex] as number
    const complete = endByte === byteOffset
    return {
      text: Buffer.from(body, 'utf8').subarray(startByte, endByte).toString('utf8'),
      startByte,
      endByte,
      totalBytes: byteOffset,
      complete,
    }
  }
  const fitsAt = (endIndex: number, limit: Budget): boolean => {
    const chunk = makeChunk(endIndex)
    return responseFits(response(chunk, cursor(chunk.endByte)), limit)
  }
  if (!fitsAt(startIndex + 1, MAX_BUDGET))
    throw new RuntimeFault('RESULT_ITEM_TOO_LARGE', 'A body code point and its result envelope exceed the Runtime output hard limits.')
  if (!fitsAt(startIndex + 1, budget))
    throw new RuntimeFault('BUDGET_TOO_SMALL', 'The requested output budget cannot contain a progressing body chunk.')

  let low = startIndex + 1
  let high = boundaries.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fitsAt(middle, budget))
      low = middle
    else
      high = middle - 1
  }
  return makeChunk(low)
}
