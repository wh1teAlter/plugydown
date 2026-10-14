import type { ContextDocument, ConvergenceBaseline, DocumentLedger, Meta } from './document.js'
import type { KnowledgeGraph } from './graph.js'
import type { Diagnostic, RuntimeRequest, RuntimeResponse, Scope, TransactionApproval, TransactionBeginInput, TransactionCommand, TransactionCommitInput, TransactionMode, TransactionResumeInput, TransactionValidateInput } from './protocol.js'
import type { GitEvidence, SourceExpansionResult, SourceFile } from './repository.js'
import type { JsonValue } from './stable-json.js'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { bodyFingerprint, FINGERPRINT_VERSION, frontMatterFingerprint, serializeMeta, sourceFingerprint, TOOL_VERSION } from './document.js'
import { graphMetrics, loadKnowledge } from './graph.js'
import { diagnostic, isRecord, PROTOCOL, RuntimeFault, transactionResponse } from './protocol.js'
import { aggregateSourceFingerprint, assertGitEvidencePath, assertSourcePattern, CONTEXT_ROOT, declarationMatches, expandSourcePatternSets, filesystemOperation, fingerprintTree, LOCK_ROOT, LOCK_SCHEMA, lstatRepositoryPath, MAX_JSON_TEXT_BYTES, readGitEvidence, readLockOwner, readUtf8File, resolveRepositoryPath, resolveRepositoryRoot, RUNS_ROOT, SCRATCH_ROOT, throwFilesystemFault } from './repository.js'
import { compareCodeUnits, stableJson } from './stable-json.js'

const TRANSACTION_SCHEMA = 'plugydown.context.transaction/v1'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const HASH = /^[a-f0-9]{64}$/
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const DOMAIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DOCUMENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/

export type TransactionPhase
  = | 'staged'
    | 'validated'
    | 'committing'
    | 'committed'
    | 'restored'
    | 'recovery_required'
    | 'failed'

/** Facts every run carries, independent of how far it has progressed. */
interface ManifestBase {
  readonly schema: typeof TRANSACTION_SCHEMA
  readonly runId: string
  readonly command: TransactionCommand
  readonly mode: TransactionMode
  readonly dryRun: boolean
  readonly scope: Scope
  readonly gitEvidencePath: string
  readonly evidencePaths: readonly string[]
  readonly reaffirmedDocumentIds?: readonly string[]
  readonly snapshot: {
    readonly contextState: 'absent' | 'present'
    readonly contextFingerprint?: string
    readonly declaredEvidenceFingerprint: string
    readonly gitEvidenceFingerprint: string
    readonly gitRevision: string
  }
}

/** Fingerprints that exist only once a candidate has been validated. */
interface ValidatedPair {
  readonly candidateFingerprint: string
  readonly sourceEvidenceFingerprint: string
}

/**
 * The manifest is discriminated by phase, so which of the candidate/source fingerprints,
 * approval and recovery facts may appear is enforced by the type system instead of a
 * post-hoc combination matrix. The on-disk field set is unchanged.
 */
type TransactionManifest
  = | ManifestBase & { readonly phase: 'staged' }
    | ManifestBase & ValidatedPair & { readonly phase: 'validated' }
    | ManifestBase & ValidatedPair & {
      readonly phase: 'committing'
      readonly approval: TransactionApproval
      readonly recovery?: { readonly intent: 'restore_backup' }
    }
    | ManifestBase & ValidatedPair & {
      readonly phase: 'committed'
      readonly approval: TransactionApproval
      readonly recovery?: { readonly outcome: 'candidate_completed' }
    }
    | ManifestBase & ValidatedPair & {
      readonly phase: 'restored'
      readonly approval: TransactionApproval
      readonly recovery: { readonly outcome: 'backup_restored' }
    }
    | ManifestBase & ValidatedPair & {
      readonly phase: 'recovery_required'
      readonly approval: TransactionApproval
      readonly recovery: { readonly outcome: 'manual_recovery' }
    }
    | ManifestBase & ValidatedPair & {
      readonly phase: 'failed'
      readonly approval: TransactionApproval
      readonly recovery: { readonly outcome: 'no_trusted_copy' }
    }

type RecoveryOutcome = 'candidate_completed' | 'backup_restored' | 'manual_recovery' | 'no_trusted_copy'

/** A run that has been validated, so both fingerprints are known. */
type ValidatedManifest = Extract<TransactionManifest, ValidatedPair>

/** A run that carries semantic approval, so it can complete, restore or need recovery. */
type ApprovedManifest = Extract<TransactionManifest, { approval: TransactionApproval }>

function hasRestoreIntent(manifest: TransactionManifest): boolean {
  return manifest.phase === 'committing' && manifest.recovery !== undefined
}

function validatedPair(manifest: ValidatedManifest): ValidatedPair {
  return {
    candidateFingerprint: manifest.candidateFingerprint,
    sourceEvidenceFingerprint: manifest.sourceEvidenceFingerprint,
  }
}

/** Strips phase-specific review and recovery facts back to the invariant run facts. */
function baseFacts(manifest: TransactionManifest): ManifestBase {
  return {
    schema: manifest.schema,
    runId: manifest.runId,
    command: manifest.command,
    mode: manifest.mode,
    dryRun: manifest.dryRun,
    scope: manifest.scope,
    gitEvidencePath: manifest.gitEvidencePath,
    evidencePaths: manifest.evidencePaths,
    snapshot: manifest.snapshot,
  }
}

type TreeFact
  = | { readonly state: 'absent' }
    | { readonly state: 'valid', readonly fingerprint: string }
    | { readonly state: 'invalid' }

type LockFact
  = | { readonly state: 'absent' }
    | { readonly state: 'valid', readonly runId: string }
    | { readonly state: 'corrupt' }
    | { readonly state: 'orphan', readonly runId?: string }

function runPath(runId: string): string {
  return `${RUNS_ROOT}/${runId}`
}

function manifestPath(runId: string): string {
  return `${runPath(runId)}/manifest.json`
}

function candidatePath(runId: string): string {
  return `${runPath(runId)}/candidate/context`
}

function backupPath(runId: string): string {
  return `${runPath(runId)}/backup/context`
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const expected = new Set([...required, ...optional])
  return required.every(key => key in value) && Object.keys(value).every(key => expected.has(key))
}

function validScope(value: unknown): value is Scope {
  if (!isRecord(value) || typeof value.kind !== 'string')
    return false
  if (value.kind === 'repository')
    return exactKeys(value, ['kind'])
  if (value.kind === 'domains' || value.kind === 'documents') {
    const pattern = value.kind === 'domains' ? DOMAIN_ID : DOCUMENT_ID
    return exactKeys(value, ['kind', 'ids']) && Array.isArray(value.ids) && value.ids.length > 0
      && value.ids.every(item => typeof item === 'string' && pattern.test(item))
      && new Set(value.ids).size === value.ids.length
  }
  if (value.kind !== 'paths' || !exactKeys(value, ['kind', 'paths']) || !Array.isArray(value.paths)
    || value.paths.length === 0 || value.paths.some(item => typeof item !== 'string')
    || new Set(value.paths).size !== value.paths.length) {
    return false
  }
  try {
    ;(value.paths as string[]).forEach(assertSourcePattern)
    return true
  }
  catch {
    return false
  }
}

function parseApproval(value: unknown): TransactionApproval | undefined {
  if (!isRecord(value) || !exactKeys(value, ['approved', 'candidateFingerprint', 'sourceEvidenceFingerprint', 'summary'])
    || value.approved !== true
    || typeof value.candidateFingerprint !== 'string' || !HASH.test(value.candidateFingerprint)
    || typeof value.sourceEvidenceFingerprint !== 'string' || !HASH.test(value.sourceEvidenceFingerprint)
    || typeof value.summary !== 'string' || value.summary.trim().length === 0 || value.summary.length > 2_048) {
    return undefined
  }
  return {
    approved: value.approved,
    candidateFingerprint: value.candidateFingerprint,
    sourceEvidenceFingerprint: value.sourceEvidenceFingerprint,
    summary: value.summary,
  }
}

function inconsistent(): never {
  throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'The transaction manifest phase facts are inconsistent.')
}

