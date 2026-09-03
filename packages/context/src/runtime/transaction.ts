import type { ConvergenceBaseline, DocumentLedger, Meta } from './document.js'
import type { KnowledgeGraph } from './graph.js'
import type { RuntimeRequest, RuntimeResponse, Scope, TransactionApproval, TransactionBeginInput, TransactionCommand, TransactionCommitInput, TransactionMode, TransactionResumeInput, TransactionValidateInput } from './protocol.js'
import type { GitEvidence } from './repository.js'
import type { JsonValue } from './stable-json.js'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { FINGERPRINT_VERSION, serializeMeta, TOOL_VERSION } from './document.js'
import { graphMetrics, loadKnowledge } from './graph.js'
import { diagnostic, PROTOCOL, RuntimeFault, runtimeResponse } from './protocol.js'
import { aggregateSourceFingerprint, assertGitEvidencePath, assertSourcePattern, CONTEXT_ROOT, controlledGlobMatches, expandSourcePatterns, fingerprintTree, LOCK_ROOT, lstatRepositoryPath, MAX_JSON_TEXT_BYTES, pathExists, readGitEvidence, readUtf8File, resolveRepositoryPath, RUNS_ROOT, SCRATCH_ROOT } from './repository.js'
import { compareCodeUnits, stableJson } from './stable-json.js'

const TRANSACTION_SCHEMA = 'plugydown.context.transaction/v1'
const LOCK_SCHEMA = 'plugydown.context.lock/v1'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const HASH = /^[a-f0-9]{64}$/

export type TransactionPhase
  = | 'staged'
    | 'validated'
    | 'committing'
    | 'committed'
    | 'restored'
    | 'recovery_required'
    | 'failed'

