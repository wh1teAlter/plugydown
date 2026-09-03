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

export interface TransactionResumeInput { readonly runId: string }

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
  readonly diagnostics: readonly Diagnostic[]

  constructor(code: string, message: string, path?: string) {
    super(message)
    this.name = 'RuntimeFault'
    this.diagnostics = [{ code, severity: 'error', message, ...(path === undefined ? {} : { path }) }]
  }
}

export function diagnostic(code: string, message: string, severity: Severity = 'error', path?: string): Diagnostic {
  return { code, severity, message, ...(path === undefined ? {} : { path }) }
}

export function sortDiagnostics(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  return [...diagnostics].sort((left, right) => compareCodeUnits(
    `${left.code}\0${left.path ?? ''}\0${left.message}`,
    `${right.code}\0${right.path ?? ''}\0${right.message}`,
  ))
}

export function runtimeResponse(
  capability: Capability | 'unknown',
  status: RuntimeStatus,
  options: { readonly data?: JsonObject, readonly cursor?: string, readonly diagnostics?: readonly Diagnostic[] } = {},
): RuntimeResponse {
  const diagnostics = options.diagnostics === undefined ? undefined : sortDiagnostics(options.diagnostics)
  return {
    protocol: PROTOCOL,
    capability,
    status,
    ...(options.data === undefined ? {} : { data: options.data }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(diagnostics === undefined || diagnostics.length === 0 ? {} : { diagnostics }),
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
  if (action === 'validate' || action === 'resume') {
    assertExactKeys(value, ['runId'], ['runId'], `transaction.${action} input`)
    return { runId: parseRunId(value.runId) }
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

interface CursorCore extends JsonObject {
  protocolVersion: string
  capability: string
  inputFingerprint: string
  contextFingerprint: string
  offset: number
}

interface CursorPayload extends CursorCore {
  integrityHash: string
}

function cursorCore(capability: Capability, input: CapabilityInput, contextFingerprint: string, offset: number): CursorCore {
  return {
    protocolVersion: PROTOCOL,
    capability,
    inputFingerprint: sha256(compactJson(input as JsonValue)),
    contextFingerprint,
    offset,
  }
}

export function encodeCursor(capability: Capability, input: CapabilityInput, contextFingerprint: string, offset: number): string {
  const core = cursorCore(capability, input, contextFingerprint, offset)
  const payload: CursorPayload = { ...core, integrityHash: sha256(compactJson(core as JsonValue)) }
  return Buffer.from(compactJson(payload), 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string | undefined, capability: Capability, input: CapabilityInput, contextFingerprint: string): number {
  if (cursor === undefined)
    return 0
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  }
  catch {
    throw new RuntimeFault('CURSOR_INVALID', 'The continuation cursor is malformed or has been tampered with.')
  }
  if (!isRecord(parsed))
    throw new RuntimeFault('CURSOR_INVALID', 'The continuation cursor is malformed or has been tampered with.')
  const keys = Object.keys(parsed).sort(compareCodeUnits)
  const expectedKeys = ['capability', 'contextFingerprint', 'inputFingerprint', 'integrityHash', 'offset', 'protocolVersion'].sort(compareCodeUnits)
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)
    || typeof parsed.integrityHash !== 'string'
    || !Number.isSafeInteger(parsed.offset)
    || (parsed.offset as number) < 0) {
    throw new RuntimeFault('CURSOR_INVALID', 'The continuation cursor is malformed or has been tampered with.')
  }
  const core = cursorCore(capability, input, contextFingerprint, parsed.offset as number)
  const expected = Buffer.from(sha256(compactJson(core as JsonValue)), 'hex')
  let actual: Buffer
  try {
    actual = Buffer.from(parsed.integrityHash, 'hex')
  }
  catch {
    throw new RuntimeFault('CURSOR_INVALID', 'The continuation cursor is malformed or has been tampered with.')
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new RuntimeFault('CURSOR_STALE', 'The continuation cursor does not match this query or Context tree.')
  if (parsed.protocolVersion !== core.protocolVersion
    || parsed.capability !== core.capability
    || parsed.inputFingerprint !== core.inputFingerprint
    || parsed.contextFingerprint !== core.contextFingerprint) {
    throw new RuntimeFault('CURSOR_STALE', 'The continuation cursor does not match this query or Context tree.')
  }
  return parsed.offset as number
}

export function estimateTokens(value: JsonValue): number {
  return Math.ceil(Buffer.byteLength(compactJson(value), 'utf8') / 3)
}

export interface Page<T extends JsonValue> {
  readonly items: readonly T[]
  readonly nextOffset?: number
}

export interface PaginationEnvelope<T extends JsonValue> {
  readonly response: (items: readonly T[], cursor?: string) => RuntimeResponse
  readonly cursor: (offset: number) => string
}

function responseFits(response: RuntimeResponse, budget: Budget): boolean {
  const value = response as unknown as JsonValue
  return Buffer.byteLength(stableJson(value), 'utf8') <= budget.bytes
    && estimateTokens(value) <= budget.estimatedTokens
}

/** Applies all public output limits to the exact serialized response without silently truncating a list. */
export function paginate<T extends JsonValue>(
  items: readonly T[],
  offset: number,
  budget: Budget,
  envelope: PaginationEnvelope<T>,
): Page<T> {
  const selected: T[] = []
  let index = Math.min(offset, items.length)
  for (; index < items.length; index += 1) {
    const item = items[index] as T
    if (selected.length >= budget.items)
      break
    const candidate = [...selected, item]
    const nextOffset = index + 1 < items.length ? index + 1 : undefined
    const cursor = nextOffset === undefined ? undefined : envelope.cursor(nextOffset)
    if (!responseFits(envelope.response(candidate, cursor), budget)) {
      if (selected.length === 0 && !responseFits(envelope.response([item], cursor), MAX_BUDGET))
        throw new RuntimeFault('RESULT_ITEM_TOO_LARGE', 'A single result item exceeds the Runtime output hard limits.')
      break
    }
    selected.push(item)
  }
  const page: Page<T> = { items: selected, ...(index < items.length ? { nextOffset: index } : {}) }
  const cursor = page.nextOffset === undefined ? undefined : envelope.cursor(page.nextOffset)
  if (!responseFits(envelope.response(page.items, cursor), budget))
    throw new RuntimeFault('BUDGET_TOO_SMALL', 'The requested output budget cannot contain the required response envelope.')
  return page
}