function parseRecovery(value: unknown): { readonly intent: 'restore_backup' } | { readonly outcome: RecoveryOutcome } | undefined {
  if (value === undefined)
    return undefined
  if (!isRecord(value))
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'The transaction recovery fact is invalid.')
  if (exactKeys(value, ['intent']) && value.intent === 'restore_backup')
    return { intent: 'restore_backup' }
  if (exactKeys(value, ['outcome'])
    && ['candidate_completed', 'backup_restored', 'manual_recovery', 'no_trusted_copy'].includes(String(value.outcome))) {
    return { outcome: value.outcome as RecoveryOutcome }
  }
  throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'The transaction recovery fact is invalid.')
}

function parseManifest(value: unknown): TransactionManifest {
  if (!isRecord(value) || !exactKeys(
    value,
    ['schema', 'runId', 'command', 'mode', 'dryRun', 'scope', 'phase', 'gitEvidencePath', 'evidencePaths', 'snapshot'],
    ['reaffirmedDocumentIds', 'candidateFingerprint', 'sourceEvidenceFingerprint', 'approval', 'recovery'],
  )
  || value.schema !== TRANSACTION_SCHEMA
  || typeof value.runId !== 'string' || !UUID.test(value.runId)
  || (value.command !== 'init' && value.command !== 'update' && value.command !== 'prune')
  || (value.mode !== 'light' && value.mode !== 'deep')
  || typeof value.dryRun !== 'boolean'
  || !validScope(value.scope)
  || !['staged', 'validated', 'committing', 'committed', 'restored', 'recovery_required', 'failed'].includes(String(value.phase))
  || typeof value.gitEvidencePath !== 'string'
  || !Array.isArray(value.evidencePaths) || value.evidencePaths.length === 0 || value.evidencePaths.some(item => typeof item !== 'string')
  || (value.reaffirmedDocumentIds !== undefined && (!Array.isArray(value.reaffirmedDocumentIds)
    || value.reaffirmedDocumentIds.length === 0
    || value.reaffirmedDocumentIds.some(item => typeof item !== 'string' || !DOCUMENT_ID.test(item))
    || new Set(value.reaffirmedDocumentIds as string[]).size !== value.reaffirmedDocumentIds.length))
  || !isRecord(value.snapshot)
  || !exactKeys(value.snapshot, ['contextState', 'declaredEvidenceFingerprint', 'gitEvidenceFingerprint', 'gitRevision'], ['contextFingerprint'])
  || (value.snapshot.contextState !== 'absent' && value.snapshot.contextState !== 'present')
  || typeof value.snapshot.declaredEvidenceFingerprint !== 'string' || !HASH.test(value.snapshot.declaredEvidenceFingerprint)
  || typeof value.snapshot.gitEvidenceFingerprint !== 'string' || !HASH.test(value.snapshot.gitEvidenceFingerprint)
  || typeof value.snapshot.gitRevision !== 'string' || !GIT_REVISION.test(value.snapshot.gitRevision)
  || (value.snapshot.contextFingerprint !== undefined && (typeof value.snapshot.contextFingerprint !== 'string' || !HASH.test(value.snapshot.contextFingerprint)))
  || (value.candidateFingerprint !== undefined && (typeof value.candidateFingerprint !== 'string' || !HASH.test(value.candidateFingerprint)))
  || (value.sourceEvidenceFingerprint !== undefined && (typeof value.sourceEvidenceFingerprint !== 'string' || !HASH.test(value.sourceEvidenceFingerprint)))) {
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'The transaction manifest is invalid.')
  }
  if ((value.snapshot.contextState === 'present') !== (value.snapshot.contextFingerprint !== undefined))
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'The Context snapshot state and fingerprint do not agree.')
  if (new Set(value.evidencePaths as string[]).size !== value.evidencePaths.length)
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'Transaction evidence paths must be unique.')
  try {
    assertGitEvidencePath(value.gitEvidencePath)
    ;(value.evidencePaths as string[]).forEach(assertSourcePattern)
  }
  catch {
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'Transaction evidence paths are invalid.')
  }
  const approval = value.approval === undefined ? undefined : parseApproval(value.approval)
  if (value.approval !== undefined && approval === undefined)
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'The transaction approval is invalid.')
  if (approval !== undefined && (approval.candidateFingerprint !== value.candidateFingerprint
    || approval.sourceEvidenceFingerprint !== value.sourceEvidenceFingerprint)) {
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'The transaction approval is not bound to validated fingerprints.')
  }
  const recovery = parseRecovery(value.recovery)
  const phase = value.phase as TransactionPhase
  if (value.dryRun === true && phase !== 'staged' && phase !== 'validated')
    inconsistent()

  const base: ManifestBase = {
    schema: TRANSACTION_SCHEMA,
    runId: value.runId,
    command: value.command,
    mode: value.mode,
    dryRun: value.dryRun,
    scope: value.scope,
    gitEvidencePath: value.gitEvidencePath,
    evidencePaths: value.evidencePaths as string[],
    ...(value.reaffirmedDocumentIds === undefined ? {} : { reaffirmedDocumentIds: value.reaffirmedDocumentIds as string[] }),
    snapshot: {
      contextState: value.snapshot.contextState,
      ...(value.snapshot.contextFingerprint === undefined ? {} : { contextFingerprint: value.snapshot.contextFingerprint as string }),
      declaredEvidenceFingerprint: value.snapshot.declaredEvidenceFingerprint,
      gitEvidenceFingerprint: value.snapshot.gitEvidenceFingerprint,
      gitRevision: value.snapshot.gitRevision,
    },
  }
  if (phase === 'staged') {
    if (value.candidateFingerprint !== undefined || value.sourceEvidenceFingerprint !== undefined
      || approval !== undefined || recovery !== undefined) {
      inconsistent()
    }
    return { ...base, phase }
  }

  if (typeof value.candidateFingerprint !== 'string' || typeof value.sourceEvidenceFingerprint !== 'string')
    inconsistent()
  const pair: ValidatedPair = {
    candidateFingerprint: value.candidateFingerprint,
    sourceEvidenceFingerprint: value.sourceEvidenceFingerprint,
  }
  if (phase === 'validated') {
    if (approval !== undefined || recovery !== undefined)
      inconsistent()
    return { ...base, ...pair, phase }
  }
  if (approval === undefined)
    inconsistent()
  if (phase === 'committing') {
    if (recovery !== undefined && (!('intent' in recovery) || base.snapshot.contextState !== 'present'))
      inconsistent()
    return { ...base, ...pair, phase, approval, ...(recovery === undefined ? {} : { recovery: recovery as { intent: 'restore_backup' } }) }
  }
  if (recovery !== undefined && 'intent' in recovery)
    inconsistent()
  if (phase === 'committed') {
    if (recovery !== undefined && recovery.outcome !== 'candidate_completed')
      inconsistent()
    return { ...base, ...pair, phase, approval, ...(recovery === undefined ? {} : { recovery: { outcome: 'candidate_completed' } }) }
  }
  const expected: RecoveryOutcome = phase === 'restored'
    ? 'backup_restored'
    : phase === 'recovery_required' ? 'manual_recovery' : 'no_trusted_copy'
  if (recovery === undefined || recovery.outcome !== expected)
    inconsistent()
  if (phase === 'restored') {
    if (base.snapshot.contextState !== 'present')
      inconsistent()
    return { ...base, ...pair, phase, approval, recovery: { outcome: 'backup_restored' } }
  }
  return phase === 'recovery_required'
    ? { ...base, ...pair, phase, approval, recovery: { outcome: 'manual_recovery' } }
    : { ...base, ...pair, phase, approval, recovery: { outcome: 'no_trusted_copy' } }
}

async function ensureDirectory(root: string, relative: string): Promise<void> {
  const absolute = await resolveRepositoryPath(root, relative, true)
  await filesystemOperation(() => fs.mkdir(absolute, { recursive: true }).then(() => undefined), relative)
}

async function atomicWriteJson(root: string, relative: string, value: JsonValue): Promise<void> {
  const absolute = await resolveRepositoryPath(root, relative, true)
  await filesystemOperation(() => fs.mkdir(path.dirname(absolute), { recursive: true }).then(() => undefined), relative)
  const temporary = `${absolute}.tmp`
  try {
    const info = await fs.lstat(temporary)
    if (!info.isFile() || info.isSymbolicLink())
      throw new RuntimeFault('TRANSACTION_TEMP_INVALID', 'An atomic transaction temporary path is unsafe.')
    await filesystemOperation(() => fs.rm(temporary), relative)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throwFilesystemFault(error, relative)
  }
  await filesystemOperation(() => fs.writeFile(temporary, stableJson(value), { flag: 'wx', mode: 0o600 }).then(() => undefined), relative)
  await filesystemOperation(() => fs.rename(temporary, absolute), relative)
}