interface TransactionManifest {
  readonly schema: typeof TRANSACTION_SCHEMA
  readonly runId: string
  readonly command: TransactionCommand
  readonly mode: TransactionMode
  readonly dryRun: boolean
  readonly scope: Scope
  readonly phase: TransactionPhase
  readonly gitEvidencePath: string
  readonly evidencePaths: readonly string[]
  readonly snapshot: {
    readonly contextState: 'absent' | 'present'
    readonly contextFingerprint?: string
    readonly declaredEvidenceFingerprint: string
    readonly gitEvidenceFingerprint: string
    readonly gitRevision: string
  }
  readonly candidateFingerprint?: string
  readonly sourceEvidenceFingerprint?: string
  readonly approval?: TransactionApproval
  readonly recovery?: {
    readonly outcome: 'candidate_completed' | 'backup_restored' | 'manual_required' | 'no_trusted_copy'
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  if (value.kind === 'domains' || value.kind === 'documents')
    return exactKeys(value, ['kind', 'ids']) && Array.isArray(value.ids) && value.ids.length > 0 && value.ids.every(item => typeof item === 'string' && item.length > 0) && new Set(value.ids).size === value.ids.length
  return value.kind === 'paths' && exactKeys(value, ['kind', 'paths']) && Array.isArray(value.paths) && value.paths.length > 0 && value.paths.every(item => typeof item === 'string' && item.length > 0) && new Set(value.paths).size === value.paths.length
}

function parseApproval(value: unknown): TransactionApproval | undefined {
  if (!isRecord(value) || !exactKeys(value, ['approved', 'candidateFingerprint', 'sourceEvidenceFingerprint', 'summary'])
    || value.approved !== true
    || typeof value.candidateFingerprint !== 'string' || !HASH.test(value.candidateFingerprint)
    || typeof value.sourceEvidenceFingerprint !== 'string' || !HASH.test(value.sourceEvidenceFingerprint)
    || typeof value.summary !== 'string' || value.summary.length === 0 || value.summary.length > 2_048) {
    return undefined
  }
  return {
    approved: value.approved,
    candidateFingerprint: value.candidateFingerprint,
    sourceEvidenceFingerprint: value.sourceEvidenceFingerprint,
    summary: value.summary,
  }
}

function parseManifest(value: unknown): TransactionManifest {
  if (!isRecord(value) || !exactKeys(
    value,
    ['schema', 'runId', 'command', 'mode', 'dryRun', 'scope', 'phase', 'gitEvidencePath', 'evidencePaths', 'snapshot'],
    ['candidateFingerprint', 'sourceEvidenceFingerprint', 'approval', 'recovery'],
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
  || !isRecord(value.snapshot)
  || !exactKeys(value.snapshot, ['contextState', 'declaredEvidenceFingerprint', 'gitEvidenceFingerprint', 'gitRevision'], ['contextFingerprint'])
  || (value.snapshot.contextState !== 'absent' && value.snapshot.contextState !== 'present')
  || typeof value.snapshot.declaredEvidenceFingerprint !== 'string' || !HASH.test(value.snapshot.declaredEvidenceFingerprint)
  || typeof value.snapshot.gitEvidenceFingerprint !== 'string' || !HASH.test(value.snapshot.gitEvidenceFingerprint)
  || typeof value.snapshot.gitRevision !== 'string'
  || (value.snapshot.contextFingerprint !== undefined && (typeof value.snapshot.contextFingerprint !== 'string' || !HASH.test(value.snapshot.contextFingerprint)))
  || (value.candidateFingerprint !== undefined && (typeof value.candidateFingerprint !== 'string' || !HASH.test(value.candidateFingerprint)))
  || (value.sourceEvidenceFingerprint !== undefined && (typeof value.sourceEvidenceFingerprint !== 'string' || !HASH.test(value.sourceEvidenceFingerprint)))) {
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'The transaction manifest is invalid.')
  }
  if ((value.snapshot.contextState === 'present') !== (value.snapshot.contextFingerprint !== undefined))
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'The Context snapshot state and fingerprint do not agree.')
  if (new Set(value.evidencePaths as string[]).size !== value.evidencePaths.length)
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'Transaction evidence paths must be unique.')
  const approval = value.approval === undefined ? undefined : parseApproval(value.approval)
  if (value.approval !== undefined && approval === undefined)
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'The transaction approval is invalid.')
  if (approval !== undefined && (approval.candidateFingerprint !== value.candidateFingerprint
    || approval.sourceEvidenceFingerprint !== value.sourceEvidenceFingerprint)) {
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'The transaction approval is not bound to validated fingerprints.')
  }
  let recovery: TransactionManifest['recovery']
  if (value.recovery !== undefined) {
    if (!isRecord(value.recovery) || !exactKeys(value.recovery, ['outcome'])
      || !['candidate_completed', 'backup_restored', 'manual_required', 'no_trusted_copy'].includes(String(value.recovery.outcome))) {
      throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'The transaction recovery fact is invalid.')
    }
    recovery = { outcome: value.recovery.outcome as NonNullable<TransactionManifest['recovery']>['outcome'] }
  }
  for (const candidate of value.evidencePaths as string[])
    assertSourcePattern(candidate)
  return {
    schema: TRANSACTION_SCHEMA,
    runId: value.runId,
    command: value.command,
    mode: value.mode,
    dryRun: value.dryRun,
    scope: value.scope,
    phase: value.phase as TransactionPhase,
    gitEvidencePath: value.gitEvidencePath,
    evidencePaths: value.evidencePaths as string[],
    snapshot: {
      contextState: value.snapshot.contextState,
      ...(value.snapshot.contextFingerprint === undefined ? {} : { contextFingerprint: value.snapshot.contextFingerprint as string }),
      declaredEvidenceFingerprint: value.snapshot.declaredEvidenceFingerprint,
      gitEvidenceFingerprint: value.snapshot.gitEvidenceFingerprint,
      gitRevision: value.snapshot.gitRevision,
    },
    ...(value.candidateFingerprint === undefined ? {} : { candidateFingerprint: value.candidateFingerprint as string }),
    ...(value.sourceEvidenceFingerprint === undefined ? {} : { sourceEvidenceFingerprint: value.sourceEvidenceFingerprint as string }),
    ...(approval === undefined ? {} : { approval }),
    ...(recovery === undefined ? {} : { recovery }),
  }
}

async function ensureDirectory(root: string, relative: string): Promise<void> {
  const absolute = await resolveRepositoryPath(root, relative, true)
  await fs.mkdir(absolute, { recursive: true })
}

async function atomicWriteJson(root: string, relative: string, value: JsonValue): Promise<void> {
  const absolute = await resolveRepositoryPath(root, relative, true)
  await fs.mkdir(path.dirname(absolute), { recursive: true })
  const temporary = `${absolute}.tmp`
  try {
    const info = await fs.lstat(temporary)
    if (!info.isFile() || info.isSymbolicLink())
      throw new RuntimeFault('TRANSACTION_TEMP_INVALID', 'An atomic transaction temporary path is unsafe.')
    await fs.rm(temporary)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error
  }
  await fs.writeFile(temporary, stableJson(value), { flag: 'wx', mode: 0o600 })
  await fs.rename(temporary, absolute)
}

async function writeManifest(root: string, manifest: TransactionManifest): Promise<void> {
  await atomicWriteJson(root, manifestPath(manifest.runId), manifest as unknown as JsonValue)
}

async function loadManifest(root: string, runId: string): Promise<TransactionManifest> {
  if (!UUID.test(runId))
    throw new RuntimeFault('RUN_ID_INVALID', 'runId must be a Runtime-generated UUID.')
  let raw: unknown
  try {
    raw = JSON.parse((await readUtf8File(root, manifestPath(runId), MAX_JSON_TEXT_BYTES)).replace(/^\uFEFF/, ''))
  }
  catch (error) {
    if (error instanceof RuntimeFault)
      throw error
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'The transaction manifest cannot be read.')
  }
  const manifest = parseManifest(raw)
  if (manifest.runId !== runId)
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'The transaction manifest identity does not match its run directory.')
  return manifest
}

async function readLock(root: string): Promise<LockFact> {
  try {
    const info = await lstatRepositoryPath(root, LOCK_ROOT)
    if (info === undefined)
      return { state: 'absent' }
    if (!info.isDirectory())
      return { state: 'corrupt' }
    const raw = JSON.parse(await readUtf8File(root, `${LOCK_ROOT}/owner.json`, MAX_JSON_TEXT_BYTES)) as unknown
    if (!isRecord(raw) || !exactKeys(raw, ['schema', 'runId']) || raw.schema !== LOCK_SCHEMA || typeof raw.runId !== 'string' || !UUID.test(raw.runId))
      return { state: 'corrupt' }
    return { state: 'valid', runId: raw.runId }
  }
  catch {
    return { state: 'corrupt' }
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
      return readLock(root)
    throw error
  }
  await atomicWriteJson(root, `${LOCK_ROOT}/owner.json`, { schema: LOCK_SCHEMA, runId })
  return { state: 'valid', runId }
}

async function releaseLock(root: string, runId: string): Promise<void> {
  const lock = await readLock(root)
  if (lock.state === 'valid' && lock.runId === runId) {
    const absolute = await resolveRepositoryPath(root, LOCK_ROOT)
    await fs.rm(absolute, { recursive: true })
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
  catch {
    return { state: 'invalid' }
  }
}

async function completeTreeFact(root: string, relative: string): Promise<TreeFact> {
  const fact = await treeFact(root, relative)
  if (fact.state !== 'valid')
    return fact
  const graph = await loadKnowledge(root, relative)
  return graph.contextState === 'ready' ? fact : { state: 'invalid' }
}

async function evidenceFingerprint(root: string, patterns: readonly string[]): Promise<string> {
  return aggregateSourceFingerprint(patterns, await expandSourcePatterns(root, patterns))
}

function allCodePatterns(graph: KnowledgeGraph): readonly string[] {
  return [...new Set([...graph.documents.values()].flatMap(document => document.codePaths))].sort(compareCodeUnits)
}

async function completeEvidenceFingerprint(root: string, manifest: TransactionManifest, graph: KnowledgeGraph): Promise<string> {
  const patterns = [...new Set([...manifest.evidencePaths, ...allCodePatterns(graph)])].sort(compareCodeUnits)
  return evidenceFingerprint(root, patterns)
}

async function validateBeginMode(input: TransactionBeginInput, live: KnowledgeGraph): Promise<void> {
  if (input.command === 'init') {
    if (input.mode !== 'deep')
      throw new RuntimeFault('TRANSACTION_MODE_INVALID', 'Init must use deep mode.')
    if (live.contextState !== 'absent')
      throw new RuntimeFault('TRANSACTION_PRECONDITION_FAILED', 'Init requires absent formal Context.')
  }
  else {
    if (live.contextState !== 'ready')
      throw new RuntimeFault('TRANSACTION_PRECONDITION_FAILED', `${input.command} requires ready formal Context.`)
    if (input.command === 'prune' && input.mode !== 'deep')
      throw new RuntimeFault('TRANSACTION_MODE_INVALID', 'Prune must use deep mode.')
  }
}

async function stageCandidate(root: string, runId: string, command: TransactionCommand): Promise<void> {
  const destination = await resolveRepositoryPath(root, candidatePath(runId), true)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  if (command === 'init')
    await fs.mkdir(destination)
  else
    await fs.cp(await resolveRepositoryPath(root, CONTEXT_ROOT), destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: false })
}

function lockIncomplete(activeRunId?: string, manualRecoveryRequired = false): RuntimeResponse {
  return runtimeResponse('transaction', 'incomplete', {
    data: {
      ...(activeRunId === undefined ? {} : { activeRunId }),
      ...(manualRecoveryRequired ? { manualRecoveryRequired: true } : {}),
    },
  })
}