async function writeManifest(root: string, manifest: TransactionManifest): Promise<void> {
  await atomicWriteJson(root, manifestPath(manifest.runId), manifest as unknown as JsonValue)
}

async function loadManifest(root: string, runId: string): Promise<TransactionManifest> {
  if (!UUID.test(runId))
    throw new RuntimeFault('RUN_ID_INVALID', 'runId must be a Runtime-generated UUID.')
  const text = await readUtf8File(root, manifestPath(runId), MAX_JSON_TEXT_BYTES)
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  }
  catch (error) {
    if (error instanceof SyntaxError)
      throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'The transaction manifest cannot be decoded.')
    throw error
  }
  const manifest = parseManifest(raw)
  if (manifest.runId !== runId)
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'The transaction manifest identity does not match its run directory.')
  return manifest
}

async function classifyLock(root: string): Promise<LockFact> {
  const lock = await readLockOwner(root)
  if (lock.state !== 'valid')
    return lock
  try {
    const manifest = await loadManifest(root, lock.runId)
    return manifest.runId === lock.runId ? lock : { state: 'orphan', runId: lock.runId }
  }
  catch (error) {
    if (error instanceof RuntimeFault)
      return { state: 'orphan', runId: lock.runId }
    throw error
  }
}

async function createLock(root: string, runId: string): Promise<LockFact> {
  await ensureDirectory(root, `${SCRATCH_ROOT}/locks`)
  const absolute = await resolveRepositoryPath(root, LOCK_ROOT, true)
  try {
    await fs.mkdir(absolute)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      return classifyLock(root)
    throwFilesystemFault(error, LOCK_ROOT)
  }
  await atomicWriteJson(root, `${LOCK_ROOT}/owner.json`, { schema: LOCK_SCHEMA, runId })
  return { state: 'valid', runId }
}

async function releaseLock(root: string, runId: string): Promise<void> {
  const lock = await readLockOwner(root)
  if (lock.state === 'valid' && lock.runId === runId) {
    const absolute = await resolveRepositoryPath(root, LOCK_ROOT)
    await filesystemOperation(() => fs.rm(absolute, { recursive: true }), LOCK_ROOT)
  }
}

async function treeFact(root: string, relative: string): Promise<TreeFact> {
  try {
    const info = await lstatRepositoryPath(root, relative)
    if (info === undefined)
      return { state: 'absent' }
    if (!info.isDirectory())
      return { state: 'invalid' }
    return { state: 'valid', fingerprint: await fingerprintTree(root, relative) }
  }
  catch (error) {
    if (error instanceof RuntimeFault && error.code !== 'REPOSITORY_IO_FAILED')
      return { state: 'invalid' }
    throw error
  }
}

interface TransactionSourceFacts {
  readonly expansion: SourceExpansionResult
  readonly ledgers: ReadonlyMap<string, DocumentLedger>
  readonly pathsByDocument: ReadonlyMap<string, ReadonlySet<string>>
  readonly sourceEvidenceFingerprint: string
  readonly repositorySourceFingerprint: string
}

function documentSourceOwner(id: string): string {
  return `document:${id}`
}

async function declaredEvidenceFingerprint(root: string, patterns: readonly string[]): Promise<string> {
  const expansion = await expandSourcePatternSets(root, [{ owner: 'declared', patterns }])
  if (expansion.issues.length > 0) {
    const first = expansion.issues[0] as SourceExpansionResult['issues'][number]
    throw new RuntimeFault(first.diagnostic.code, first.diagnostic.message, first.diagnostic.path)
  }
  return expansion.fingerprint
}

async function transactionSourceFacts(root: string, graph: KnowledgeGraph, declaredPatterns: readonly string[]): Promise<TransactionSourceFacts> {
  const expansion = await expandSourcePatternSets(root, [
    ...[...graph.documents.values()].sort((left, right) => compareCodeUnits(left.id, right.id)).map(document => ({
      owner: documentSourceOwner(document.id),
      patterns: document.codePaths,
    })),
    { owner: 'declared', patterns: declaredPatterns },
  ])
  const affected = new Set(expansion.issues.map(item => item.owner))
  const ledgers = new Map<string, DocumentLedger>()
  const pathsByDocument = new Map<string, ReadonlySet<string>>()
  for (const document of graph.documents.values()) {
    const owner = documentSourceOwner(document.id)
    const files = expansion.filesByOwner.get(owner) ?? []
    pathsByDocument.set(document.id, new Set(files.map(file => file.path)))
    if (!affected.has(owner)) {
      ledgers.set(document.id, {
        frontMatterFingerprint: frontMatterFingerprint(document),
        bodyFingerprint: bodyFingerprint(document),
        sourceFingerprint: sourceFingerprint(document, files),
      })
    }
  }
  const repositoryFiles = new Map<string, SourceFile>()
  for (const [owner, files] of expansion.filesByOwner) {
    if (!owner.startsWith('document:'))
      continue
    files.forEach(file => repositoryFiles.set(file.path, file))
  }
  const repositorySourceFingerprint = aggregateSourceFingerprint(
    [...graph.documents.values()].flatMap(document => document.codePaths),
    [...repositoryFiles.values()],
  )
  return {
    expansion,
    ledgers,
    pathsByDocument,
    sourceEvidenceFingerprint: expansion.fingerprint,
    repositorySourceFingerprint,
  }
}

async function validateBeginInput(input: TransactionBeginInput, live: KnowledgeGraph, git: GitEvidence): Promise<void> {
  if (input.command === 'init') {
    if (input.mode !== 'deep')
      throw new RuntimeFault('TRANSACTION_MODE_INVALID', 'Init must use deep mode.')
    if (input.scope.kind !== 'repository')
      throw new RuntimeFault('TRANSACTION_SCOPE_INVALID', 'Init requires repository scope.')
    if (live.formalState !== 'absent')
      throw new RuntimeFault('TRANSACTION_PRECONDITION_FAILED', 'Init requires absent formal Context.')
  }
  else {
    if (live.formalState !== 'ready')
      throw new RuntimeFault('TRANSACTION_PRECONDITION_FAILED', `${input.command} requires ready formal Context.`)
    if (input.command === 'prune' && input.mode !== 'deep')
      throw new RuntimeFault('TRANSACTION_MODE_INVALID', 'Prune must use deep mode.')
    if (input.command === 'prune' && live.sourceState !== 'ready')
      throw new RuntimeFault('TRANSACTION_PRECONDITION_FAILED', 'Prune requires complete current source evidence.')
  }
  if (input.reaffirmedDocumentIds !== undefined) {
    // Init has no prior ledger to settle and Prune already demands ready source evidence.
    if (input.command !== 'update')
      throw new RuntimeFault('TRANSACTION_SCOPE_INVALID', 'Only update may reaffirm Documents.')
    // A typo must fail here rather than silently reaffirm nothing, and reaffirming outside the
    // authorized scope would settle a ledger the caller never asked to touch.
    const authorized = authorizedDocumentIds(input.scope, live, live, new Map(), git)
    for (const id of input.reaffirmedDocumentIds) {
      if (!live.documents.has(id))
        throw new RuntimeFault('TRANSACTION_SCOPE_INVALID', 'A reaffirmed Document does not exist.')
      if (!authorized.has(id))
        throw new RuntimeFault('TRANSACTION_SCOPE_INVALID', 'A reaffirmed Document lies outside the authorized scope.')
    }
  }
}

async function stageCandidate(root: string, runId: string, command: TransactionCommand): Promise<void> {
  const destination = await resolveRepositoryPath(root, candidatePath(runId), true)
  await filesystemOperation(() => fs.mkdir(path.dirname(destination), { recursive: true }).then(() => undefined), candidatePath(runId))
  if (command === 'init') {
    await filesystemOperation(() => fs.mkdir(destination), candidatePath(runId))
  }
  else {
    const source = await resolveRepositoryPath(root, CONTEXT_ROOT)
    await filesystemOperation(
      () => fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: false }),
      candidatePath(runId),
    )
  }
}