async function transactionBegin(root: string, input: TransactionBeginInput): Promise<RuntimeResponse> {
  assertGitEvidencePath(input.gitEvidencePath)
  input.evidencePaths.forEach(assertSourcePattern)
  if (input.scope.kind === 'paths')
    input.scope.paths.forEach(assertSourcePattern)
  const currentLock = await readLock(root)
  if (currentLock.state === 'valid')
    return lockIncomplete(currentLock.runId)
  if (currentLock.state === 'corrupt')
    return lockIncomplete(undefined, true)

  const live = await loadKnowledge(root)
  await validateBeginMode(input, live)
  const git = await readGitEvidence(root, input.gitEvidencePath)
  const declaredEvidenceFingerprint = await evidenceFingerprint(root, input.evidencePaths)
  const runId = randomUUID()
  const acquired = await createLock(root, runId)
  if (acquired.state !== 'valid' || acquired.runId !== runId)
    return acquired.state === 'valid' ? lockIncomplete(acquired.runId) : lockIncomplete(undefined, true)

  try {
    await ensureDirectory(root, RUNS_ROOT)
    const directory = await resolveRepositoryPath(root, runPath(runId), true)
    await fs.mkdir(directory)
    await stageCandidate(root, runId, input.command)
    const manifest: TransactionManifest = {
      schema: TRANSACTION_SCHEMA,
      runId,
      command: input.command,
      mode: input.mode,
      dryRun: input.dryRun,
      scope: input.scope,
      phase: 'staged',
      gitEvidencePath: input.gitEvidencePath,
      evidencePaths: [...input.evidencePaths].sort(compareCodeUnits),
      snapshot: {
        contextState: live.contextState === 'absent' ? 'absent' : 'present',
        ...(live.contextFingerprint === undefined ? {} : { contextFingerprint: live.contextFingerprint }),
        declaredEvidenceFingerprint,
        gitEvidenceFingerprint: git.fingerprint,
        gitRevision: git.currentRevision,
      },
    }
    await writeManifest(root, manifest)
    return runtimeResponse('transaction', 'success', {
      data: { runId, candidatePath: candidatePath(runId), nextAction: 'edit_candidate' },
    })
  }
  catch (error) {
    if (await pathExists(root, runPath(runId)))
      await fs.rm(await resolveRepositoryPath(root, runPath(runId)), { recursive: true })
    await cleanupEvidence(root, input.gitEvidencePath)
    await releaseLock(root, runId)
    throw error
  }
}

function sourcePaths(graph: KnowledgeGraph): ReadonlySet<string> {
  return new Set([...graph.sources.values()].flatMap(files => files.map(file => file.path)))
}

function pruneCoverageIssues(live: KnowledgeGraph, candidate: KnowledgeGraph): readonly string[] {
  const before = sourcePaths(live)
  const after = sourcePaths(candidate)
  return [...before].filter(candidatePath => !after.has(candidatePath)).sort(compareCodeUnits)
}

function changesMapped(graph: KnowledgeGraph, git: GitEvidence): boolean {
  const declarations = allCodePatterns(graph)
  return git.changes.every((change) => {
    const candidates = [change.path, ...(change.previousPath === undefined ? [] : [change.previousPath])]
    return candidates.every(candidate => candidate.startsWith('context/') || candidate.startsWith('.scratch/')
      || declarations.some(declaration => declaration === candidate || (declaration.includes('*') && controlledGlobMatches(declaration, candidate))))
  })
}

function convergenceBaseline(graph: KnowledgeGraph, source: 'init' | 'prune'): ConvergenceBaseline {
  const metrics = graphMetrics(graph)
  return { source, ...metrics.current, perDomain: metrics.perDomain }
}

async function deriveMeta(root: string, manifest: TransactionManifest, graph: KnowledgeGraph, live: KnowledgeGraph, git: GitEvidence): Promise<Meta> {
  const documents: Record<string, DocumentLedger> = {}
  for (const [id, ledger] of [...graph.ledgers.entries()].sort(([left], [right]) => compareCodeUnits(left, right)))
    documents[id] = ledger
  const documentPatterns = allCodePatterns(graph)
  const repositorySourceFingerprint = await evidenceFingerprint(root, documentPatterns)
  const previousBaseline = live.meta?.repository?.baseline
  const historyComplete = previousBaseline === undefined
    || previousBaseline.revision === git.currentRevision
    || git.hasDiff
  const scopeCanAdvance = manifest.scope.kind === 'repository'
    && !git.midOperation
    && changesMapped(graph, git)
    && historyComplete
  const repository = (manifest.command === 'init' || manifest.command === 'update') && scopeCanAdvance
    ? { baseline: { revision: git.currentRevision, sourceFingerprint: repositorySourceFingerprint } }
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
  const current = await evidenceFingerprint(root, manifest.evidencePaths)
  if (current !== manifest.snapshot.declaredEvidenceFingerprint)
    throw new RuntimeFault('DECLARED_EVIDENCE_CONFLICT', 'Declared source evidence changed after transaction begin.')
}