function lockIncomplete(activeRunId?: string, manualRecoveryRequired = false): RuntimeResponse {
  return manualRecoveryRequired || activeRunId === undefined
    ? transactionResponse({ outcome: 'manual_recovery', ...(activeRunId === undefined ? {} : { runId: activeRunId }) })
    : transactionResponse({ outcome: 'active_run', runId: activeRunId })
}

/** Classifies a lock that is not this run's own into its safe response. */
function foreignLock(lock: LockFact): RuntimeResponse {
  return lockIncomplete(
    lock.state === 'valid' || lock.state === 'orphan' ? lock.runId : undefined,
    lock.state !== 'valid',
  )
}

async function transactionBegin(root: string, input: TransactionBeginInput): Promise<RuntimeResponse> {
  assertGitEvidencePath(input.gitEvidencePath)
  input.evidencePaths.forEach(assertSourcePattern)
  if (input.scope.kind === 'paths')
    input.scope.paths.forEach(assertSourcePattern)
  const currentLock = await classifyLock(root)
  if (currentLock.state === 'valid')
    return lockIncomplete(currentLock.runId)
  if (currentLock.state === 'corrupt' || currentLock.state === 'orphan')
    return lockIncomplete(currentLock.state === 'orphan' ? currentLock.runId : undefined, true)

  const live = await loadKnowledge(root, undefined, { sourcePolicy: input.command === 'init'
    ? 'formal-only'
    : input.command === 'prune'
      ? 'all-strict'
      : 'all-tolerant' })
  const git = await readGitEvidence(root, input.gitEvidencePath)
  await validateBeginInput(input, live, git)
  const evidenceFingerprint = await declaredEvidenceFingerprint(root, input.evidencePaths)
  const runId = randomUUID()
  let acquired: LockFact
  try {
    acquired = await createLock(root, runId)
  }
  catch (error) {
    if (!(error instanceof RuntimeFault))
      throw error
    await removeOwnedLeaf(root, `${SCRATCH_ROOT}/locks`, 'context-write')
    await cleanupEvidence(root, input.gitEvidencePath)
    return transactionResponse({ outcome: 'mechanical_failure', runId }, error.diagnostics)
  }
  if (acquired.state !== 'valid' || acquired.runId !== runId) {
    return acquired.state === 'valid'
      ? lockIncomplete(acquired.runId)
      : lockIncomplete(acquired.state === 'orphan' ? acquired.runId : undefined, true)
  }

  let manifest: TransactionManifest | undefined
  try {
    await ensureDirectory(root, RUNS_ROOT)
    const directory = await resolveRepositoryPath(root, runPath(runId), true)
    await filesystemOperation(() => fs.mkdir(directory), runPath(runId))
    manifest = {
      schema: TRANSACTION_SCHEMA,
      runId,
      command: input.command,
      mode: input.mode,
      dryRun: input.dryRun,
      scope: input.scope,
      phase: 'staged',
      gitEvidencePath: input.gitEvidencePath,
      evidencePaths: [...input.evidencePaths].sort(compareCodeUnits),
      ...(input.reaffirmedDocumentIds === undefined
        ? {}
        : { reaffirmedDocumentIds: [...input.reaffirmedDocumentIds].sort(compareCodeUnits) }),
      snapshot: {
        contextState: live.formalState === 'absent' ? 'absent' : 'present',
        ...(live.contextFingerprint === undefined ? {} : { contextFingerprint: live.contextFingerprint }),
        declaredEvidenceFingerprint: evidenceFingerprint,
        gitEvidenceFingerprint: git.fingerprint,
        gitRevision: git.currentRevision,
      },
    }
    await writeManifest(root, manifest)
    await stageCandidate(root, runId, input.command)
    return transactionResponse({ outcome: 'staged', runId, candidatePath: candidatePath(runId) })
  }
  catch (error) {
    // Before the manifest exists the lock references no recoverable run, so releasing it
    // destroys no scene and avoids wedging the repository behind an owner whose manifest
    // can never be read. A staged manifest is a real scene: only expected faults clean it.
    if (manifest === undefined)
      await releaseLock(root, runId)
    if (!(error instanceof RuntimeFault))
      throw error
    if (manifest !== undefined)
      await cleanupTerminalArtifacts(root, manifest)
    return transactionResponse({ outcome: 'mechanical_failure', runId }, error.diagnostics)
  }
}

function pruneCoverageIssues(live: KnowledgeGraph, candidate: TransactionSourceFacts): readonly string[] {
  const before = [...live.sources.values()].flatMap(files => files.map(file => file.path))
  const after = new Set([...candidate.pathsByDocument.values()].flatMap(paths => [...paths]))
  return [...new Set(before)].filter(candidatePath => !after.has(candidatePath)).sort(compareCodeUnits)
}

function sameDocument(left: ContextDocument | undefined, right: ContextDocument | undefined): boolean {
  if (left === undefined || right === undefined)
    return left === right
  return left.path === right.path
    && frontMatterFingerprint(left) === frontMatterFingerprint(right)
    && bodyFingerprint(left) === bodyFingerprint(right)
}

function authorizedDocumentIds(
  scope: Scope,
  live: KnowledgeGraph,
  candidate: KnowledgeGraph,
  /** Candidate-side resolved paths; empty at begin, where only the live tree exists. */
  candidatePaths: ReadonlyMap<string, ReadonlySet<string>>,
  git: GitEvidence,
): ReadonlySet<string> {
  const documents = new Map([...live.documents, ...candidate.documents])
  if (scope.kind === 'repository')
    return new Set(documents.keys())
  if (scope.kind === 'documents')
    return new Set(scope.ids)
  if (scope.kind === 'domains') {
    return new Set([...documents.keys()].flatMap((id) => {
      const selected = scope.ids.includes(live.documents.get(id)?.domain ?? '')
        || scope.ids.includes(candidate.documents.get(id)?.domain ?? '')
      return selected ? [id] : []
    }))
  }
  const gitPaths = git.changes.flatMap(change => [change.path, ...(change.previousPath === undefined ? [] : [change.previousPath])])
  const authorized = new Set<string>()
  for (const id of documents.keys()) {
    const declarations = [...(live.documents.get(id)?.codePaths ?? []), ...(candidate.documents.get(id)?.codePaths ?? [])]
    const actualPaths = new Set([
      ...(live.sources.get(id) ?? []).map(file => file.path),
      ...(candidatePaths.get(id) ?? []),
      ...gitPaths.filter(changed => declarations.some(declaration => declarationMatches(declaration, changed))),
    ])
    if ([...actualPaths].some(actual => scope.paths.some(pattern => declarationMatches(pattern, actual))))
      authorized.add(id)
  }
  return authorized
}

function scopeMutationIssues(live: KnowledgeGraph, candidate: KnowledgeGraph, authorized: ReadonlySet<string>): readonly string[] {
  const ids = new Set([...live.documents.keys(), ...candidate.documents.keys()])
  return [...ids].filter(id => !authorized.has(id) && !sameDocument(live.documents.get(id), candidate.documents.get(id))).sort(compareCodeUnits)
}

function convergenceBaseline(graph: KnowledgeGraph, source: 'init' | 'prune'): ConvergenceBaseline {
  const metrics = graphMetrics(graph)
  return { source, ...metrics.current, perDomain: metrics.perDomain }
}

/**
 * A Document owes a fresh ledger when the Recorder edited it, which is how the Runtime tells
 * reviewed knowledge from unreviewed — a stale ledger on an untouched Document is the only record
 * that nobody has checked it yet. `reaffirmedDocumentIds` is the caller stating it did check, so
 * an accurate Document whose declared sources moved can be settled without inventing an edit.
 * The Runtime never infers this: inferring it would silently forge "reviewed".
 */
function refreshedDocumentIds(
  graph: KnowledgeGraph,
  live: KnowledgeGraph,
  authorized: ReadonlySet<string>,
  reaffirmed: readonly string[] = [],
): ReadonlySet<string> {
  const permitted = new Set(reaffirmed)
  return new Set([...graph.documents.keys()].filter(id => authorized.has(id)
    && (permitted.has(id) || !sameDocument(live.documents.get(id), graph.documents.get(id)))))
}

function deriveMeta(
  manifest: TransactionManifest,
  graph: KnowledgeGraph,
  candidateSources: TransactionSourceFacts,
  live: KnowledgeGraph,
  git: GitEvidence,
  authorized: ReadonlySet<string>,
): Meta {
  const refreshed = refreshedDocumentIds(graph, live, authorized, manifest.reaffirmedDocumentIds)
  const documents: Record<string, DocumentLedger> = {}
  for (const id of [...graph.documents.keys()].sort(compareCodeUnits)) {
    const ledger = refreshed.has(id) ? candidateSources.ledgers.get(id) : live.meta?.documents[id]
    if (ledger === undefined)
      throw new RuntimeFault('CANDIDATE_LEDGER_INCOMPLETE', `Candidate ledger for "${id}" cannot be derived within scope.`)
    documents[id] = ledger
  }
  const previousBaseline = live.meta?.repository?.baseline
  const historyComplete = previousBaseline === undefined
    || previousBaseline.revision === git.currentRevision
    || git.hasDiff
  // Advancing claims every Document was proven against the source at this revision. A Document
  // left stale — authorized but neither edited nor reaffirmed — would drop out of every later
  // delta once the history before this revision is gone, so it pins the baseline instead.
  // Unreferenced changes do not: no Document cites them, so no recorded fingerprint covers them.
  const settled = [...graph.documents.keys()].every(id =>
    documents[id]?.sourceFingerprint === candidateSources.ledgers.get(id)?.sourceFingerprint)
  const scopeCanAdvance = manifest.scope.kind === 'repository'
    && !git.midOperation
    && settled
    && historyComplete
  const repository = manifest.command === 'init' || (manifest.command === 'update' && scopeCanAdvance)
    ? { baseline: { revision: git.currentRevision, sourceFingerprint: candidateSources.repositorySourceFingerprint } }
    : live.meta?.repository
  const convergence = manifest.command === 'init'
    ? convergenceBaseline(graph, 'init')
    : manifest.command === 'prune'
      ? convergenceBaseline(graph, 'prune')
      : live.meta?.convergence
  return {
    toolVersion: TOOL_VERSION,
    runtimeProtocol: PROTOCOL,
    fingerprintVersion: FINGERPRINT_VERSION,
    documents,
    ...(repository === undefined ? {} : { repository }),
    ...(convergence === undefined ? {} : { convergence }),
  }
}

async function assertSnapshotFresh(root: string, manifest: TransactionManifest): Promise<void> {
  const live = await treeFact(root, CONTEXT_ROOT)
  if (manifest.snapshot.contextState === 'absent') {
    if (live.state !== 'absent')
      throw new RuntimeFault('FORMAL_CONTEXT_CONFLICT', 'Formal Context changed after transaction begin.')
  }
  else if (live.state !== 'valid' || live.fingerprint !== manifest.snapshot.contextFingerprint) {
    throw new RuntimeFault('FORMAL_CONTEXT_CONFLICT', 'Formal Context changed after transaction begin.')
  }
}

async function assertDeclaredEvidenceFresh(root: string, manifest: TransactionManifest): Promise<void> {
  let current: string
  try {
    current = await declaredEvidenceFingerprint(root, manifest.evidencePaths)
  }
  catch (error) {
    if (error instanceof RuntimeFault && error.code !== 'REPOSITORY_IO_FAILED')
      throw new RuntimeFault('DECLARED_EVIDENCE_CONFLICT', 'Declared source evidence changed after transaction begin.')
    throw error
  }
  if (current !== manifest.snapshot.declaredEvidenceFingerprint)
    throw new RuntimeFault('DECLARED_EVIDENCE_CONFLICT', 'Declared source evidence changed after transaction begin.')
}

async function assertGitEvidenceFresh(root: string, manifest: TransactionManifest): Promise<GitEvidence> {
  let git: GitEvidence
  try {
    git = await readGitEvidence(root, manifest.gitEvidencePath)
  }
  catch (error) {
    if (error instanceof RuntimeFault && error.code !== 'REPOSITORY_IO_FAILED')
      throw new RuntimeFault('GIT_EVIDENCE_CONFLICT', 'Git evidence changed after transaction begin.')
    throw error
  }
  if (git.fingerprint !== manifest.snapshot.gitEvidenceFingerprint || git.currentRevision !== manifest.snapshot.gitRevision)
    throw new RuntimeFault('GIT_EVIDENCE_CONFLICT', 'Git evidence changed after transaction begin.')
  return git
}

async function assertPreSwitchSnapshotFresh(root: string, manifest: TransactionManifest): Promise<GitEvidence> {
  await assertSnapshotFresh(root, manifest)
  await assertDeclaredEvidenceFresh(root, manifest)
  return assertGitEvidenceFresh(root, manifest)
}

async function ownedLeafAbsolute(root: string, parentRelative: string | undefined, leaf: string): Promise<string> {
  if (leaf.length === 0 || leaf.includes('/') || leaf === '.' || leaf === '..')
    throw new TypeError('Transaction leaf names must be fixed single path segments.')
  const parent = parentRelative === undefined
    ? await resolveRepositoryRoot(root)
    : await resolveRepositoryPath(root, parentRelative)
  const info = await filesystemOperation(() => fs.lstat(parent), parentRelative)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new RuntimeFault('TRANSACTION_PARENT_INVALID', 'A transaction-owned parent path is unsafe.', parentRelative)
  return path.join(parent, leaf)
}

async function removeOwnedLeaf(root: string, parentRelative: string | undefined, leaf: string): Promise<void> {
  if (parentRelative !== undefined && await lstatRepositoryPath(root, parentRelative) === undefined)
    return
  const absolute = await ownedLeafAbsolute(root, parentRelative, leaf)
  let info
  try {
    info = await fs.lstat(absolute)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return
    throwFilesystemFault(error, parentRelative === undefined ? leaf : `${parentRelative}/${leaf}`)
  }
  await filesystemOperation(
    () => fs.rm(absolute, info.isDirectory() && !info.isSymbolicLink() ? { recursive: true } : undefined),
    parentRelative === undefined ? leaf : `${parentRelative}/${leaf}`,
  )
}

async function cleanupEvidence(root: string, evidencePath: string): Promise<void> {
  assertGitEvidencePath(evidencePath)
  const parent = path.posix.dirname(evidencePath)
  await removeOwnedLeaf(root, parent, path.posix.basename(evidencePath))
}

async function cleanupTerminalArtifacts(root: string, manifest: TransactionManifest): Promise<void> {
  await cleanupEvidence(root, manifest.gitEvidencePath)
  await releaseLock(root, manifest.runId)
  await removeOwnedLeaf(root, RUNS_ROOT, manifest.runId)
}

function candidateDiagnostics(graph: KnowledgeGraph, sourceFacts?: TransactionSourceFacts): readonly Diagnostic[] {
  return [
    ...graph.issues.map(item => diagnostic(item.code, item.message, 'error', item.path)),
    ...(sourceFacts?.expansion.issues ?? []).map((item) => {
      const id = item.owner.startsWith('document:') ? item.owner.slice('document:'.length) : undefined
      return diagnostic(
        item.diagnostic.code,
        item.diagnostic.message,
        'error',
        id === undefined ? item.diagnostic.path : graph.documents.get(id)?.path,
      )
    }),
  ]
}

function candidateEditRequired(manifest: TransactionManifest, diagnostics: readonly Diagnostic[]): RuntimeResponse {
  return transactionResponse({ outcome: 'candidate_edit_required', runId: manifest.runId }, diagnostics)
}

const SNAPSHOT_CONFLICTS = new Set(['FORMAL_CONTEXT_CONFLICT', 'DECLARED_EVIDENCE_CONFLICT', 'GIT_EVIDENCE_CONFLICT'])

async function preSwitchFailure(root: string, manifest: TransactionManifest, error: unknown): Promise<RuntimeResponse> {
  if (!(error instanceof RuntimeFault))
    throw error
  if (SNAPSHOT_CONFLICTS.has(error.code)) {
    await cleanupTerminalArtifacts(root, manifest)
    return transactionResponse({ outcome: 'snapshot_stale', runId: manifest.runId }, error.diagnostics)
  }
  if (error.code === 'REPOSITORY_IO_FAILED') {
    await cleanupTerminalArtifacts(root, manifest)
    return transactionResponse({ outcome: 'mechanical_failure', runId: manifest.runId }, error.diagnostics)
  }
  throw error
}