async function cleanupRunTrees(root: string, runId: string): Promise<void> {
  for (const relative of [`${runPath(runId)}/candidate`, `${runPath(runId)}/backup`]) {
    if (await pathExists(root, relative))
      await fs.rm(await resolveRepositoryPath(root, relative), { recursive: true })
  }
}

async function cleanupEvidence(root: string, evidencePath: string): Promise<void> {
  assertGitEvidencePath(evidencePath)
  if (await pathExists(root, evidencePath))
    await fs.rm(await resolveRepositoryPath(root, evidencePath), { recursive: true })
}

async function cleanupTerminalArtifacts(root: string, manifest: TransactionManifest): Promise<void> {
  await cleanupEvidence(root, manifest.gitEvidencePath)
  await cleanupRunTrees(root, manifest.runId)
  await releaseLock(root, manifest.runId)
  if (await pathExists(root, runPath(manifest.runId)))
    await fs.rm(await resolveRepositoryPath(root, runPath(manifest.runId)), { recursive: true })
}

async function transactionValidate(root: string, input: TransactionValidateInput): Promise<RuntimeResponse> {
  let manifest = await loadManifest(root, input.runId)
  if (manifest.phase !== 'staged' && manifest.phase !== 'validated')
    throw new RuntimeFault('TRANSACTION_PHASE_INVALID', 'transaction.validate requires a staged or validated run.')
  const lock = await readLock(root)
  if (lock.state !== 'valid' || lock.runId !== manifest.runId)
    return lockIncomplete(lock.state === 'valid' ? lock.runId : undefined, lock.state === 'corrupt')
  try {
    await assertDeclaredEvidenceFresh(root, manifest)
    await assertSnapshotFresh(root, manifest)
    const git = await readGitEvidence(root, manifest.gitEvidencePath)
    const live = await loadKnowledge(root)
    const candidate = await loadKnowledge(root, candidatePath(manifest.runId), { ignoreMeta: true, requireMeta: false })
    if (candidate.contextState !== 'ready') {
      const response = runtimeResponse('transaction', 'failed', {
        diagnostics: candidate.issues.map(item => ({ code: item.code, severity: 'error', message: item.message, path: item.path })),
      })
      await cleanupTerminalArtifacts(root, manifest)
      return response
    }
    if (manifest.command === 'prune') {
      const lost = pruneCoverageIssues(live, candidate)
      if (lost.length > 0)
        throw new RuntimeFault('PRUNE_COVERAGE_LOST', 'Prune candidate loses existing source coverage.', lost[0])
    }
    const derived = await deriveMeta(root, manifest, candidate, live, git)
    await atomicWriteJson(root, `${candidatePath(manifest.runId)}/meta.json`, JSON.parse(serializeMeta(derived)) as JsonValue)
    const validated = await loadKnowledge(root, candidatePath(manifest.runId))
    if (validated.contextState !== 'ready') {
      const response = runtimeResponse('transaction', 'failed', {
        diagnostics: validated.issues.map(item => ({ code: item.code, severity: 'error', message: item.message, path: item.path })),
      })
      await cleanupTerminalArtifacts(root, manifest)
      return response
    }
    const candidateFingerprint = validated.contextFingerprint as string
    const sourceEvidenceFingerprint = await completeEvidenceFingerprint(root, manifest, validated)
    await assertSnapshotFresh(root, manifest)
    const { approval: _approval, ...manifestWithoutApproval } = manifest
    manifest = {
      ...manifestWithoutApproval,
      phase: 'validated',
      candidateFingerprint,
      sourceEvidenceFingerprint,
    }
    if (manifest.snapshot.contextState === 'present' && candidateFingerprint === manifest.snapshot.contextFingerprint) {
      manifest = { ...manifest, phase: 'committed' }
      await writeManifest(root, manifest)
      const response = runtimeResponse('transaction', 'no_change', {
        data: { runId: manifest.runId, outcome: 'no_change', contextFingerprint: candidateFingerprint },
      })
      await cleanupTerminalArtifacts(root, manifest)
      return response
    }
    await writeManifest(root, manifest)
    if (manifest.dryRun) {
      const response = runtimeResponse('transaction', 'dry_run', {
        data: { runId: manifest.runId, outcome: 'validated', candidateFingerprint, sourceEvidenceFingerprint },
      })
      await cleanupTerminalArtifacts(root, manifest)
      return response
    }
    return runtimeResponse('transaction', 'success', {
      data: { runId: manifest.runId, candidateFingerprint, sourceEvidenceFingerprint, nextAction: 'semantic_review' },
    })
  }
  catch (error) {
    await cleanupTerminalArtifacts(root, manifest)
    throw error
  }
}