async function transactionValidate(root: string, input: TransactionValidateInput): Promise<RuntimeResponse> {
  let manifest = await loadManifest(root, input.runId)
  if (manifest.phase !== 'staged' && manifest.phase !== 'validated')
    throw new RuntimeFault('TRANSACTION_PHASE_INVALID', 'transaction.validate requires a staged or validated run.')
  const lock = await classifyLock(root)
  if (lock.state !== 'valid' || lock.runId !== manifest.runId)
    return lockIncomplete(lock.state === 'valid' || lock.state === 'orphan' ? lock.runId : undefined, lock.state !== 'valid')
  let git: GitEvidence
  try {
    git = await assertPreSwitchSnapshotFresh(root, manifest)
  }
  catch (error) {
    return preSwitchFailure(root, manifest, error)
  }

  try {
    const live = await loadKnowledge(root, undefined, { sourcePolicy: 'all-tolerant' })
    if ((manifest.snapshot.contextState === 'absent' && live.formalState !== 'absent')
      || (manifest.snapshot.contextState === 'present' && live.formalState !== 'ready')) {
      await assertSnapshotFresh(root, manifest)
      throw new RuntimeFault('FORMAL_CONTEXT_CONFLICT', 'Formal Context changed after transaction begin.')
    }
    const candidate = await loadKnowledge(root, candidatePath(manifest.runId), {
      ignoreMeta: true,
      requireMeta: false,
      sourcePolicy: 'formal-only',
    })
    if (candidate.formalState !== 'ready')
      return candidateEditRequired(manifest, candidateDiagnostics(candidate))
    const sources = await transactionSourceFacts(root, candidate, manifest.evidencePaths)
    if (sources.expansion.issues.length > 0) {
      try {
        await assertPreSwitchSnapshotFresh(root, manifest)
      }
      catch (error) {
        return preSwitchFailure(root, manifest, error)
      }
      return candidateEditRequired(manifest, candidateDiagnostics(candidate, sources))
    }
    const authorized = authorizedDocumentIds(manifest.scope, live, candidate, sources.pathsByDocument, git)
    const outsideScope = scopeMutationIssues(live, candidate, authorized)
    if (outsideScope.length > 0) {
      return candidateEditRequired(manifest, [diagnostic(
        'CANDIDATE_SCOPE_VIOLATION',
        'Candidate modifies a Document outside the authorized scope.',
        'error',
        candidate.documents.get(outsideScope[0] as string)?.path ?? live.documents.get(outsideScope[0] as string)?.path,
      )])
    }
    if (manifest.command === 'prune') {
      if (live.sourceState !== 'ready')
        return candidateEditRequired(manifest, [diagnostic('PRUNE_SOURCE_DEGRADED', 'Prune requires complete live source coverage.')])
      const lost = pruneCoverageIssues(live, sources)
      if (lost.length > 0)
        return candidateEditRequired(manifest, [diagnostic('PRUNE_COVERAGE_LOST', 'Prune candidate loses existing source coverage.', 'error', lost[0])])
    }
    const derived = deriveMeta(manifest, candidate, sources, live, git, authorized)
    await atomicWriteJson(root, `${candidatePath(manifest.runId)}/meta.json`, JSON.parse(serializeMeta(derived)) as JsonValue)
    const validated = await loadKnowledge(root, candidatePath(manifest.runId), { sourcePolicy: 'formal-only' })
    if (validated.formalState !== 'ready' || validated.contextFingerprint === undefined)
      return candidateEditRequired(manifest, candidateDiagnostics(validated))
    const finalSources = await transactionSourceFacts(root, validated, manifest.evidencePaths)
    if (finalSources.expansion.issues.length > 0 || finalSources.sourceEvidenceFingerprint !== sources.sourceEvidenceFingerprint) {
      try {
        await assertPreSwitchSnapshotFresh(root, manifest)
      }
      catch (error) {
        return preSwitchFailure(root, manifest, error)
      }
      return candidateEditRequired(manifest, candidateDiagnostics(validated, finalSources))
    }
    for (const id of refreshedDocumentIds(validated, live, authorized, manifest.reaffirmedDocumentIds)) {
      const recorded = validated.meta?.documents[id]
      const current = finalSources.ledgers.get(id)
      if (recorded === undefined || current === undefined || recorded.sourceFingerprint !== current.sourceFingerprint)
        return candidateEditRequired(manifest, [diagnostic('CANDIDATE_SOURCE_STALE', 'Candidate source evidence changed during validation.')])
    }
    const candidateFingerprint = validated.contextFingerprint as string
    const sourceEvidenceFingerprint = finalSources.sourceEvidenceFingerprint
    try {
      await assertPreSwitchSnapshotFresh(root, manifest)
    }
    catch (error) {
      return preSwitchFailure(root, manifest, error)
    }
    // Re-validating always discards any earlier approval and recovery fact: only the
    // base run facts plus the two freshly computed fingerprints survive.
    manifest = { ...baseFacts(manifest), phase: 'validated', candidateFingerprint, sourceEvidenceFingerprint }
    if (manifest.snapshot.contextState === 'present' && candidateFingerprint === manifest.snapshot.contextFingerprint) {
      const response = transactionResponse({ outcome: 'no_change', runId: manifest.runId, contextFingerprint: candidateFingerprint })
      await cleanupTerminalArtifacts(root, manifest)
      return response
    }
    await writeManifest(root, manifest)
    if (manifest.dryRun) {
      const response = transactionResponse({ outcome: 'validated', runId: manifest.runId, candidateFingerprint, sourceEvidenceFingerprint })
      await cleanupTerminalArtifacts(root, manifest)
      return response
    }
    return transactionResponse({ outcome: 'ready_for_review', runId: manifest.runId, candidateFingerprint, sourceEvidenceFingerprint })
  }
  catch (error) {
    if (!(error instanceof RuntimeFault))
      throw error
    if (error.code === 'REPOSITORY_IO_FAILED')
      return preSwitchFailure(root, manifest, error)
    return candidateEditRequired(manifest, error.diagnostics)
  }
}

async function validatedFacts(root: string, manifest: TransactionManifest): Promise<{
  readonly graph: KnowledgeGraph
  readonly candidateFingerprint: string
  readonly sourceEvidenceFingerprint: string
}> {
  const graph = await loadKnowledge(root, candidatePath(manifest.runId), { sourcePolicy: 'formal-only' })
  if (graph.formalState !== 'ready' || graph.contextFingerprint === undefined)
    throw new RuntimeFault('CANDIDATE_INVALID', 'The transaction candidate is not a complete valid Context tree.')
  const sources = await transactionSourceFacts(root, graph, manifest.evidencePaths)
  if (sources.expansion.issues.length > 0)
    throw new RuntimeFault('CANDIDATE_SOURCE_INVALID', 'The transaction candidate source evidence is incomplete.')
  return {
    graph,
    candidateFingerprint: graph.contextFingerprint,
    sourceEvidenceFingerprint: sources.sourceEvidenceFingerprint,
  }
}

/**
 * Binds an approval to the candidate and source evidence as they exist right now. Callers must
 * first prove the recomputed facts still equal the validated manifest (returning
 * `candidate_stale` when they do not), so comparing against the live facts also binds the
 * approval to the manifest. Both comparisons here are load-bearing: dropping either one lets a
 * stale approval commit.
 */
function approvalMatches(approval: TransactionApproval, facts: ValidatedPair): boolean {
  return approval.approved === true
    && approval.candidateFingerprint === facts.candidateFingerprint
    && approval.sourceEvidenceFingerprint === facts.sourceEvidenceFingerprint
}

type ValidatedFacts = Awaited<ReturnType<typeof validatedFacts>>

interface RecoveryFacts {
  readonly live: TreeFact
  readonly candidate: TreeFact
  readonly backup: TreeFact
}

function isSnapshotFact(manifest: TransactionManifest, fact: TreeFact): boolean {
  return manifest.snapshot.contextState === 'absent'
    ? fact.state === 'absent'
    : fact.state === 'valid' && fact.fingerprint === manifest.snapshot.contextFingerprint
}

function isCandidateFact(manifest: ValidatedManifest, fact: TreeFact): boolean {
  return fact.state === 'valid' && fact.fingerprint === manifest.candidateFingerprint
}