async function validatedFacts(root: string, manifest: TransactionManifest): Promise<{ readonly graph: KnowledgeGraph, readonly candidateFingerprint: string, readonly sourceEvidenceFingerprint: string }> {
  const graph = await loadKnowledge(root, candidatePath(manifest.runId))
  if (graph.contextState !== 'ready' || graph.contextFingerprint === undefined)
    throw new RuntimeFault('CANDIDATE_INVALID', 'The transaction candidate is not a complete valid Context tree.')
  return {
    graph,
    candidateFingerprint: graph.contextFingerprint,
    sourceEvidenceFingerprint: await completeEvidenceFingerprint(root, manifest, graph),
  }
}

function approvalMatches(manifest: TransactionManifest, approval: TransactionApproval, facts: { readonly candidateFingerprint: string, readonly sourceEvidenceFingerprint: string }): boolean {
  return approval.approved === true
    && approval.candidateFingerprint === manifest.candidateFingerprint
    && approval.sourceEvidenceFingerprint === manifest.sourceEvidenceFingerprint
    && approval.candidateFingerprint === facts.candidateFingerprint
    && approval.sourceEvidenceFingerprint === facts.sourceEvidenceFingerprint
}

async function finalizeCommitted(root: string, manifest: TransactionManifest, recovery?: TransactionManifest['recovery']): Promise<RuntimeResponse> {
  const live = await treeFact(root, CONTEXT_ROOT)
  if (live.state !== 'valid' || live.fingerprint !== manifest.candidateFingerprint)
    throw new RuntimeFault('FINAL_VERIFICATION_FAILED', 'Committed Context does not match the approved candidate.')
  const contextFingerprint = live.fingerprint
  const graph = await loadKnowledge(root)
  if (graph.contextState !== 'ready')
    throw new RuntimeFault('FINAL_VERIFICATION_FAILED', 'Committed Context failed final schema or graph verification.')
  const committed: TransactionManifest = { ...manifest, phase: 'committed', ...(recovery === undefined ? {} : { recovery }) }
  await writeManifest(root, committed)
  const response = runtimeResponse('transaction', 'success', {
    data: {
      runId: manifest.runId,
      outcome: recovery?.outcome ?? 'committed',
      contextFingerprint,
      ...(manifest.approval === undefined
        ? {}
        : {
            approvedCandidateFingerprint: manifest.approval.candidateFingerprint,
            approvedSourceEvidenceFingerprint: manifest.approval.sourceEvidenceFingerprint,
          }),
    },
  })
  await cleanupTerminalArtifacts(root, committed)
  return response
}

async function directorySwitch(root: string, manifest: TransactionManifest): Promise<RuntimeResponse> {
  const candidateAbsolute = await resolveRepositoryPath(root, candidatePath(manifest.runId))
  const liveAbsolute = await resolveRepositoryPath(root, CONTEXT_ROOT, true)
  if (manifest.snapshot.contextState === 'present') {
    const backupAbsolute = await resolveRepositoryPath(root, backupPath(manifest.runId), true)
    await fs.mkdir(path.dirname(backupAbsolute), { recursive: true })
    await fs.rename(liveAbsolute, backupAbsolute)
  }
  await fs.rename(candidateAbsolute, liveAbsolute)
  return finalizeCommitted(root, manifest)
}

async function markRecovery(
  root: string,
  manifest: TransactionManifest,
  phase: 'failed' | 'recovery_required' | 'restored',
  outcome: NonNullable<TransactionManifest['recovery']>['outcome'],
): Promise<TransactionManifest> {
  const updated: TransactionManifest = { ...manifest, phase, recovery: { outcome } }
  await writeManifest(root, updated)
  return updated
}

async function recoverCommitting(root: string, manifest: TransactionManifest): Promise<RuntimeResponse> {
  const [live, candidate, backup] = await Promise.all([
    completeTreeFact(root, CONTEXT_ROOT),
    completeTreeFact(root, candidatePath(manifest.runId)),
    completeTreeFact(root, backupPath(manifest.runId)),
  ])
  if (live.state === 'valid' && live.fingerprint === manifest.candidateFingerprint)
    return finalizeCommitted(root, manifest, { outcome: 'candidate_completed' })

  const liveIsSnapshot = manifest.snapshot.contextState === 'absent'
    ? live.state === 'absent'
    : live.state === 'valid' && live.fingerprint === manifest.snapshot.contextFingerprint
  const candidateIsApproved = candidate.state === 'valid' && candidate.fingerprint === manifest.candidateFingerprint
  if (liveIsSnapshot && candidateIsApproved && backup.state === 'absent')
    return directorySwitch(root, manifest)

  const backupIsSnapshot = manifest.snapshot.contextState === 'present'
    && backup.state === 'valid'
    && backup.fingerprint === manifest.snapshot.contextFingerprint
  if ((live.state === 'absent' || live.state === 'invalid') && backupIsSnapshot) {
    if (live.state === 'invalid')
      await fs.rm(path.join(root, CONTEXT_ROOT), { recursive: true })
    await fs.rename(await resolveRepositoryPath(root, backupPath(manifest.runId)), await resolveRepositoryPath(root, CONTEXT_ROOT, true))
    const restored = await markRecovery(root, manifest, 'restored', 'backup_restored')
    const response = runtimeResponse('transaction', 'failed', {
      data: { runId: manifest.runId, outcome: 'backup_restored', contextFingerprint: manifest.snapshot.contextFingerprint },
    })
    await cleanupTerminalArtifacts(root, restored)
    return response
  }

  const completeFacts = [live, candidate, backup].filter(fact => fact.state === 'valid')
  if (completeFacts.length > 0) {
    await markRecovery(root, manifest, 'recovery_required', 'manual_required')
    return runtimeResponse('transaction', 'incomplete', {
      data: { runId: manifest.runId, outcome: 'manual_recovery', manualRecoveryRequired: true },
    })
  }
  await markRecovery(root, manifest, 'recovery_required', 'no_trusted_copy')
  return runtimeResponse('transaction', 'failed', {
    data: { runId: manifest.runId, outcome: 'no_trusted_copy', manualRecoveryRequired: true },
  })
}

async function transactionCommit(root: string, input: TransactionCommitInput): Promise<RuntimeResponse> {
  let manifest = await loadManifest(root, input.runId)
  if (manifest.phase !== 'validated')
    throw new RuntimeFault('TRANSACTION_PHASE_INVALID', 'transaction.commit requires a validated run.')
  let facts: Awaited<ReturnType<typeof validatedFacts>>
  try {
    facts = await validatedFacts(root, manifest)
    await assertSnapshotFresh(root, manifest)
  }
  catch {
    return runtimeResponse('transaction', 'incomplete', {
      data: { runId: manifest.runId, outcome: 'stale', nextAction: 'validate' },
    })
  }
  if (facts.candidateFingerprint !== manifest.candidateFingerprint
    || facts.sourceEvidenceFingerprint !== manifest.sourceEvidenceFingerprint) {
    return runtimeResponse('transaction', 'incomplete', {
      data: { runId: manifest.runId, outcome: 'stale', nextAction: 'validate' },
    })
  }
  if (!approvalMatches(manifest, input.approval, facts)) {
    return runtimeResponse('transaction', 'incomplete', {
      data: { runId: manifest.runId, outcome: 'approval_mismatch', nextAction: 'semantic_review' },
      diagnostics: [diagnostic('APPROVAL_MISMATCH', 'Semantic approval does not match current candidate and source evidence.')],
    })
  }
  if (manifest.dryRun) {
    const lock = await readLock(root)
    if (lock.state !== 'valid' || lock.runId !== manifest.runId)
      return lockIncomplete(lock.state === 'valid' ? lock.runId : undefined, lock.state === 'corrupt')
    const response = runtimeResponse('transaction', 'dry_run', {
      data: {
        runId: manifest.runId,
        outcome: 'validated',
        candidateFingerprint: manifest.candidateFingerprint as string,
        sourceEvidenceFingerprint: manifest.sourceEvidenceFingerprint as string,
      },
    })
    await cleanupTerminalArtifacts(root, manifest)
    return response
  }
  const lock = await readLock(root)
  if (lock.state !== 'valid' || lock.runId !== manifest.runId)
    return lockIncomplete(lock.state === 'valid' ? lock.runId : undefined, lock.state === 'corrupt')
  manifest = { ...manifest, phase: 'committing', approval: input.approval }
  await writeManifest(root, manifest)
  try {
    return await directorySwitch(root, manifest)
  }
  catch {
    return recoverCommitting(root, manifest)
  }
}