function isBackupFact(manifest: TransactionManifest, fact: TreeFact): boolean {
  return manifest.snapshot.contextState === 'present'
    && fact.state === 'valid'
    && fact.fingerprint === manifest.snapshot.contextFingerprint
}

async function readRecoveryFacts(root: string, manifest: TransactionManifest): Promise<RecoveryFacts> {
  const [live, candidate, backup] = await Promise.all([
    treeFact(root, CONTEXT_ROOT),
    treeFact(root, candidatePath(manifest.runId)),
    treeFact(root, backupPath(manifest.runId)),
  ])
  return { live, candidate, backup }
}

async function candidateStale(root: string, manifest: ValidatedManifest): Promise<RuntimeResponse> {
  if (manifest.phase !== 'validated')
    await writeManifest(root, { ...baseFacts(manifest), phase: 'validated', ...validatedPair(manifest) })
  return transactionResponse({ outcome: 'candidate_stale', runId: manifest.runId })
}

function approvalMismatch(manifest: ValidatedManifest): RuntimeResponse {
  return transactionResponse(
    { outcome: 'approval_mismatch', runId: manifest.runId },
    [diagnostic('APPROVAL_MISMATCH', 'Semantic approval does not match current candidate and source evidence.')],
  )
}

async function finalizeCommitted(
  root: string,
  manifest: ApprovedManifest,
  recoveryOutcome?: 'candidate_completed',
): Promise<RuntimeResponse> {
  const live = await treeFact(root, CONTEXT_ROOT)
  if (!isCandidateFact(manifest, live))
    throw new RuntimeFault('FINAL_VERIFICATION_FAILED', 'Committed Context does not match the approved candidate.')
  const graph = await loadKnowledge(root, undefined, { sourcePolicy: 'formal-only' })
  if (graph.formalState !== 'ready' || graph.contextFingerprint !== manifest.candidateFingerprint)
    throw new RuntimeFault('FINAL_VERIFICATION_FAILED', 'Committed Context failed final schema or graph verification.')
  const committed: TransactionManifest = {
    ...baseFacts(manifest),
    ...validatedPair(manifest),
    phase: 'committed',
    approval: manifest.approval,
    ...(recoveryOutcome === undefined ? {} : { recovery: { outcome: recoveryOutcome } }),
  }
  await writeManifest(root, committed)
  const response = transactionResponse({
    outcome: recoveryOutcome ?? 'committed',
    runId: manifest.runId,
    contextFingerprint: manifest.candidateFingerprint,
    approvedCandidateFingerprint: manifest.approval.candidateFingerprint,
    approvedSourceEvidenceFingerprint: manifest.approval.sourceEvidenceFingerprint,
  })
  await cleanupTerminalArtifacts(root, committed)
  return response
}

async function directorySwitch(root: string, manifest: ApprovedManifest): Promise<RuntimeResponse> {
  const backup = await treeFact(root, backupPath(manifest.runId))
  if (backup.state !== 'absent')
    throw new RuntimeFault('TRANSACTION_LAYOUT_CONFLICT', 'The transaction backup leaf is not empty before directory switch.')
  const candidateAbsolute = await ownedLeafAbsolute(root, `${runPath(manifest.runId)}/candidate`, 'context')
  const liveAbsolute = await ownedLeafAbsolute(root, undefined, CONTEXT_ROOT)
  if (manifest.snapshot.contextState === 'present') {
    await ensureDirectory(root, `${runPath(manifest.runId)}/backup`)
    const backupAbsolute = await ownedLeafAbsolute(root, `${runPath(manifest.runId)}/backup`, 'context')
    await filesystemOperation(() => fs.rename(liveAbsolute, backupAbsolute), CONTEXT_ROOT)
  }
  await filesystemOperation(() => fs.rename(candidateAbsolute, liveAbsolute), candidatePath(manifest.runId))
  return finalizeCommitted(root, manifest)
}

async function manualRecovery(root: string, manifest: ApprovedManifest): Promise<RuntimeResponse> {
  // A pending restore intent must survive: a later resume still needs it to finish the
  // idempotent restore, so manual recovery never overwrites it.
  if (!hasRestoreIntent(manifest))
    await writeManifest(root, { ...manifest, phase: 'recovery_required', recovery: { outcome: 'manual_recovery' } })
  return transactionResponse({ outcome: 'manual_recovery', runId: manifest.runId })
}

async function noTrustedCopy(root: string, manifest: ApprovedManifest): Promise<RuntimeResponse> {
  await writeManifest(root, { ...manifest, phase: 'failed', recovery: { outcome: 'no_trusted_copy' } })
  return transactionResponse({ outcome: 'no_trusted_copy', runId: manifest.runId })
}

async function backupRestored(root: string, manifest: ApprovedManifest): Promise<RuntimeResponse> {
  const restored: TransactionManifest = { ...manifest, phase: 'restored', recovery: { outcome: 'backup_restored' } }
  await writeManifest(root, restored)
  const response = transactionResponse({
    outcome: 'backup_restored',
    runId: manifest.runId,
    contextFingerprint: manifest.snapshot.contextFingerprint as string,
  })
  await cleanupTerminalArtifacts(root, restored)
  return response
}

async function restoreBackup(root: string, manifest: ApprovedManifest, facts: RecoveryFacts): Promise<RuntimeResponse> {
  const recorded = hasRestoreIntent(manifest)
  const intent: ApprovedManifest = {
    ...baseFacts(manifest),
    ...validatedPair(manifest),
    phase: 'committing',
    approval: manifest.approval,
    recovery: { intent: 'restore_backup' },
  }
  // The intent must reach disk before the destructive rename so a crash between the two
  // resumes into this same branch instead of being read as a completed switch.
  if (!recorded)
    await writeManifest(root, intent)

  const current = recorded ? facts : await readRecoveryFacts(root, intent)
  if (isSnapshotFact(manifest, current.live) && current.backup.state === 'absent')
    return backupRestored(root, intent)
  if (!isBackupFact(manifest, current.backup) || (current.live.state !== 'absent' && current.live.state !== 'invalid')) {
    return current.live.state === 'valid' || current.candidate.state === 'valid' || current.backup.state === 'valid'
      ? manualRecovery(root, intent)
      : noTrustedCopy(root, intent)
  }

  if (current.live.state === 'invalid')
    await removeOwnedLeaf(root, undefined, CONTEXT_ROOT)
  const backupAbsolute = await ownedLeafAbsolute(root, `${runPath(manifest.runId)}/backup`, 'context')
  const liveAbsolute = await ownedLeafAbsolute(root, undefined, CONTEXT_ROOT)
  await filesystemOperation(() => fs.rename(backupAbsolute, liveAbsolute), backupPath(manifest.runId))
  const restoredLive = await treeFact(root, CONTEXT_ROOT)
  if (!isSnapshotFact(manifest, restoredLive))
    return manualRecovery(root, intent)
  return backupRestored(root, intent)
}

async function recoverCommitting(root: string, manifest: ApprovedManifest): Promise<RuntimeResponse> {
  const facts = await readRecoveryFacts(root, manifest)
  if (hasRestoreIntent(manifest))
    return restoreBackup(root, manifest, facts)
  if (isCandidateFact(manifest, facts.live))
    return finalizeCommitted(root, manifest, 'candidate_completed')

  if (isSnapshotFact(manifest, facts.live) && isCandidateFact(manifest, facts.candidate) && facts.backup.state === 'absent') {
    let current: ValidatedFacts
    try {
      await assertPreSwitchSnapshotFresh(root, manifest)
      current = await validatedFacts(root, manifest)
    }
    catch (error) {
      if (error instanceof RuntimeFault && (SNAPSHOT_CONFLICTS.has(error.code) || error.code === 'REPOSITORY_IO_FAILED'))
        return preSwitchFailure(root, manifest, error)
      if (error instanceof RuntimeFault)
        return candidateStale(root, manifest)
      throw error
    }
    if (current.candidateFingerprint !== manifest.candidateFingerprint
      || current.sourceEvidenceFingerprint !== manifest.sourceEvidenceFingerprint
      || !approvalMatches(manifest.approval, current)) {
      return candidateStale(root, manifest)
    }
    return directorySwitch(root, manifest)
  }

  if ((facts.live.state === 'absent' || facts.live.state === 'invalid') && isBackupFact(manifest, facts.backup))
    return restoreBackup(root, manifest, facts)
  return [facts.live, facts.candidate, facts.backup].some(fact => fact.state === 'valid')
    ? manualRecovery(root, manifest)
    : noTrustedCopy(root, manifest)
}