async function acquireResumeLock(root: string, manifest: TransactionManifest): Promise<LockFact> {
  const lock = await readLock(root)
  if (lock.state === 'absent')
    return createLock(root, manifest.runId)
  return lock
}

async function resumeFreshness(root: string, manifest: TransactionManifest): Promise<RuntimeResponse> {
  try {
    await assertSnapshotFresh(root, manifest)
    await assertDeclaredEvidenceFresh(root, manifest)
    const git = await readGitEvidence(root, manifest.gitEvidencePath)
    if (git.fingerprint !== manifest.snapshot.gitEvidenceFingerprint)
      throw new RuntimeFault('GIT_EVIDENCE_CONFLICT', 'Git evidence changed after transaction begin.')
  }
  catch {
    return runtimeResponse('transaction', 'incomplete', {
      data: { runId: manifest.runId, outcome: 'stale', nextAction: 'regenerate_candidate' },
    })
  }
  if (manifest.phase === 'staged')
    return runtimeResponse('transaction', 'success', { data: { runId: manifest.runId, outcome: 'ready', nextAction: 'edit_candidate' } })

  try {
    const facts = await validatedFacts(root, manifest)
    if (facts.candidateFingerprint !== manifest.candidateFingerprint
      || facts.sourceEvidenceFingerprint !== manifest.sourceEvidenceFingerprint) {
      return runtimeResponse('transaction', 'incomplete', {
        data: { runId: manifest.runId, outcome: 'stale', nextAction: 'validate' },
      })
    }
  }
  catch {
    return runtimeResponse('transaction', 'incomplete', {
      data: { runId: manifest.runId, outcome: 'stale', nextAction: 'regenerate_candidate' },
    })
  }
  return runtimeResponse('transaction', 'success', {
    data: { runId: manifest.runId, outcome: 'ready', nextAction: 'semantic_review' },
  })
}

async function terminalResume(root: string, manifest: TransactionManifest): Promise<RuntimeResponse> {
  let response: RuntimeResponse
  if (manifest.phase === 'committed') {
    const noChange = manifest.snapshot.contextState === 'present'
      && manifest.snapshot.contextFingerprint === manifest.candidateFingerprint
    response = runtimeResponse('transaction', noChange ? 'no_change' : 'success', {
      data: { runId: manifest.runId, outcome: noChange ? 'no_change' : manifest.recovery?.outcome ?? 'committed', contextFingerprint: manifest.candidateFingerprint as string },
    })
  }
  else {
    response = runtimeResponse('transaction', 'failed', {
      data: { runId: manifest.runId, outcome: manifest.recovery?.outcome ?? manifest.phase },
    })
  }
  await cleanupTerminalArtifacts(root, manifest)
  return response
}

async function transactionResume(root: string, input: TransactionResumeInput): Promise<RuntimeResponse> {
  const manifest = await loadManifest(root, input.runId)
  if (manifest.phase === 'committing' || manifest.phase === 'recovery_required') {
    const lock = await acquireResumeLock(root, manifest)
    if (lock.state !== 'valid' || lock.runId !== manifest.runId)
      return lockIncomplete(lock.state === 'valid' ? lock.runId : undefined, lock.state === 'corrupt')
    return recoverCommitting(root, manifest)
  }
  if (manifest.phase === 'committed' || manifest.phase === 'restored' || manifest.phase === 'failed')
    return terminalResume(root, manifest)
  const lock = await acquireResumeLock(root, manifest)
  if (lock.state !== 'valid' || lock.runId !== manifest.runId)
    return lockIncomplete(lock.state === 'valid' ? lock.runId : undefined, lock.state === 'corrupt')
  if (manifest.dryRun && manifest.phase === 'validated') {
    const response = runtimeResponse('transaction', 'dry_run', {
      data: {
        runId: manifest.runId,
        outcome: 'validated',
        candidateFingerprint: manifest.candidateFingerprint as string,
        sourceEvidenceFingerprint: manifest.sourceEvidenceFingerprint as string,
      },
    })
    await cleanupTerminalArtifacts(root, manifest)
    return response
  }
  return resumeFreshness(root, manifest)
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