async function transactionCommit(root: string, input: TransactionCommitInput): Promise<RuntimeResponse> {
  const validated = await loadManifest(root, input.runId)
  if (validated.phase !== 'validated')
    throw new RuntimeFault('TRANSACTION_PHASE_INVALID', 'transaction.commit requires a validated run.')
  // The lock owner decides before any candidate or source read, so a foreign owner is
  // never masked by a candidate error belonging to someone else's run.
  const initialLock = await classifyLock(root)
  if (initialLock.state !== 'valid' || initialLock.runId !== validated.runId)
    return foreignLock(initialLock)

  try {
    await assertPreSwitchSnapshotFresh(root, validated)
  }
  catch (error) {
    return preSwitchFailure(root, validated, error)
  }

  let facts: ValidatedFacts
  try {
    facts = await validatedFacts(root, validated)
  }
  catch (error) {
    if (error instanceof RuntimeFault && error.code === 'REPOSITORY_IO_FAILED')
      return preSwitchFailure(root, validated, error)
    if (error instanceof RuntimeFault)
      return candidateStale(root, validated)
    throw error
  }
  if (facts.candidateFingerprint !== validated.candidateFingerprint
    || facts.sourceEvidenceFingerprint !== validated.sourceEvidenceFingerprint) {
    return candidateStale(root, validated)
  }
  if (!approvalMatches(input.approval, facts))
    return approvalMismatch(validated)

  const finalLock = await classifyLock(root)
  if (finalLock.state !== 'valid' || finalLock.runId !== validated.runId)
    return foreignLock(finalLock)
  const committing: ApprovedManifest = { ...validated, phase: 'committing', approval: input.approval }
  try {
    await writeManifest(root, committing)
  }
  catch (error) {
    return preSwitchFailure(root, committing, error)
  }
  try {
    return await directorySwitch(root, committing)
  }
  catch (error) {
    if (!(error instanceof RuntimeFault))
      throw error
    return recoverCommitting(root, committing)
  }
}

async function acquireResumeLock(root: string, manifest: TransactionManifest): Promise<LockFact> {
  const lock = await classifyLock(root)
  if (lock.state === 'absent')
    return createLock(root, manifest.runId)
  return lock
}

async function abandonTransaction(root: string, manifest: TransactionManifest): Promise<RuntimeResponse> {
  if (manifest.phase !== 'staged' && manifest.phase !== 'validated')
    throw new RuntimeFault('TRANSACTION_ABANDON_INVALID', 'Only staged or validated transactions can be abandoned.')
  const backup = await treeFact(root, backupPath(manifest.runId))
  if (backup.state !== 'absent')
    return lockIncomplete(manifest.runId, true)
  try {
    await assertSnapshotFresh(root, manifest)
  }
  catch (error) {
    return preSwitchFailure(root, manifest, error)
  }
  const response = transactionResponse({ outcome: 'abandoned', runId: manifest.runId })
  await cleanupTerminalArtifacts(root, manifest)
  return response
}

async function resumeStaged(root: string, manifest: TransactionManifest): Promise<RuntimeResponse> {
  try {
    await assertPreSwitchSnapshotFresh(root, manifest)
  }
  catch (error) {
    return preSwitchFailure(root, manifest, error)
  }
  const candidate = await treeFact(root, candidatePath(manifest.runId))
  if (candidate.state === 'invalid') {
    return candidateEditRequired(manifest, [diagnostic(
      'CANDIDATE_ROOT_INVALID',
      'The staged candidate root must be a safe ordinary directory.',
      'error',
      candidatePath(manifest.runId),
    )])
  }
  if (candidate.state === 'absent') {
    try {
      await stageCandidate(root, manifest.runId, manifest.command)
    }
    catch (error) {
      return preSwitchFailure(root, manifest, error)
    }
  }
  return transactionResponse({ outcome: 'staged', runId: manifest.runId, candidatePath: candidatePath(manifest.runId) })
}

async function resumeValidated(root: string, manifest: ValidatedManifest): Promise<RuntimeResponse> {
  try {
    await assertPreSwitchSnapshotFresh(root, manifest)
  }
  catch (error) {
    return preSwitchFailure(root, manifest, error)
  }
  let facts: ValidatedFacts
  try {
    facts = await validatedFacts(root, manifest)
  }
  catch (error) {
    if (!(error instanceof RuntimeFault))
      throw error
    if (error.code === 'REPOSITORY_IO_FAILED')
      return preSwitchFailure(root, manifest, error)
    if (error.code === 'CANDIDATE_INVALID')
      return candidateEditRequired(manifest, error.diagnostics)
    return candidateStale(root, manifest)
  }
  if (facts.candidateFingerprint !== manifest.candidateFingerprint
    || facts.sourceEvidenceFingerprint !== manifest.sourceEvidenceFingerprint) {
    return candidateStale(root, manifest)
  }
  const { candidateFingerprint, sourceEvidenceFingerprint } = facts
  if (manifest.dryRun) {
    const response = transactionResponse({ outcome: 'validated', runId: manifest.runId, candidateFingerprint, sourceEvidenceFingerprint })
    await cleanupTerminalArtifacts(root, manifest)
    return response
  }
  return transactionResponse({ outcome: 'ready_for_review', runId: manifest.runId, candidateFingerprint, sourceEvidenceFingerprint })
}

/** Re-proves a recorded terminal outcome against current directory facts before cleaning up. */
async function terminalResume(root: string, manifest: ApprovedManifest): Promise<RuntimeResponse> {
  const facts = await readRecoveryFacts(root, manifest)
  if (manifest.phase === 'committed' && isCandidateFact(manifest, facts.live)) {
    const graph = await loadKnowledge(root, undefined, { sourcePolicy: 'formal-only' })
    if (graph.formalState !== 'ready' || graph.contextFingerprint !== manifest.candidateFingerprint)
      return manualRecovery(root, manifest)
    const response = transactionResponse({
      outcome: manifest.recovery?.outcome ?? 'committed',
      runId: manifest.runId,
      contextFingerprint: manifest.candidateFingerprint,
      approvedCandidateFingerprint: manifest.approval.candidateFingerprint,
      approvedSourceEvidenceFingerprint: manifest.approval.sourceEvidenceFingerprint,
    })
    await cleanupTerminalArtifacts(root, manifest)
    return response
  }
  if (manifest.phase === 'restored'
    && isSnapshotFact(manifest, facts.live)
    && facts.backup.state !== 'valid'
    && (facts.candidate.state !== 'valid' || isCandidateFact(manifest, facts.candidate))) {
    return backupRestored(root, manifest)
  }
  if (manifest.phase === 'failed' && ![facts.live, facts.candidate, facts.backup].some(fact => fact.state === 'valid'))
    return transactionResponse({ outcome: 'no_trusted_copy', runId: manifest.runId })
  return [facts.live, facts.candidate, facts.backup].some(fact => fact.state === 'valid')
    ? manualRecovery(root, manifest)
    : noTrustedCopy(root, manifest)
}

async function transactionResume(root: string, input: TransactionResumeInput): Promise<RuntimeResponse> {
  const manifest = await loadManifest(root, input.runId)
  const lock = await acquireResumeLock(root, manifest)
  if (lock.state !== 'valid' || lock.runId !== manifest.runId)
    return foreignLock(lock)
  if (input.disposition === 'abandon')
    return abandonTransaction(root, manifest)
  switch (manifest.phase) {
    case 'staged': return resumeStaged(root, manifest)
    case 'validated': return resumeValidated(root, manifest)
    case 'committing':
    case 'recovery_required': return recoverCommitting(root, manifest)
    default: return terminalResume(root, manifest)
  }
}

export async function transaction(root: string, request: RuntimeRequest): Promise<RuntimeResponse> {
  switch (request.action) {
    case 'begin': return transactionBegin(root, request.input as TransactionBeginInput)
    case 'validate': return transactionValidate(root, request.input as TransactionValidateInput)
    case 'commit': return transactionCommit(root, request.input as TransactionCommitInput)
    case 'resume': return transactionResume(root, request.input as TransactionResumeInput)
    default: throw new RuntimeFault('ACTION_UNKNOWN', 'transaction action is unknown.')
  }
}
