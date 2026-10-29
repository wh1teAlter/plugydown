import type { ConfirmationRecord } from './confirmation.js'
import type { ContextDocument, ConvergenceBaseline, DocumentLedger, MetadataManifest } from './document.js'
import type { KnowledgeGraph } from './graph.js'
import type { Diagnostic, RuntimeRequest, RuntimeResponse, Scope, TransactionApproval, TransactionBeginInput, TransactionCommand, TransactionCommitInput, TransactionMode, TransactionResumeInput, TransactionValidateInput } from './protocol.js'
import type { GitEvidence, SourceExpansionResult, TreeFile } from './repository.js'
import type { RetentionSummary } from './retention.js'
import type { JsonValue } from './stable-json.js'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { confirmationKey, parseConfirmation, readConfirmationStore } from './confirmation.js'
import { bodyFingerprint, frontMatterFingerprint, serializeMetadataManifest, sourceFingerprint } from './document.js'
import { graphMetrics, loadKnowledge } from './graph.js'
import { planLegacyMigration } from './migration.js'
import { diagnostic, FORMAT, isRecord, RuntimeFault, sha256, transactionResponse } from './protocol.js'
import { assertGitEvidencePath, assertSourcePattern, CONTEXT_ROOT, declarationMatches, expandSourcePatternSets, filesystemOperation, fingerprintTree, LOCK_KIND, LOCK_ROOT, lstatRepositoryPath, MAX_JSON_TEXT_BYTES, readGitEvidence, readLockOwner, readTree, readUtf8File, resolveRepositoryPath, resolveRepositoryRoot, RUNS_ROOT, SCRATCH_ROOT, throwFilesystemFault } from './repository.js'
import { planRetention } from './retention.js'
import { compareCodeUnits, stableJson } from './stable-json.js'

// 事务清单的持久格式标识。
const TRANSACTION_KIND = 'plugydown.context.transaction'
// Runtime 事务 UUID v4 的格式校验规则。
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
// 持久事务指纹的 64 位小写十六进制格式。
const HASH = /^[a-f0-9]{64}$/
// 允许 SHA-1 或 SHA-256 Git 对象 ID 的校验规则。
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
// 领域 ID 的小写 kebab-case 校验规则。
const DOMAIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// 允许点分层级的稳定文档 ID 校验规则。
const DOCUMENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/

/** 持久事务清单记录的生命周期阶段。 */
export type TransactionPhase
  = | 'staged'
    | 'validated'
    | 'committing'
    | 'committed'
    | 'restored'
    | 'recovery_required'
    | 'failed'

/** 集中清理在 begin 冻结的删除计划与来源、权限证据。 */
interface CompactBasis {
  /** 仅可从候选删除的完整确认 key。 */
  readonly removedKeys: readonly string[]
  /** begin 冻结的完整来源证据，不因重新验证推进。 */
  readonly sourceEvidenceFingerprint: string
  /** 原始树的路径及 POSIX 权限摘要。 */
  readonly originalModesFingerprint: string
  /** 计划保留路径的 POSIX 权限摘要，供切换与恢复复验。 */
  readonly retainedModesFingerprint: string
  /** 同一冻结计划的公开统计。 */
  readonly summary: RetentionSummary
}

/** 事务建立时冻结的身份、授权和快照，所有后续阶段共享这些事实。 */
interface ManifestBase {
  /** 仅 compact 使用；旧 Runtime 会拒绝未知命令，不接管清理事务。 */
  readonly compact?: CompactBasis
  /** 持久事务清单格式标识。 */
  readonly kind: typeof TRANSACTION_KIND
  /** 与公开协议共用的兼容代号。 */
  readonly format: typeof FORMAT
  /** 本 run 曾生成的记录身份，崩溃与重验证时只允许清理这些新增文件。 */
  readonly derivedConfirmationKeys: readonly string[]
  /** 本 run 曾生成的入口字节摘要，避免把人工篡改视为 Runtime 所有物。 */
  readonly derivedMetadataFingerprints: readonly string[]
  /** 仅 migrate 使用，begin 后不可修改。 */
  readonly migrationStrategy?: 'import-trusted' | 'reconfirm'
  /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
  readonly runId: string
  /** 事务所属工作流，在 begin 时固定。 */
  readonly command: TransactionCommand
  /** 事务在 begin 时冻结的 Light/Deep 语义审查深度。 */
  readonly mode: TransactionMode
  /** 为 true 时验证后结束并清理，不切换正式 Context。 */
  readonly dryRun: boolean
  /** 调用方授予的作用范围，在事务开始后固定。 */
  readonly scope: Scope
  /** 本次工作流拥有的 .scratch/evidence/ 直接子目录。 */
  readonly gitEvidencePath: string
  /** 宿主显式补充的仓库相对证据声明，事务期间必须保持新鲜。 */
  readonly evidencePaths: readonly string[]
  /** 调用方已对照当前源码复核且确认准确的文档 ID，仅 Update 可用。 */
  readonly confirmedDocumentIds?: readonly string[]
  /** begin 阶段冻结的正式知识、Git 和显式证据快照。 */
  readonly snapshot: {
    /** begin 时正式 Context 是否存在，用于区分 Init 与更新流程。 */
    readonly contextState: 'absent' | 'present'
    /** 完整正式或候选 Context 文件树的 SHA-256 指纹。 */
    readonly contextFingerprint?: string
    /** begin 时宿主显式证据的整体 SHA-256 指纹。 */
    readonly declaredEvidenceFingerprint: string
    /** begin 时 Git 原始证据文件集合的 SHA-256 指纹。 */
    readonly gitEvidenceFingerprint: string
    /** begin 时宿主证据中的 HEAD 对象 ID。 */
    readonly gitRevision: string
  }
}

/** 候选通过验证后才存在的内容指纹与源码证据指纹。 */
interface ValidatedPair {
  /** 已验证候选完整目录树的 SHA-256 指纹。 */
  readonly candidateFingerprint: string
  /** 当前候选引用源码与显式证据的整体 SHA-256 指纹。 */
  readonly sourceEvidenceFingerprint: string
}

/** 按阶段约束可用字段的事务清单，防止批准与恢复事实出现在错误阶段。 */
type TransactionManifest
  = | ManifestBase & { readonly phase: 'staged' }
    | ManifestBase & ValidatedPair & { readonly phase: 'validated' }
    | ManifestBase & ValidatedPair & {
      readonly phase: 'committing'
      /** 对当前已验证候选与源码证据的显式批准。 */
      readonly approval: TransactionApproval
      /** 已持久化的恢复意图或结局，不能被不相关分支覆盖。 */
      readonly recovery?: { readonly intent: 'restore_backup' }
    }
    | ManifestBase & ValidatedPair & {
      readonly phase: 'committed'
      /** 对当前已验证候选与源码证据的显式批准。 */
      readonly approval: TransactionApproval
      /** 已持久化的恢复意图或结局，不能被不相关分支覆盖。 */
      readonly recovery?: { readonly outcome: 'candidate_completed' }
    }
    | ManifestBase & ValidatedPair & {
      readonly phase: 'restored'
      /** 对当前已验证候选与源码证据的显式批准。 */
      readonly approval: TransactionApproval
      /** 已持久化的恢复意图或结局，不能被不相关分支覆盖。 */
      readonly recovery: { readonly outcome: 'backup_restored' }
    }
    | ManifestBase & ValidatedPair & {
      readonly phase: 'recovery_required'
      /** 对当前已验证候选与源码证据的显式批准。 */
      readonly approval: TransactionApproval
      /** 已持久化的恢复意图或结局，不能被不相关分支覆盖。 */
      readonly recovery: { readonly outcome: 'manual_recovery' }
    }
    | ManifestBase & ValidatedPair & {
      readonly phase: 'failed'
      /** 对当前已验证候选与源码证据的显式批准。 */
      readonly approval: TransactionApproval
      /** 已持久化的恢复意图或结局，不能被不相关分支覆盖。 */
      readonly recovery: { readonly outcome: 'no_trusted_copy' }
    }

/** 恢复流程可能得到的完成、回退或人工处理结果。 */
type RecoveryOutcome = 'candidate_completed' | 'backup_restored' | 'manual_recovery' | 'no_trusted_copy'

/** 已经通过候选验证并持有两个指纹的事务。 */
type ValidatedManifest = Extract<TransactionManifest, ValidatedPair>

/** 携带显式批准、可进入提交或恢复分支的事务。 */
type ApprovedManifest = Extract<TransactionManifest, {
  /** 对当前已验证候选与源码证据的显式批准。 */
  approval: TransactionApproval
}>

/** 判断事务是否已持久记录回退意图。 */
function hasRestoreIntent(manifest: TransactionManifest): boolean {
  return manifest.phase === 'committing' && manifest.recovery !== undefined
}

/** 从已验证事务中提取批准必须绑定的两个指纹。 */
function validatedPair(manifest: ValidatedManifest): ValidatedPair {
  return {
    candidateFingerprint: manifest.candidateFingerprint,
    sourceEvidenceFingerprint: manifest.sourceEvidenceFingerprint,
  }
}

/** 去除阶段性验证、批准与恢复事实，仅保留事务建立时冻结的基础事实。 */
function baseFacts(manifest: TransactionManifest): ManifestBase {
  return {
    kind: manifest.kind,
    ...(manifest.compact === undefined ? {} : { compact: manifest.compact }),
    format: manifest.format,
    derivedConfirmationKeys: manifest.derivedConfirmationKeys,
    derivedMetadataFingerprints: manifest.derivedMetadataFingerprints,
    ...(manifest.migrationStrategy === undefined ? {} : { migrationStrategy: manifest.migrationStrategy }),
    runId: manifest.runId,
    command: manifest.command,
    mode: manifest.mode,
    dryRun: manifest.dryRun,
    scope: manifest.scope,
    gitEvidencePath: manifest.gitEvidencePath,
    evidencePaths: manifest.evidencePaths,
    ...(manifest.confirmedDocumentIds === undefined ? {} : { confirmedDocumentIds: manifest.confirmedDocumentIds }),
    snapshot: manifest.snapshot,
  }
}

/** 文件树的可读取性与精确字节指纹，不代表知识结构已通过校验。 */
type TreeFact
  = | { readonly state: 'absent' }
    | {
      readonly state: 'valid'
      /** 所描述数据集的确定性 SHA-256 指纹。 */
      readonly fingerprint: string
    }
    | { readonly state: 'invalid' }

/** 写锁及其引用清单的可用状态，区分有效、损坏和孤立所有者。 */
type LockFact
  = | { readonly state: 'absent' }
    | {
      readonly state: 'valid'
      /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
      readonly runId: string
    }
    | { readonly state: 'corrupt' }
    | {
      readonly state: 'orphan'
      /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
      readonly runId?: string
    }

/** 计算指定事务在 runs/ 下拥有的叶子路径。 */
function runPath(runId: string): string {
  return `${RUNS_ROOT}/${runId}`
}

/** 计算事务持久清单的仓库相对路径。 */
function manifestPath(runId: string): string {
  return `${runPath(runId)}/manifest.json`
}

/** 计算事务完整候选 Context 的仓库相对路径。 */
function candidatePath(runId: string): string {
  return `${runPath(runId)}/candidate/context`
}

/** 计算目录切换时保存原始 Context 的备份路径。 */
function backupPath(runId: string): string {
  return `${runPath(runId)}/backup/context`
}

/** 检查对象是否只包含必填和允许的可选字段。 */
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  // 必填字段与可选字段组成的完整允许集合。
  const expected = new Set([...required, ...optional])
  return required.every(key => key in value) && Object.keys(value).every(key => expected.has(key))
}

/** 校验持久清单中的授权范围，拒绝非法身份或路径模式。 */
function validScope(value: unknown): value is Scope {
  if (!isRecord(value) || typeof value.kind !== 'string')
    return false
  if (value.kind === 'repository')
    return exactKeys(value, ['kind'])
  if (value.kind === 'domains' || value.kind === 'documents') {
    // 根据授权范围选择的领域或文档 ID 格式规则。
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

/** 校验持久批准的布尔值、指纹与摘要；不合法时返回 undefined。 */
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

/** 以统一错误终止阶段事实不一致的事务清单解析。 */
function inconsistent(): never {
  throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'The transaction manifest phase facts are inconsistent.')
}

/** 解析唯一合法的回退意图或恢复结果。 */
function parseRecovery(value: unknown): { readonly intent: 'restore_backup' } | {
  /** 事务具体结局，决定响应状态、后续动作及清理策略。 */
  readonly outcome: RecoveryOutcome
} | undefined {
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

/** 严格解析集中清理的冻结证据，不接受额外字段或不一致计数。 */
function parseCompactBasis(value: unknown): CompactBasis {
  if (!isRecord(value) || !exactKeys(value, ['removedKeys', 'sourceEvidenceFingerprint', 'originalModesFingerprint', 'retainedModesFingerprint', 'summary'])
    || !validHashes(value.removedKeys)
    || ![value.sourceEvidenceFingerprint, value.originalModesFingerprint, value.retainedModesFingerprint].every(item => typeof item === 'string' && HASH.test(item))
    || !isRecord(value.summary)
    || !exactKeys(value.summary, ['beforeCount', 'afterCount', 'removedCount', 'activeIdentityCount', 'retiredIdentityCount', 'triggered', 'planFingerprint'])
    || !['beforeCount', 'afterCount', 'removedCount', 'activeIdentityCount', 'retiredIdentityCount'].every(key => Number.isSafeInteger((value.summary as Record<string, unknown>)[key]) && Number((value.summary as Record<string, unknown>)[key]) >= 0)
    || typeof value.summary.triggered !== 'boolean'
    || typeof value.summary.planFingerprint !== 'string' || !HASH.test(value.summary.planFingerprint)
    || value.summary.removedCount !== value.removedKeys.length
    || Number(value.summary.beforeCount) !== Number(value.summary.afterCount) + Number(value.summary.removedCount)) {
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'The compact basis is invalid.')
  }
  return value as unknown as CompactBasis
}

/** 严格解析事务清单并检查阶段、快照与批准的交叉约束。 */
function parseManifest(value: unknown): TransactionManifest {
  if (!isRecord(value) || !exactKeys(
    value,
    ['kind', 'format', 'derivedConfirmationKeys', 'derivedMetadataFingerprints', 'runId', 'command', 'mode', 'dryRun', 'scope', 'phase', 'gitEvidencePath', 'evidencePaths', 'snapshot'],
    ['migrationStrategy', 'confirmedDocumentIds', 'candidateFingerprint', 'sourceEvidenceFingerprint', 'approval', 'recovery', 'compact'],
  )
  || value.kind !== TRANSACTION_KIND || value.format !== FORMAT
  || !validHashes(value.derivedConfirmationKeys) || !validHashes(value.derivedMetadataFingerprints)
  || typeof value.runId !== 'string' || !UUID.test(value.runId)
  || (value.command !== 'init' && value.command !== 'update' && value.command !== 'prune' && value.command !== 'migrate' && value.command !== 'compact')
  || (value.mode !== 'light' && value.mode !== 'deep')
  || typeof value.dryRun !== 'boolean'
  || !validScope(value.scope)
  || !['staged', 'validated', 'committing', 'committed', 'restored', 'recovery_required', 'failed'].includes(String(value.phase))
  || typeof value.gitEvidencePath !== 'string'
  || !Array.isArray(value.evidencePaths) || value.evidencePaths.some(item => typeof item !== 'string')
  || (value.confirmedDocumentIds !== undefined && (!Array.isArray(value.confirmedDocumentIds)
    || value.confirmedDocumentIds.length === 0
    || value.confirmedDocumentIds.some(item => typeof item !== 'string' || !DOCUMENT_ID.test(item))
    || new Set(value.confirmedDocumentIds as string[]).size !== value.confirmedDocumentIds.length))
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
  if (value.command === 'migrate'
    ? (value.mode !== 'deep' || value.scope.kind !== 'repository'
      || value.confirmedDocumentIds !== undefined || value.snapshot.contextState !== 'present'
      || !['import-trusted', 'reconfirm'].includes(String(value.migrationStrategy)))
    : value.migrationStrategy !== undefined) {
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'Migration requires explicit strategy, deep mode and repository scope.')
  }
  if (value.confirmedDocumentIds !== undefined && value.command !== 'update')
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'Only Update can confirm existing Documents.')
  if (value.command === 'compact'
    ? value.mode !== 'deep' || value.scope.kind !== 'repository' || value.snapshot.contextState !== 'present' || value.compact === undefined
    : value.compact !== undefined) {
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'Only a deep repository compact run carries a compact basis.')
  }
  if (new Set(value.evidencePaths as string[]).size !== value.evidencePaths.length)
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'Transaction evidence paths must be unique.')
  try {
    assertGitEvidencePath(value.gitEvidencePath)
    ;(value.evidencePaths as string[]).forEach(assertSourcePattern)
  }
  catch {
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'Transaction evidence paths are invalid.')
  }
  // 从清单读取或本次请求提供的显式批准。
  const approval = value.approval === undefined ? undefined : parseApproval(value.approval)
  if (value.approval !== undefined && approval === undefined)
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'The transaction approval is invalid.')
  if (approval !== undefined && (approval.candidateFingerprint !== value.candidateFingerprint
    || approval.sourceEvidenceFingerprint !== value.sourceEvidenceFingerprint)) {
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'The transaction approval is not bound to validated fingerprints.')
  }
  // 持久记录的回退意图或恢复结局。
  const recovery = parseRecovery(value.recovery)
  // 当前清单的生命周期阶段。
  const phase = value.phase as TransactionPhase
  if (value.dryRun === true && phase !== 'staged' && phase !== 'validated')
    inconsistent()

  // 已通过交叉校验的事务基础事实。
  const base: ManifestBase = {
    kind: TRANSACTION_KIND,
    ...(value.command === 'compact' ? { compact: parseCompactBasis(value.compact) } : {}),
    format: FORMAT,
    derivedConfirmationKeys: value.derivedConfirmationKeys as string[],
    derivedMetadataFingerprints: value.derivedMetadataFingerprints as string[],
    ...(value.migrationStrategy === undefined ? {} : { migrationStrategy: value.migrationStrategy as 'import-trusted' | 'reconfirm' }),
    runId: value.runId,
    command: value.command,
    mode: value.mode,
    dryRun: value.dryRun,
    scope: value.scope,
    gitEvidencePath: value.gitEvidencePath,
    evidencePaths: value.evidencePaths as string[],
    ...(value.confirmedDocumentIds === undefined ? {} : { confirmedDocumentIds: value.confirmedDocumentIds as string[] }),
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
  // 已验证候选及源码证据的两项绑定指纹。
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
  // 当前终态阶段必须对应的恢复结局。
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

/** 在安全解析的仓库路径下创建所需目录。 */
async function ensureDirectory(root: string, relative: string): Promise<void> {
  // 通过仓库边界检查的绝对路径，仅用于内部文件操作。
  const absolute = await resolveRepositoryPath(root, relative, true)
  await filesystemOperation(() => fs.mkdir(absolute, { recursive: true }).then(() => undefined), relative)
}

/** 通过同目录临时文件和重命名替换 JSON，失败时清理本次临时叶子。 */
async function atomicWriteJson(root: string, relative: string, value: JsonValue, mode = 0o600): Promise<void> {
  // 通过仓库边界检查的绝对路径，仅用于内部文件操作。
  const absolute = await resolveRepositoryPath(root, relative, true)
  await filesystemOperation(() => fs.mkdir(path.dirname(absolute), { recursive: true }).then(() => undefined), relative)
  // 同目录原子写入临时文件，由当前操作独占并负责清理。
  const temporary = `${absolute}.tmp`
  try {
    // 通过 lstat 取得的文件类型、权限和大小，避免隐式跟随链接。
    const info = await fs.lstat(temporary)
    if (!info.isFile() || info.isSymbolicLink())
      throw new RuntimeFault('TRANSACTION_TEMP_INVALID', 'An atomic transaction temporary path is unsafe.')
    await filesystemOperation(() => fs.rm(temporary), relative)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throwFilesystemFault(error, relative)
  }
  await filesystemOperation(() => fs.writeFile(temporary, stableJson(value), { flag: 'wx', mode }).then(() => undefined), relative)
  await filesystemOperation(() => fs.chmod(temporary, mode), relative)
  await filesystemOperation(() => fs.rename(temporary, absolute), relative)
}

/** 原子持久化事务当前阶段及其事实。 */
async function writeManifest(root: string, manifest: TransactionManifest): Promise<void> {
  if (Buffer.byteLength(stableJson(manifest as unknown as JsonValue)) > MAX_JSON_TEXT_BYTES)
    throw new RuntimeFault('TRANSACTION_MANIFEST_TOO_LARGE', 'The transaction manifest exceeds its read limit.')
  await atomicWriteJson(root, manifestPath(manifest.runId), manifest as unknown as JsonValue)
}

/** 安全读取并严格解析指定事务的持久清单。 */
async function loadManifest(root: string, runId: string): Promise<TransactionManifest> {
  if (!UUID.test(runId))
    throw new RuntimeFault('RUN_ID_INVALID', 'runId must be a Runtime-generated UUID.')
  // 本次安全读取的 UTF-8 文本。
  const text = await readUtf8File(root, manifestPath(runId), MAX_JSON_TEXT_BYTES)
  // 从持久文件或未校验输入取得的原始数据。
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  }
  catch (error) {
    if (error instanceof SyntaxError)
      throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'The transaction manifest cannot be decoded.')
    throw error
  }
  // 已解析的事务阶段、冻结输入和恢复事实。
  const manifest = parseManifest(raw)
  if (manifest.runId !== runId)
    throw new RuntimeFault('TRANSACTION_MANIFEST_INVALID', 'The transaction manifest identity does not match its run directory.')
  return manifest
}

/** 结合所有者与清单判断写锁是否可继续、已损坏或已孤立。 */
async function classifyLock(root: string): Promise<LockFact> {
  // 当前仓库写锁的所有者状态。
  const lock = await readLockOwner(root)
  if (lock.state !== 'valid')
    return lock
  try {
    // 已解析的事务阶段、冻结输入和恢复事实。
    const manifest = await loadManifest(root, lock.runId)
    return manifest.runId === lock.runId ? lock : { state: 'orphan', runId: lock.runId }
  }
  catch (error) {
    if (error instanceof RuntimeFault)
      return { state: 'orphan', runId: lock.runId }
    throw error
  }
}

/** 用原子目录创建争取唯一写锁，并持久保存所有者身份。 */
async function createLock(root: string, runId: string): Promise<LockFact> {
  await ensureDirectory(root, `${SCRATCH_ROOT}/locks`)
  // 通过仓库边界检查的绝对路径，仅用于内部文件操作。
  const absolute = await resolveRepositoryPath(root, LOCK_ROOT, true)
  try {
    await fs.mkdir(absolute)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      return classifyLock(root)
    throwFilesystemFault(error, LOCK_ROOT)
  }
  await atomicWriteJson(root, `${LOCK_ROOT}/owner.json`, { kind: LOCK_KIND, format: FORMAT, runId })
  return { state: 'valid', runId }
}

/** 仅删除仍属于当前事务的写锁。 */
async function releaseLock(root: string, runId: string): Promise<void> {
  // 当前仓库写锁的所有者状态。
  const lock = await readLockOwner(root)
  if (lock.state === 'valid' && lock.runId === runId) {
    // 通过仓库边界检查的绝对路径，仅用于内部文件操作。
    const absolute = await resolveRepositoryPath(root, LOCK_ROOT)
    await filesystemOperation(() => fs.rm(absolute, { recursive: true }), LOCK_ROOT)
  }
}

/** 读取安全目录树的精确指纹，将已知路径损坏归为不可用。 */
async function treeFact(root: string, relative: string): Promise<TreeFact> {
  try {
    // 通过 lstat 取得的文件类型、权限和大小，避免隐式跟随链接。
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

/** 事务当前候选所引用的源码展开结果、所有权映射和批准指纹。 */
interface TransactionSourceFacts {
  /** 事务当前候选及显式声明的源码展开结果。 */
  readonly expansion: SourceExpansionResult
  /** 本次源码读取计算出的当前指纹，与持久 meta 中的审查依据分离。 */
  readonly ledgers: ReadonlyMap<string, DocumentLedger>
  /** 按文档归属组织的实际源码路径集合。 */
  readonly pathsByDocument: ReadonlyMap<string, ReadonlySet<string>>
  /** 当前候选引用源码与显式证据的整体 SHA-256 指纹。 */
  readonly sourceEvidenceFingerprint: string
}

/** 为文档源码声明生成不会与显式证据混淆的所有者键。 */
function documentSourceOwner(id: string): string {
  return `document:${id}`
}

/** 展开调用方显式声明的证据路径并计算快照指纹。 */
async function declaredEvidenceFingerprint(root: string, patterns: readonly string[]): Promise<string> {
  // 本次源码路径展开及其问题、指纹结果。
  const expansion = await expandSourcePatternSets(root, [{ owner: 'declared', patterns }])
  if (expansion.issues.length > 0) {
    // 优先公开或判定的首个问题项。
    const first = expansion.issues[0] as SourceExpansionResult['issues'][number]
    throw new RuntimeFault(first.diagnostic.code, first.diagnostic.message, first.diagnostic.path)
  }
  return expansion.fingerprint
}

/** 统一收集候选各文档与显式证据的源码事实，每个文件只哈希一次。 */
async function transactionSourceFacts(root: string, graph: KnowledgeGraph, declaredPatterns: readonly string[]): Promise<TransactionSourceFacts> {
  // 本次源码路径展开及其问题、指纹结果。
  const expansion = await expandSourcePatternSets(root, [
    ...[...graph.documents.values()].sort((left, right) => compareCodeUnits(left.id, right.id)).map(document => ({
      owner: documentSourceOwner(document.id),
      patterns: document.codePaths,
    })),
    { owner: 'declared', patterns: declaredPatterns },
  ])
  // 因源码问题而不能形成完整当前账本的文档或所有者集合。
  const affected = new Set(expansion.issues.map(item => item.owner))
  // 根据当前源码计算的文档指纹，与持久审查账本分开保存。
  const ledgers = new Map<string, DocumentLedger>()
  // 按文档归属保存的实际源码路径集合。
  const pathsByDocument = new Map<string, ReadonlySet<string>>()
  for (const document of graph.documents.values()) {
    // 当前资源或写锁的唯一所有者标识。
    const owner = documentSourceOwner(document.id)
    // 当前文档声明实际展开出的源码文件快照。
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
  return {
    expansion,
    ledgers,
    pathsByDocument,
    sourceEvidenceFingerprint: expansion.fingerprint,
  }
}

/** 校验工作流前置状态和冻结授权，Repair 仅放行受限内容失配。 */
async function validateBeginInput(input: TransactionBeginInput, live: KnowledgeGraph, git: GitEvidence): Promise<void> {
  if (input.command === 'compact' && (input.mode !== 'deep' || input.scope.kind !== 'repository'
    || live.sourceState !== 'ready' || git.midOperation || git.hasUnmergedPaths || git.changes.length > 0)) {
    throw new RuntimeFault('COMPACT_PRECONDITION_FAILED', 'Compact requires deep repository scope, complete sources and a clean checkout outside Git operations.')
  }
  if (input.command === 'migrate') {
    if (input.mode !== 'deep' || input.scope.kind !== 'repository' || input.migrationStrategy === undefined)
      throw new RuntimeFault('TRANSACTION_SCOPE_INVALID', 'Migration requires deep repository scope and an explicit strategy.')
    if (live.meta === undefined || live.contextFingerprint === undefined || live.issues.some(item => item.code !== 'META_DOCUMENT_FINGERPRINT_MISMATCH'))
      throw new RuntimeFault('MIGRATION_NOT_ELIGIBLE', 'Only structurally valid legacy Context can migrate.')
    if (git.midOperation || git.hasUnmergedPaths)
      throw new RuntimeFault('MIGRATION_GIT_OPERATION_ACTIVE', 'Finish the Git operation before migration.')
  }
  else if (input.command === 'init') {
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
  if (input.confirmedDocumentIds !== undefined) {
    // Init 没有旧审查记录可结清，Prune 也不接受重新确认输入。
    if (input.command !== 'update')
      throw new RuntimeFault('TRANSACTION_SCOPE_INVALID', 'Only update may confirm Documents.')
    // 未知或范围外的重新确认 ID 必须在获取锁前失败，不能静默跳过或越权结清账本。
    const authorized = authorizedDocumentIds(input.scope, live, live, new Map(), git)
    for (const id of input.confirmedDocumentIds) {
      if (!live.documents.has(id))
        throw new RuntimeFault('TRANSACTION_SCOPE_INVALID', 'A confirmed Document does not exist.')
      if (!authorized.has(id))
        throw new RuntimeFault('TRANSACTION_SCOPE_INVALID', 'A confirmed Document lies outside the authorized scope.')
    }
  }
}

/** 建立完整候选；Init 创建空目录，其余工作流复制正式 Context。 */
async function stageCandidate(root: string, runId: string, command: TransactionCommand): Promise<void> {
  // 当前事务或资源要写入的安全目标路径。
  const destination = await resolveRepositoryPath(root, candidatePath(runId), true)
  await filesystemOperation(() => fs.mkdir(path.dirname(destination), { recursive: true }).then(() => undefined), candidatePath(runId))
  if (command === 'init') {
    await filesystemOperation(() => fs.mkdir(destination), candidatePath(runId))
  }
  else {
    // 当前安全读取或待生成的资源文本。
    const source = await resolveRepositoryPath(root, CONTEXT_ROOT)
    await filesystemOperation(
      () => fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: false }),
      candidatePath(runId),
    )
  }
}

/** 把锁冲突转换为活动事务或人工恢复结果。 */
function lockIncomplete(activeRunId?: string, manualRecoveryRequired = false): RuntimeResponse {
  return manualRecoveryRequired || activeRunId === undefined
    ? transactionResponse({ outcome: 'manual_recovery', ...(activeRunId === undefined ? {} : { runId: activeRunId }) })
    : transactionResponse({ outcome: 'active_run', runId: activeRunId })
}

/** 将不属于当前事务的锁状态映射为安全响应。 */
function foreignLock(lock: LockFact): RuntimeResponse {
  return lockIncomplete(
    lock.state === 'valid' || lock.state === 'orphan' ? lock.runId : undefined,
    lock.state !== 'valid',
  )
}

/** 校验授权与证据、获取唯一写锁并建立持久候选事务。 */
async function transactionBegin(root: string, input: TransactionBeginInput): Promise<RuntimeResponse> {
  assertGitEvidencePath(input.gitEvidencePath)
  input.evidencePaths.forEach(assertSourcePattern)
  if (input.scope.kind === 'paths')
    input.scope.paths.forEach(assertSourcePattern)
  // 事务开始前观察到的仓库写锁状态。
  const currentLock = await classifyLock(root)
  if (currentLock.state === 'valid')
    return lockIncomplete(currentLock.runId)
  if (currentLock.state === 'corrupt' || currentLock.state === 'orphan')
    return lockIncomplete(currentLock.state === 'orphan' ? currentLock.runId : undefined, true)

  // 当前正式 Context 快照，用于授权和并发检查。
  const live = input.command === 'migrate'
    ? (await planLegacyMigration(root, input.migrationStrategy)).graph
    : await loadKnowledge(root, undefined, { sourcePolicy: input.command === 'init'
        ? 'formal-only'
        : input.command === 'prune'
          ? 'all-strict'
          : 'all-tolerant' })
  // 严格读取的宿主 Git 证据快照。
  const git = await readGitEvidence(root, input.gitEvidencePath)
  await validateBeginInput(input, live, git)
  if (live.formalState === 'ready' && input.command !== 'migrate')
    await readConfirmationStore(root, FORMAT)
  // 事务开始时显式证据的指纹，后续必须保持一致。
  const evidenceFingerprint = await declaredEvidenceFingerprint(root, input.evidencePaths)
  // 在获取锁和生成候选前固定整个机械计划，后续来源变化必须重新 begin。
  const compact = input.command === 'compact' ? await compactBasis(root, live, input.evidencePaths) : undefined
  // 当前事务的 UUID，也是其运行目录和写锁的所有权标识。
  const runId = randomUUID()
  // 原子竞争写锁后的实际所有者状态。
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

  // 已解析的事务阶段、冻结输入和恢复事实。
  let manifest: TransactionManifest | undefined
  try {
    await ensureDirectory(root, RUNS_ROOT)
    // 本次操作拥有或读取的目录路径。
    const directory = await resolveRepositoryPath(root, runPath(runId), true)
    await filesystemOperation(() => fs.mkdir(directory), runPath(runId))
    manifest = {
      kind: TRANSACTION_KIND,
      ...(compact === undefined ? {} : { compact }),
      format: FORMAT,
      derivedConfirmationKeys: [],
      derivedMetadataFingerprints: [],
      ...(input.migrationStrategy === undefined ? {} : { migrationStrategy: input.migrationStrategy }),
      runId,
      command: input.command,
      mode: input.mode,
      dryRun: input.dryRun,
      scope: input.scope,
      phase: 'staged',
      gitEvidencePath: input.gitEvidencePath,
      evidencePaths: [...input.evidencePaths].sort(compareCodeUnits),
      ...(input.confirmedDocumentIds === undefined
        ? {}
        : { confirmedDocumentIds: [...input.confirmedDocumentIds].sort(compareCodeUnits) }),
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
    return transactionResponse({ outcome: input.command === 'migrate' ? 'migration_staged' : 'staged', runId, candidatePath: candidatePath(runId) })
  }
  catch (error) {
    // 清单写入前不存在可恢复事务，必须释放孤立锁；清单暂存后只有已知安全故障才允许清理现场。
    if (manifest === undefined)
      await releaseLock(root, runId)
    if (!(error instanceof RuntimeFault))
      throw error
    if (manifest !== undefined)
      await cleanupTerminalArtifacts(root, manifest)
    return transactionResponse({ outcome: 'mechanical_failure', runId }, error.diagnostics)
  }
}

/** 找出 Prune 候选丢失的正式源码覆盖路径。 */
function pruneCoverageIssues(live: KnowledgeGraph, candidate: TransactionSourceFacts): readonly string[] {
  // 正式知识已有的全部源码覆盖路径。
  const before = [...live.sources.values()].flatMap(files => files.map(file => file.path))
  // 候选知识仍然覆盖的去重源码路径集合。
  const after = new Set([...candidate.pathsByDocument.values()].flatMap(paths => [...paths]))
  return [...new Set(before)].filter(candidatePath => !after.has(candidatePath)).sort(compareCodeUnits)
}

/** 比较文档位置及规范化内容是否一致，不比较源码审查依据。 */
function sameDocument(left: ContextDocument | undefined, right: ContextDocument | undefined): boolean {
  if (left === undefined || right === undefined)
    return left === right
  return left.path === right.path
    && frontMatterFingerprint(left) === frontMatterFingerprint(right)
    && bodyFingerprint(left) === bodyFingerprint(right)
}

/** 结合新旧文档、源码路径和 Git 变更计算实际授权的文档集合。 */
function authorizedDocumentIds(
  scope: Scope,
  live: KnowledgeGraph,
  candidate: KnowledgeGraph,
  /** 候选侧实际展开的源码路径；begin 时仅有正式树，故传入空映射。 */
  candidatePaths: ReadonlyMap<string, ReadonlySet<string>>,
  git: GitEvidence,
): ReadonlySet<string> {
  // 以稳定文档 ID 为键的知识或账本映射。
  const documents = new Map([...live.documents, ...candidate.documents])
  if (scope.kind === 'repository')
    return new Set(documents.keys())
  if (scope.kind === 'documents')
    return new Set(scope.ids)
  if (scope.kind === 'domains') {
    return new Set([...documents.keys()].flatMap((id) => {
      // 当前领域是否位于新旧文档任一侧的授权范围内。
      const selected = scope.ids.includes(live.documents.get(id)?.domain ?? '')
        || scope.ids.includes(candidate.documents.get(id)?.domain ?? '')
      return selected ? [id] : []
    }))
  }
  // Git 变更中的新旧路径集合，用于路径范围授权。
  const gitPaths = git.changes.flatMap(change => [change.path, ...(change.previousPath === undefined ? [] : [change.previousPath])])
  // 由冻结范围推导出的可写文档 ID 集合。
  const authorized = new Set<string>()
  for (const id of documents.keys()) {
    // 新旧文档的源码声明并集，用于保留变更路径的归属。
    const declarations = [...(live.documents.get(id)?.codePaths ?? []), ...(candidate.documents.get(id)?.codePaths ?? [])]
    // 当前源码及 Git 变更共同证明的具体文件路径。
    const actualPaths = new Set([
      ...declarations.filter(pattern => !pattern.includes('*')),
      ...(live.sources.get(id) ?? []).map(file => file.path),
      ...(candidatePaths.get(id) ?? []),
      ...gitPaths.filter(changed => declarations.some(declaration => declarationMatches(declaration, changed))),
    ])
    if ([...actualPaths].some(actual => scope.paths.some(pattern => declarationMatches(pattern, actual))))
      authorized.add(id)
  }
  return authorized
}

/** 找出未授权范围内被新增、删除、移动或改写的文档。 */
function scopeMutationIssues(live: KnowledgeGraph, candidate: KnowledgeGraph, authorized: ReadonlySet<string>): readonly string[] {
  // 当前选择或授权涉及的稳定身份集合。
  const ids = new Set([...live.documents.keys(), ...candidate.documents.keys()])
  return [...ids].filter(id => !authorized.has(id) && !sameDocument(live.documents.get(id), candidate.documents.get(id))).sort(compareCodeUnits)
}

/** 从候选图生成 Init 或 Prune 的规模基线。 */
function convergenceBaseline(graph: KnowledgeGraph, source: 'init' | 'prune'): ConvergenceBaseline {
  // 当前知识集合的规模统计。
  const metrics = graphMetrics(graph)
  return { source, ...metrics.current, perDomain: metrics.perDomain }
}

/**
 * 选择已编辑或被明确重新确认的授权文档。
 * 未经编辑也未明确确认的记录保留原有待审状态；不能仅因源码可读就推断语义复核已经完成。
 */
function refreshedDocumentIds(
  graph: KnowledgeGraph,
  live: KnowledgeGraph,
  authorized: ReadonlySet<string>,
  confirmed: readonly string[] = [],
): ReadonlySet<string> {
  // 调用方明确确认已复核、允许派生新确认的文档 ID。
  const permitted = new Set(confirmed)
  return new Set([...graph.documents.keys()].filter(id => authorized.has(id)
    && (permitted.has(id) || live.documents.get(id) === undefined
      || frontMatterFingerprint(live.documents.get(id)!) !== frontMatterFingerprint(graph.documents.get(id)!)
      || bodyFingerprint(live.documents.get(id)!) !== bodyFingerprint(graph.documents.get(id)!))))
}

/** 推导唯一入口；Update 永不推进任何基线。 */
function deriveMetadata(manifest: TransactionManifest, graph: KnowledgeGraph, live: KnowledgeGraph): MetadataManifest {
  // 仅 Init/Prune 可建立的规模基线，Update 原样保留。
  const convergence = manifest.command === 'init'
    ? convergenceBaseline(graph, 'init')
    : manifest.command === 'prune' ? convergenceBaseline(graph, 'prune') : live.metadata?.convergence
  return { format: FORMAT, ...(live.metadata?.repository === undefined ? {} : { repository: live.metadata.repository }), ...(convergence === undefined ? {} : { convergence }) }
}

/** 校验清单中的累计所有权集合，拒绝重复或伪造形状。 */
function validHashes(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(key => typeof key === 'string' && HASH.test(key)) && new Set(value).size === value.length
}

/** 由本轮完整来源事实推导获准文档的不可变记录。 */
function deriveRecords(manifest: TransactionManifest, graph: KnowledgeGraph, live: KnowledgeGraph, sources: TransactionSourceFacts, authorized: ReadonlySet<string>): ReadonlyMap<string, ConfirmationRecord> {
  // 由完整四字段元组组成的确认集合，无 latest 指针。
  const records = new Map<string, ConfirmationRecord>()
  for (const documentId of refreshedDocumentIds(graph, live, authorized, manifest.confirmedDocumentIds)) {
    // 本轮完整来源事实生成的摘要，不能复用旧账本冒充当前证据。
    const ledger = sources.ledgers.get(documentId)
    if (ledger === undefined)
      throw new RuntimeFault('CANDIDATE_SOURCE_INVALID', 'A confirmed Document requires complete current sources.')
    // 当前获准文档的完整确认元组。
    const record = { documentId, ...ledger }
    records.set(confirmationKey(FORMAT, record), record)
  }
  return records
}

/** 确认正式 Context 仍与事务建立时的快照一致。 */
async function assertSnapshotFresh(root: string, manifest: TransactionManifest): Promise<void> {
  // 当前正式 Context 快照，用于授权和并发检查。
  const live = await treeFact(root, CONTEXT_ROOT)
  if (manifest.snapshot.contextState === 'absent') {
    if (live.state !== 'absent')
      throw new RuntimeFault('FORMAL_CONTEXT_CONFLICT', 'Formal Context changed after transaction begin.')
  }
  else if (live.state !== 'valid' || live.fingerprint !== manifest.snapshot.contextFingerprint) {
    throw new RuntimeFault('FORMAL_CONTEXT_CONFLICT', 'Formal Context changed after transaction begin.')
  }
}

/** 重新读取显式证据，拒绝事务开始后的变化或不可读取状态。 */
async function assertDeclaredEvidenceFresh(root: string, manifest: TransactionManifest): Promise<void> {
  // 重新读取宿主显式证据后计算的当前指纹。
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

/** 重新校验宿主 Git 证据，拒绝字节或版本变化。 */
async function assertGitEvidenceFresh(root: string, manifest: TransactionManifest): Promise<GitEvidence> {
  // 严格读取的宿主 Git 证据快照。
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

/** 在目录切换前统一复核正式 Context、显式证据和 Git 快照。 */
async function assertPreSwitchSnapshotFresh(root: string, manifest: TransactionManifest): Promise<GitEvidence> {
  await assertSnapshotFresh(root, manifest)
  await assertDeclaredEvidenceFresh(root, manifest)
  return assertGitEvidenceFresh(root, manifest)
}

/** 验证待清理路径确为指定集合中的单个自有叶子。 */
async function ownedLeafAbsolute(root: string, parentRelative: string | undefined, leaf: string): Promise<string> {
  if (leaf.length === 0 || leaf.includes('/') || leaf === '.' || leaf === '..')
    throw new TypeError('Transaction leaf names must be fixed single path segments.')
  // 拥有待清理叶子的直接集合目录。
  const parent = parentRelative === undefined
    ? await resolveRepositoryRoot(root)
    : await resolveRepositoryPath(root, parentRelative)
  // 通过 lstat 取得的文件类型、权限和大小，避免隐式跟随链接。
  const info = await filesystemOperation(() => fs.lstat(parent), parentRelative)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new RuntimeFault('TRANSACTION_PARENT_INVALID', 'A transaction-owned parent path is unsafe.', parentRelative)
  return path.join(parent, leaf)
}

/** 仅递归删除通过所有权边界校验的叶子目录。 */
async function removeOwnedLeaf(root: string, parentRelative: string | undefined, leaf: string): Promise<void> {
  if (parentRelative !== undefined && await lstatRepositoryPath(root, parentRelative) === undefined)
    return
  // 通过仓库边界检查的绝对路径，仅用于内部文件操作。
  const absolute = await ownedLeafAbsolute(root, parentRelative, leaf)
  // 通过 lstat 取得的文件类型、权限和大小，避免隐式跟随链接。
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

/** 删除当前事务拥有的 Git 证据叶子。 */
async function cleanupEvidence(root: string, evidencePath: string): Promise<void> {
  assertGitEvidencePath(evidencePath)
  // 拥有待清理叶子的直接集合目录。
  const parent = path.posix.dirname(evidencePath)
  await removeOwnedLeaf(root, parent, path.posix.basename(evidencePath))
}

/** 在安全终态清理本事务的证据、运行目录和写锁。 */
async function cleanupTerminalArtifacts(root: string, manifest: TransactionManifest): Promise<void> {
  await cleanupEvidence(root, manifest.gitEvidencePath)
  await releaseLock(root, manifest.runId)
  await removeOwnedLeaf(root, RUNS_ROOT, manifest.runId)
}

/** 汇总候选的正式结构问题及源码展开问题。 */
function candidateDiagnostics(graph: KnowledgeGraph, sourceFacts?: TransactionSourceFacts): readonly Diagnostic[] {
  return [
    ...graph.issues.map(item => diagnostic(item.code, item.message, 'error', item.path)),
    ...(sourceFacts?.expansion.issues ?? []).map((item) => {
      // 当前从队列或所有者键解析出的稳定文档身份。
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

/** 保留事务现场并返回候选仍需修改的结果。 */
function candidateEditRequired(manifest: TransactionManifest, diagnostics: readonly Diagnostic[]): RuntimeResponse {
  return transactionResponse({ outcome: 'candidate_edit_required', runId: manifest.runId }, diagnostics)
}

// 表示正式知识、Git 或显式证据已变化的错误码集合。
const SNAPSHOT_CONFLICTS = new Set(['FORMAL_CONTEXT_CONFLICT', 'DECLARED_EVIDENCE_CONFLICT', 'GIT_EVIDENCE_CONFLICT'])

/** 在切换前按故障类型清理安全现场或保留未知异常。 */
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

/** 检查候选元数据所有权；旧记录按字节和权限保护，新文件必须属于本 run。 */
async function assertManagedCandidate(root: string, manifest: TransactionManifest, finalRecords?: ReadonlyMap<string, ConfirmationRecord>): Promise<void> {
  // 本 run 独占的候选 Context 目录。
  const destination = candidatePath(manifest.runId)
  // 原始正式快照中的文件字节与权限。
  const before = manifest.snapshot.contextState === 'absent' ? [] : await readTree(root, CONTEXT_ROOT)
  // 候选文件的实际字节与权限。
  const after = await readTree(root, destination)
  // 用于保护既有证据的正式文件集合。
  const original = new Map(before.map(file => [file.path.slice(CONTEXT_ROOT.length + 1), file]))
  // 候选当前状态，不能自动吸收外部修改。
  const candidate = new Map(after.map(file => [file.path.slice(destination.length + 1), file]))
  // 是否执行历史转换；迁移不确认当前源码。
  const migration = manifest.command === 'migrate'
  if (migration && !candidate.has('meta.json') && manifest.derivedMetadataFingerprints.length === 0)
    throw new RuntimeFault('MIGRATION_CANDIDATE_CHANGED', 'Only Runtime may remove the original entry during conversion.')
  if (!migration && original.has('.meta/manifest.json') && !candidate.has('.meta/manifest.json'))
    throw new RuntimeFault('METADATA_MUTATION_FORBIDDEN', 'An existing metadata entry cannot be removed.')
  for (const [relative, file] of original) {
    if (migration && relative === 'meta.json')
      continue
    if (!migration && !relative.startsWith('.meta/'))
      continue
    if (!migration && relative === '.meta/manifest.json')
      continue
    // 候选中与原始文件对应的条目。
    const next = candidate.get(relative)
    if (next === undefined || next.mode !== file.mode || !next.bytes.equals(file.bytes))
      throw new RuntimeFault('CONFIRMATION_MUTATION_FORBIDDEN', 'Existing confirmations, or migrating Markdown, must remain byte-exact with permissions.', `context/${relative}`)
  }
  for (const [relative, file] of candidate) {
    if (relative === 'meta.json') {
      // 同路径原始文件，用于区分历史记录与本 run 新增内容。
      const prior = original.get(relative)
      if (!migration || prior === undefined || !file.bytes.equals(prior.bytes) || file.mode !== prior.mode || finalRecords !== undefined)
        throw new RuntimeFault('MIGRATION_CANDIDATE_CHANGED', 'Only Runtime may remove the original legacy entry.')
      continue
    }
    if (!relative.startsWith('.meta/')) {
      if (migration && !original.has(relative))
        throw new RuntimeFault('MIGRATION_DOCUMENT_CHANGED', 'Migration cannot add or change Markdown.')
      continue
    }
    // 同路径原始文件，用于区分历史记录与本 run 新增内容。
    const prior = original.get(relative)
    if (prior !== undefined && file.mode === prior.mode && file.bytes.equals(prior.bytes))
      continue
    if (relative === '.meta/manifest.json') {
      if (!manifest.derivedMetadataFingerprints.includes(sha256(file.bytes)) || file.mode !== 0o644)
        throw new RuntimeFault('METADATA_MUTATION_FORBIDDEN', 'Only Runtime may derive metadata.')
      continue
    }
    // 受控记录路径解析结果，必须匹配已登记的内容身份。
    const match = /^\.meta\/confirmations\/([^/]+)\/([a-f0-9]{64})\.json$/.exec(relative)
    if (match === null || !manifest.derivedConfirmationKeys.includes(match[2]!) || file.mode !== 0o644)
      throw new RuntimeFault('CONFIRMATION_MUTATION_FORBIDDEN', 'Only Runtime may derive new confirmations.', `context/${relative}`)
    parseConfirmation(FORMAT, match[1]!, match[2]!, file.bytes.toString('utf8'))
    if (finalRecords !== undefined && !finalRecords.has(match[2]!))
      throw new RuntimeFault('CONFIRMATION_MUTATION_FORBIDDEN', 'Obsolete derived confirmation remains in candidate.')
  }
  if (finalRecords !== undefined) {
    for (const [key, record] of finalRecords) {
      if (candidate.get(`.meta/confirmations/${record.documentId}/${key}.json`)?.bytes.toString('utf8') !== stableJson(record as unknown as JsonValue))
        throw new RuntimeFault('CANDIDATE_SOURCE_STALE', 'Expected confirmation does not match the candidate.')
    }
  }
}

/** 在写文件前持久化累计所有权，重试只清理本 run 的过期派生记录。 */
async function writeDerivedMetadata(root: string, manifest: TransactionManifest, metadata: MetadataManifest, records: ReadonlyMap<string, ConfirmationRecord>): Promise<TransactionManifest> {
  await assertManagedCandidate(root, manifest)
  // 本 run 独占的候选 Context 目录。
  const destination = candidatePath(manifest.runId)
  // 用于保护既有证据的正式文件集合。
  const original = manifest.snapshot.contextState === 'absent' ? [] : await readTree(root, CONTEXT_ROOT)
  // 既有正式文件路径，清理派生内容时必须保留。
  const originalPaths = new Set(original.map(file => file.path.slice(CONTEXT_ROOT.length + 1)))
  // 在文件写入之前登记的本 run 所有权事实。
  const owned: TransactionManifest = { ...baseFacts(manifest), phase: 'staged', derivedConfirmationKeys: [...new Set([...manifest.derivedConfirmationKeys, ...records.keys()])].sort(compareCodeUnits), derivedMetadataFingerprints: [...new Set([...manifest.derivedMetadataFingerprints, sha256(serializeMetadataManifest(metadata))])].sort(compareCodeUnits) }
  await writeManifest(root, owned)
  for (const file of await readTree(root, destination)) {
    // 相对候选根目录的受控路径。
    const relative = file.path.slice(destination.length + 1)
    // 受控记录路径解析结果，必须匹配已登记的内容身份。
    const match = /^\.meta\/confirmations\/[^/]+\/([a-f0-9]{64})\.json$/.exec(relative)
    if (match !== null && !originalPaths.has(relative) && !records.has(match[1]!))
      await filesystemOperation(() => fs.rm(path.join(root, file.path)), file.path)
  }
  // 正式元数据文件与记录使用固定权限；重复写入保留原有字节和权限。
  await ensureDirectory(root, `${destination}/.meta`)
  // 唯一格式入口的候选路径。
  const metadataPath = `${destination}/.meta/manifest.json`
  // 本次实际观察到的资源状态。
  const current = await lstatRepositoryPath(root, metadataPath)
  if (current === undefined || await readUtf8File(root, metadataPath, MAX_JSON_TEXT_BYTES) !== serializeMetadataManifest(metadata))
    await atomicWriteJson(root, metadataPath, metadata as unknown as JsonValue, 0o644)
  for (const [key, record] of records) {
    // 相对候选根目录的受控路径。
    const relative = `${destination}/.meta/confirmations/${record.documentId}/${key}.json`
    if (await lstatRepositoryPath(root, relative) === undefined) {
      await ensureDirectory(root, `${destination}/.meta/confirmations/${record.documentId}`)
      await atomicWriteJson(root, relative, record as unknown as JsonValue, 0o644)
    }
  }
  if (manifest.command === 'migrate' && await lstatRepositoryPath(root, `${destination}/meta.json`) !== undefined)
    await filesystemOperation(() => fs.rm(path.join(root, destination, 'meta.json')), `${destination}/meta.json`)
  return owned
}

/** 回收已登记派生目标的临时叶子；部分写入也不应阻止安全重试。 */
async function recoverDerivedTemps(root: string, manifest: TransactionManifest): Promise<void> {
  // 本 run 独占的候选 Context 目录。
  const destination = candidatePath(manifest.runId)
  for (const file of await readTree(root, destination)) {
    // 相对候选根目录的受控路径。
    const relative = file.path.slice(destination.length + 1)
    if (!relative.endsWith('.tmp'))
      continue
    // 受控记录路径解析结果，必须匹配已登记的内容身份。
    const match = /^\.meta\/confirmations\/[a-z0-9.-]+\/([a-f0-9]{64})\.json\.tmp$/.exec(relative)
    // 在文件写入之前登记的本 run 所有权事实。
    const owned = relative === '.meta/manifest.json.tmp'
      ? manifest.derivedMetadataFingerprints.length > 0
      : match !== null && manifest.derivedConfirmationKeys.includes(match[1]!)
    if (!owned)
      throw new RuntimeFault('TRANSACTION_TEMP_INVALID', 'An unowned candidate temporary file must not be removed.')
    await filesystemOperation(() => fs.rm(path.join(root, file.path)), file.path)
  }
}

/** 提取唯一允许淘汰的记录身份；其他文件不属于删除集合。 */
function compactRecordKey(relative: string): string | undefined {
  return /^\.meta\/confirmations\/[a-z0-9.-]+\/([a-f0-9]{64})\.json$/.exec(relative)?.[1]
}

/** 给 compact 单独绑定原有权限，保持旧格式的公开树指纹算法。 */
function compactModes(files: readonly TreeFile[], treePath: string): string {
  return sha256(stableJson(files.map(file => ({ path: file.path.slice(treePath.length + 1), mode: file.mode }))))
}

/** 重新从完整原始记录与当前来源计算机械计划，不接受候选自行声明的保留集。 */
async function compactBasis(root: string, graph: KnowledgeGraph, evidencePaths: readonly string[]): Promise<CompactBasis> {
  if (graph.formalState !== 'ready')
    throw new RuntimeFault('COMPACT_CONTEXT_INVALID', 'Compact requires valid current Context.')
  // 从当前源码实际读取的完整证据，不能用存储中的历史来源摘要替代。
  const sources = await transactionSourceFacts(root, graph, evidencePaths)
  if (sources.expansion.issues.length > 0)
    throw new RuntimeFault('COMPACT_SOURCE_UNAVAILABLE', 'Compact requires complete current sources.')
  // 覆盖每个活跃文档，使来源缺失不能被误分类为退休身份。
  const current = new Map<string, ConfirmationRecord>()
  for (const id of graph.documents.keys()) {
    // 当前文档的实际三项输入摘要。
    const ledger = sources.ledgers.get(id)
    if (ledger === undefined)
      throw new RuntimeFault('COMPACT_SOURCE_UNAVAILABLE', 'Every active Document needs complete source evidence.')
    current.set(id, { documentId: id, ...ledger })
  }
  // 只从已验证的完整历史选择子集。
  const plan = planRetention(await readConfirmationStore(root, FORMAT), current)
  // 独立保存权限约束，避免改变 0.8 的公开树指纹算法。
  const files = await readTree(root, CONTEXT_ROOT)
  // 计划允许缺失的身份，仅用于计算目标权限快照。
  const removed = new Set(plan.removedKeys)
  return {
    removedKeys: plan.removedKeys,
    sourceEvidenceFingerprint: sources.sourceEvidenceFingerprint,
    originalModesFingerprint: compactModes(files, CONTEXT_ROOT),
    retainedModesFingerprint: compactModes(files.filter(file => !removed.has(compactRecordKey(file.path.slice(CONTEXT_ROOT.length + 1)) ?? '')), CONTEXT_ROOT),
    summary: plan.summary,
  }
}

/** 核对完整候选；只允许已冻结记录缺失，所有其他文件必须与原树逐字节、逐权限相等。 */
async function assertCompactCandidate(root: string, manifest: TransactionManifest, complete: boolean): Promise<readonly TreeFile[]> {
  // 由 begin 冻结并在当前阶段重新推导核对的机械计划。
  const basis = manifest.compact!
  // 当前 run 独占的候选根目录。
  const destination = candidatePath(manifest.runId)
  // 正式原树仍是完整历史和存活文件字节的唯一来源。
  const before = await readTree(root, CONTEXT_ROOT)
  // 实际候选可能处于部分删除后的可恢复状态。
  const after = await readTree(root, destination)
  if (compactModes(before, CONTEXT_ROOT) !== basis.originalModesFingerprint)
    throw new RuntimeFault('COMPACT_BASIS_CHANGED', 'Original permissions changed; abandon and begin a fresh compact run.')
  // 遍历原树时逐项扣除，剩余条目就是未经允许的新增。
  const candidate = new Map(after.map(file => [file.path.slice(destination.length + 1), file]))
  // 任何缺失记录都必须在此允许集合内。
  const removed = new Set(basis.removedKeys)
  for (const file of before) {
    // 两个根目录之间以相同的 Context 相对路径对齐。
    const relative = file.path.slice(CONTEXT_ROOT.length + 1)
    // 与原始文件对应的实际候选条目。
    const next = candidate.get(relative)
    // 完成阶段还要确认计划目标确实已删除，而非仅允许其缺失。
    const removable = removed.has(compactRecordKey(relative) ?? '')
    if (next === undefined ? !removable : next.mode !== file.mode || !next.bytes.equals(file.bytes) || (complete && removable))
      throw new RuntimeFault('COMPACT_CANDIDATE_CHANGED', 'Compact only permits its planned confirmation deletions.', `context/${relative}`)
    candidate.delete(relative)
  }
  if (candidate.size !== 0 || (complete && compactModes(after, destination) !== basis.retainedModesFingerprint))
    throw new RuntimeFault('COMPACT_CANDIDATE_CHANGED', 'Compact cannot add files or change retained permissions.')
  return before
}

/** 重证 compact 的冻结计划、候选和完整来源，用于最终验证、批准及恢复前拒旧。 */
async function compactValidatedFacts(root: string, manifest: TransactionManifest): Promise<ValidatedFacts> {
  // 原树结构与当前来源分开读取，后者必须匹配冻结证据。
  const live = await loadKnowledge(root, undefined, { sourcePolicy: 'formal-only' })
  // 重新计算而非信任候选提供的删除集合。
  const basis = await compactBasis(root, live, manifest.evidencePaths)
  if (stableJson(basis as unknown as JsonValue) !== stableJson(manifest.compact as unknown as JsonValue))
    throw new RuntimeFault('COMPACT_BASIS_CHANGED', 'Compact inputs changed; abandon and begin from the new mainline snapshot.')
  await assertCompactCandidate(root, manifest, true)
  // 删除后的正式形状仍需完整解析和记录校验。
  const graph = await loadKnowledge(root, candidatePath(manifest.runId), { sourcePolicy: 'formal-only' })
  if (graph.formalState !== 'ready' || graph.contextFingerprint === undefined)
    throw new RuntimeFault('CANDIDATE_INVALID', 'The retained Context must remain structurally valid.')
  await readConfirmationStore(root, FORMAT, candidatePath(manifest.runId))
  // 再次采样，拒绝多个 await 之间改变的源码或文件集合。
  const sources = await transactionSourceFacts(root, graph, manifest.evidencePaths)
  if (sources.expansion.issues.length > 0 || sources.sourceEvidenceFingerprint !== basis.sourceEvidenceFingerprint
    || await fingerprintTree(root, candidatePath(manifest.runId)) !== graph.contextFingerprint) {
    throw new RuntimeFault('COMPACT_BASIS_CHANGED', 'Sources or candidate changed during compact validation.')
  }
  await assertCompactCandidate(root, manifest, true)
  return { graph, candidateFingerprint: graph.contextFingerprint, sourceEvidenceFingerprint: sources.sourceEvidenceFingerprint }
}

/** 在现有候选中幂等删除冻结目标，随后使用同一验证和终态清理机制。 */
async function validateCompact(root: string, manifest: TransactionManifest): Promise<RuntimeResponse> {
  // 只从原树重新建立计划，候选不能自己宣告哪些记录可以删除。
  const live = await loadKnowledge(root, undefined, { sourcePolicy: 'formal-only' })
  // 本次实际推导必须与 begin 冻结值完全一致。
  const actual = await compactBasis(root, live, manifest.evidencePaths)
  if (stableJson(actual as unknown as JsonValue) !== stableJson(manifest.compact as unknown as JsonValue))
    throw new RuntimeFault('COMPACT_BASIS_CHANGED', 'Compact inputs changed; abandon and begin again.')
  // 允许已登记删除部分完成，以便幂等验证。
  const before = await assertCompactCandidate(root, manifest, false)
  // 物理删除只遍历原树中与计划匹配的记录。
  const removed = new Set(actual.removedKeys)
  for (const file of before) {
    // 原树与候选中的同一路径。
    const relative = file.path.slice(CONTEXT_ROOT.length + 1)
    if (!removed.has(compactRecordKey(relative) ?? ''))
      continue
    // 所有删除都局限于当前 run 的候选目录。
    const target = `${candidatePath(manifest.runId)}/${relative}`
    if (await lstatRepositoryPath(root, target) !== undefined) {
      // 沿用 Runtime 的路径安全解析，拒绝链接与越界。
      const absolute = await resolveRepositoryPath(root, target)
      await filesystemOperation(() => fs.rm(absolute), target)
    }
  }
  // 完成删除后再证明候选、来源及权限，供批准绑定。
  const facts = await compactValidatedFacts(root, manifest)
  await assertPreSwitchSnapshotFresh(root, manifest)
  if (facts.candidateFingerprint === manifest.snapshot.contextFingerprint) {
    await cleanupTerminalArtifacts(root, manifest)
    return transactionResponse({ outcome: 'no_change', runId: manifest.runId, contextFingerprint: facts.candidateFingerprint })
  }
  // 仅保存已复验的双指纹，不产生新的语义确认。
  const validated: TransactionManifest = { ...baseFacts(manifest), phase: 'validated', candidateFingerprint: facts.candidateFingerprint, sourceEvidenceFingerprint: facts.sourceEvidenceFingerprint }
  await writeManifest(root, validated)
  // 公开摘要不包含无界记录列表或机器路径。
  const result = { runId: manifest.runId, candidateFingerprint: facts.candidateFingerprint, sourceEvidenceFingerprint: facts.sourceEvidenceFingerprint, retention: { ...actual.summary } }
  if (manifest.dryRun) {
    await cleanupTerminalArtifacts(root, validated)
    return transactionResponse({ outcome: 'validated', ...result })
  }
  return transactionResponse({ outcome: 'ready_for_review', ...result })
}

/** 校验候选与授权、推导确认并绑定源码证据；dry-run 在此安全结束。 */
async function transactionValidate(root: string, input: TransactionValidateInput): Promise<RuntimeResponse> {
  // 已解析的事务阶段、冻结输入和恢复事实。
  let manifest = await loadManifest(root, input.runId)
  if (manifest.phase !== 'staged' && manifest.phase !== 'validated')
    throw new RuntimeFault('TRANSACTION_PHASE_INVALID', 'transaction.validate requires a staged or validated run.')
  // 当前仓库写锁的所有者状态。
  const lock = await classifyLock(root)
  if (lock.state !== 'valid' || lock.runId !== manifest.runId)
    return lockIncomplete(lock.state === 'valid' || lock.state === 'orphan' ? lock.runId : undefined, lock.state !== 'valid')
  // 严格读取的宿主 Git 证据快照。
  let git: GitEvidence
  try {
    git = await assertPreSwitchSnapshotFresh(root, manifest)
  }
  catch (error) {
    return preSwitchFailure(root, manifest, error)
  }

  try {
    await recoverDerivedTemps(root, manifest)
    if (manifest.command === 'compact')
      return await validateCompact(root, manifest)
    // 是否执行历史转换；迁移不确认当前源码。
    const migration = manifest.command === 'migrate' ? await planLegacyMigration(root, manifest.migrationStrategy) : undefined
    // 正式 Context 快照；只读，不由候选编写者修改。
    const live = migration?.graph ?? await loadKnowledge(root, undefined, { sourcePolicy: 'all-tolerant' })
    if (manifest.command === 'migrate')
      await validateBeginInput(manifest, live, git)
    // 由完整四字段元组组成的确认集合，无 latest 指针。
    let records: ReadonlyMap<string, ConfirmationRecord>
    // 本次批准绑定的完整实际来源证据摘要。
    let sourceEvidenceFingerprint: string
    // 按工作流规则推导的格式入口与保留基线。
    let metadata: MetadataManifest
    if (migration !== undefined) {
      records = migration.records
      metadata = migration.metadata
      sourceEvidenceFingerprint = await declaredEvidenceFingerprint(root, manifest.evidencePaths)
    }
    else {
      // 候选当前状态，不能自动吸收外部修改。
      const candidate = await loadKnowledge(root, candidatePath(manifest.runId), { ignoreMeta: true, requireMeta: false, sourcePolicy: 'formal-only' })
      if (candidate.formalState !== 'ready')
        return candidateEditRequired(manifest, candidateDiagnostics(candidate))
      // 候选声明和显式证据的去重读取事实。
      const sources = await transactionSourceFacts(root, candidate, manifest.evidencePaths)
      if (sources.expansion.issues.length > 0)
        return candidateEditRequired(manifest, candidateDiagnostics(candidate, sources))
      // 从 begin 固定范围推导出的可写文档集合。
      const authorized = authorizedDocumentIds(manifest.scope, live, candidate, sources.pathsByDocument, git)
      if (scopeMutationIssues(live, candidate, authorized).length > 0)
        return candidateEditRequired(manifest, [diagnostic('CANDIDATE_SCOPE_VIOLATION', 'Candidate modifies a Document outside authorized scope.')])
      if (manifest.command === 'prune' && (live.sourceState !== 'ready' || pruneCoverageIssues(live, sources).length > 0))
        return candidateEditRequired(manifest, [diagnostic('PRUNE_COVERAGE_LOST', 'Prune requires complete existing source coverage.')])
      records = deriveRecords(manifest, candidate, live, sources, authorized)
      metadata = deriveMetadata(manifest, candidate, live)
      sourceEvidenceFingerprint = sources.sourceEvidenceFingerprint
    }
    manifest = await writeDerivedMetadata(root, manifest, metadata, records)
    // 写入机器文件后重新读取的候选结构。
    const validated = await loadKnowledge(root, candidatePath(manifest.runId), { sourcePolicy: 'formal-only' })
    if (validated.formalState !== 'ready' || validated.contextFingerprint === undefined)
      return candidateEditRequired(manifest, candidateDiagnostics(validated))
    await readConfirmationStore(root, FORMAT, candidatePath(manifest.runId))
    await assertManagedCandidate(root, manifest, records)
    // 最终来源采样，用于拒绝验证过程中的输入变化。
    const finalSources = migration === undefined ? await transactionSourceFacts(root, validated, manifest.evidencePaths) : undefined
    if (finalSources !== undefined) {
      if (finalSources.expansion.issues.length > 0 || finalSources.sourceEvidenceFingerprint !== sourceEvidenceFingerprint)
        return candidateEditRequired(manifest, [diagnostic('CANDIDATE_SOURCE_STALE', 'Sources changed during validation.'), ...candidateDiagnostics(validated, finalSources)])
      // 从 begin 固定范围推导出的可写文档集合。
      const authorized = authorizedDocumentIds(manifest.scope, live, validated, finalSources.pathsByDocument, git)
      if (scopeMutationIssues(live, validated, authorized).length > 0)
        return candidateEditRequired(manifest, [diagnostic('CANDIDATE_SCOPE_VIOLATION', 'Candidate changed outside scope during validation.')])
      await assertManagedCandidate(root, manifest, deriveRecords(manifest, validated, live, finalSources, authorized))
    }
    if (serializeMetadataManifest(validated.metadata!) !== serializeMetadataManifest(metadata)
      || await fingerprintTree(root, candidatePath(manifest.runId)) !== validated.contextFingerprint) {
      return candidateEditRequired(manifest, [diagnostic('CANDIDATE_CHANGED', 'Candidate changed during final validation.')])
    }
    // 即将获得批准的完整候选树摘要。
    const candidateFingerprint = validated.contextFingerprint
    // 既有正式确认身份，用于统计真正新增的记录。
    const originalKeys = live.metadata === undefined ? new Set<string>() : new Set([...(await readConfirmationStore(root, FORMAT)).records.values()].flatMap(records => [...records.keys()]))
    // 有界确认摘要，完整记录仍在候选中接受审查。
    const summary = { confirmation: { documentCount: records.size, newRecordCount: [...records.keys()].filter(key => !originalKeys.has(key)).length, planFingerprint: migration?.planFingerprint ?? sha256(stableJson([...records.keys()].sort(compareCodeUnits))) } }
    await assertPreSwitchSnapshotFresh(root, manifest)
    // 重新验证总是丢弃旧批准和恢复事实，只保留冻结输入及本次重新计算的两个指纹。
    manifest = { ...baseFacts(manifest), phase: 'validated', candidateFingerprint, sourceEvidenceFingerprint }
    if (manifest.snapshot.contextState === 'present' && candidateFingerprint === manifest.snapshot.contextFingerprint) {
      // 当前能力按协议构造的结果响应。
      const response = transactionResponse({ outcome: 'no_change', runId: manifest.runId, contextFingerprint: candidateFingerprint })
      await cleanupTerminalArtifacts(root, manifest)
      return response
    }
    await writeManifest(root, manifest)
    if (manifest.dryRun) {
      // 当前能力按协议构造的结果响应。
      const response = transactionResponse({ outcome: 'validated', runId: manifest.runId, candidateFingerprint, sourceEvidenceFingerprint, ...summary })
      await cleanupTerminalArtifacts(root, manifest)
      return response
    }
    return transactionResponse({ outcome: 'ready_for_review', runId: manifest.runId, candidateFingerprint, sourceEvidenceFingerprint, ...summary })
  }
  catch (error) {
    if (!(error instanceof RuntimeFault))
      throw error
    if (error.code === 'REPOSITORY_IO_FAILED' || SNAPSHOT_CONFLICTS.has(error.code))
      return preSwitchFailure(root, manifest, error)
    return candidateEditRequired(manifest, error.diagnostics)
  }
}

/** 重新读取候选与源码证据，供提交和恢复核对已验证指纹。 */
async function validatedFacts(root: string, manifest: TransactionManifest): Promise<{
  /** 本次重新读取并验证的候选知识图。 */
  readonly graph: KnowledgeGraph
  /** 已验证候选完整目录树的 SHA-256 指纹。 */
  readonly candidateFingerprint: string
  /** 当前候选引用源码与显式证据的整体 SHA-256 指纹。 */
  readonly sourceEvidenceFingerprint: string
}> {
  if (manifest.command === 'compact')
    return compactValidatedFacts(root, manifest)
  // 本次调用读取的知识快照，后续判断都以它为依据。
  const graph = await loadKnowledge(root, candidatePath(manifest.runId), { sourcePolicy: 'formal-only' })
  if (graph.formalState !== 'ready' || graph.contextFingerprint === undefined)
    throw new RuntimeFault('CANDIDATE_INVALID', 'The transaction candidate is not a complete valid Context tree.')
  await readConfirmationStore(root, FORMAT, candidatePath(manifest.runId))
  // 是否执行历史转换；迁移不确认当前源码。
  const migration = manifest.command === 'migrate' ? await planLegacyMigration(root, manifest.migrationStrategy) : undefined
  // 正式 Context 快照；只读，不由候选编写者修改。
  const live = migration?.graph ?? await loadKnowledge(root, undefined, { sourcePolicy: 'all-tolerant' })
  // 候选声明和显式证据的去重读取事实。
  const sources = migration === undefined ? await transactionSourceFacts(root, graph, manifest.evidencePaths) : undefined
  if (sources !== undefined && sources.expansion.issues.length > 0)
    throw new RuntimeFault('CANDIDATE_SOURCE_INVALID', 'The transaction candidate source evidence is incomplete.')
  // 由完整四字段元组组成的确认集合，无 latest 指针。
  const records = migration?.records ?? deriveRecords(manifest, graph, live, sources!, authorizedDocumentIds(manifest.scope, live, graph, sources!.pathsByDocument, await readGitEvidence(root, manifest.gitEvidencePath)))
  await assertManagedCandidate(root, manifest, records)
  // 依据固定工作流规则重新推导的入口，用于拒绝过期或改写状态。
  const expectedMetadata = migration?.metadata ?? deriveMetadata(manifest, graph, live)
  if (serializeMetadataManifest(graph.metadata!) !== serializeMetadataManifest(expectedMetadata))
    throw new RuntimeFault('CANDIDATE_INVALID', 'Candidate metadata differs from the derived entry.')
  // 重新采样候选和来源，避免在多个 await 间接受混合快照。
  const sourceEvidenceFingerprint = sources?.sourceEvidenceFingerprint ?? await declaredEvidenceFingerprint(root, manifest.evidencePaths)
  // 最终来源采样，用于拒绝验证过程中的输入变化。
  const finalSources = migration === undefined ? await transactionSourceFacts(root, graph, manifest.evidencePaths) : undefined
  if ((finalSources !== undefined && (finalSources.expansion.issues.length > 0 || finalSources.sourceEvidenceFingerprint !== sourceEvidenceFingerprint))
    || await fingerprintTree(root, candidatePath(manifest.runId)) !== graph.contextFingerprint) {
    throw new RuntimeFault('CANDIDATE_SOURCE_INVALID', 'Candidate or sources changed during revalidation.')
  }
  return {
    graph,
    candidateFingerprint: graph.contextFingerprint,
    sourceEvidenceFingerprint,
  }
}

/**
 * 核对批准是否同时绑定当前候选与源码证据。
 * 调用方须先证明重新读取的事实仍匹配清单，否则返回 candidate_stale；两项比较均不能省略。
 */
function approvalMatches(approval: TransactionApproval, facts: ValidatedPair): boolean {
  return approval.approved === true
    && approval.candidateFingerprint === facts.candidateFingerprint
    && approval.sourceEvidenceFingerprint === facts.sourceEvidenceFingerprint
}

/** 重新验证得到的候选图及两个批准指纹。 */
type ValidatedFacts = Awaited<ReturnType<typeof validatedFacts>>

/** 恢复时同时观察的正式、候选与备份目录事实。 */
interface RecoveryFacts {
  /** 当前正式 Context 的目录事实。 */
  readonly live: TreeFact
  /** 本事务候选 Context 的目录事实。 */
  readonly candidate: TreeFact
  /** 目录切换前保存的原始 Context 副本事实。 */
  readonly backup: TreeFact
}

/** 判断某目录是否精确对应事务开始时的正式快照。 */
function isSnapshotFact(manifest: TransactionManifest, fact: TreeFact): boolean {
  return manifest.snapshot.contextState === 'absent'
    ? fact.state === 'absent'
    : fact.state === 'valid' && fact.fingerprint === manifest.snapshot.contextFingerprint
}

/** 判断某目录是否精确对应已验证候选。 */
function isCandidateFact(manifest: ValidatedManifest, fact: TreeFact): boolean {
  return fact.state === 'valid' && fact.fingerprint === manifest.candidateFingerprint
}

/** 判断备份是否精确对应事务开始时存在的正式 Context。 */
function isBackupFact(manifest: TransactionManifest, fact: TreeFact): boolean {
  return manifest.snapshot.contextState === 'present'
    && fact.state === 'valid'
    && fact.fingerprint === manifest.snapshot.contextFingerprint
}

/** 并行读取三个目录副本，供恢复决策使用。 */
async function readRecoveryFacts(root: string, manifest: TransactionManifest): Promise<RecoveryFacts> {
  /** compact 的可信副本还需匹配冻结权限，避免只凭旧版字节指纹恢复。 */
  const read = async (treePath: string): Promise<TreeFact> => {
    const fact = await treeFact(root, treePath)
    if (manifest.compact !== undefined && fact.state === 'valid') {
      const expected = fact.fingerprint === manifest.snapshot.contextFingerprint
        ? manifest.compact.originalModesFingerprint
        : 'candidateFingerprint' in manifest && fact.fingerprint === manifest.candidateFingerprint
          ? manifest.compact.retainedModesFingerprint
          : undefined
      if (expected !== undefined && compactModes(await readTree(root, treePath), treePath) !== expected)
        return { state: 'invalid' }
    }
    return fact
  }
  const [live, candidate, backup] = await Promise.all([
    read(CONTEXT_ROOT),
    read(candidatePath(manifest.runId)),
    read(backupPath(manifest.runId)),
  ])
  return { live, candidate, backup }
}

/** 撤销过期验证和批准，使事务重新进入待验证阶段。 */
async function candidateStale(root: string, manifest: ValidatedManifest): Promise<RuntimeResponse> {
  if (manifest.phase !== 'validated')
    await writeManifest(root, { ...baseFacts(manifest), phase: 'validated', ...validatedPair(manifest) })
  return transactionResponse({ outcome: 'candidate_stale', runId: manifest.runId })
}

/** 保留已验证候选，要求对当前指纹重新进行语义批准。 */
function approvalMismatch(manifest: ValidatedManifest): RuntimeResponse {
  return transactionResponse(
    { outcome: 'approval_mismatch', runId: manifest.runId },
    [diagnostic('APPROVAL_MISMATCH', 'Semantic approval does not match current candidate and source evidence.')],
  )
}

/** 复验已切换的正式树，记录完成结果后清理事务现场。 */
async function finalizeCommitted(
  root: string,
  manifest: ApprovedManifest,
  recoveryOutcome?: 'candidate_completed',
): Promise<RuntimeResponse> {
  // 当前正式 Context 快照，用于授权和并发检查。
  const live = await treeFact(root, CONTEXT_ROOT)
  if (!isCandidateFact(manifest, live))
    throw new RuntimeFault('FINAL_VERIFICATION_FAILED', 'Committed Context does not match the approved candidate.')
  if (manifest.compact !== undefined && compactModes(await readTree(root, CONTEXT_ROOT), CONTEXT_ROOT) !== manifest.compact.retainedModesFingerprint)
    throw new RuntimeFault('FINAL_VERIFICATION_FAILED', 'Committed permissions do not match the compact plan.')
  // 本次调用读取的知识快照，后续判断都以它为依据。
  const graph = await loadKnowledge(root, undefined, { sourcePolicy: 'formal-only' })
  if (graph.formalState !== 'ready' || graph.contextFingerprint !== manifest.candidateFingerprint)
    throw new RuntimeFault('FINAL_VERIFICATION_FAILED', 'Committed Context failed final schema or graph verification.')
  await readConfirmationStore(root, FORMAT)
  // 已通过最终复验、即将持久保存的提交完成清单。
  const committed: TransactionManifest = {
    ...baseFacts(manifest),
    ...validatedPair(manifest),
    phase: 'committed',
    approval: manifest.approval,
    ...(recoveryOutcome === undefined ? {} : { recovery: { outcome: recoveryOutcome } }),
  }
  await writeManifest(root, committed)
  // 当前能力按协议构造的结果响应。
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

/** 先保存正式树为备份，再把已批准候选切换为正式 Context。 */
async function directorySwitch(root: string, manifest: ApprovedManifest): Promise<RuntimeResponse> {
  // 当前事务原始 Context 备份的目录事实。
  const backup = await treeFact(root, backupPath(manifest.runId))
  if (backup.state !== 'absent')
    throw new RuntimeFault('TRANSACTION_LAYOUT_CONFLICT', 'The transaction backup leaf is not empty before directory switch.')
  // 仅供受控目录切换使用的候选绝对路径。
  const candidateAbsolute = await ownedLeafAbsolute(root, `${runPath(manifest.runId)}/candidate`, 'context')
  // 仅供受控目录切换使用的正式 Context 绝对路径。
  const liveAbsolute = await ownedLeafAbsolute(root, undefined, CONTEXT_ROOT)
  if (manifest.snapshot.contextState === 'present') {
    await ensureDirectory(root, `${runPath(manifest.runId)}/backup`)
    // 仅供受控回退使用的原始备份绝对路径。
    const backupAbsolute = await ownedLeafAbsolute(root, `${runPath(manifest.runId)}/backup`, 'context')
    await filesystemOperation(() => fs.rename(liveAbsolute, backupAbsolute), CONTEXT_ROOT)
  }
  await filesystemOperation(() => fs.rename(candidateAbsolute, liveAbsolute), candidatePath(manifest.runId))
  return finalizeCommitted(root, manifest)
}

/** 保留全部冲突副本与锁，且不覆盖已经持久化的回退意图。 */
async function manualRecovery(root: string, manifest: ApprovedManifest): Promise<RuntimeResponse> {
  // 已持久化的回退意图必须保留，后续 resume 依靠它完成幂等恢复。
  if (!hasRestoreIntent(manifest))
    await writeManifest(root, { ...manifest, phase: 'recovery_required', recovery: { outcome: 'manual_recovery' } })
  return transactionResponse({ outcome: 'manual_recovery', runId: manifest.runId })
}

/** 记录没有可信副本的失败状态并保留恢复现场。 */
async function noTrustedCopy(root: string, manifest: ApprovedManifest): Promise<RuntimeResponse> {
  await writeManifest(root, { ...manifest, phase: 'failed', recovery: { outcome: 'no_trusted_copy' } })
  return transactionResponse({ outcome: 'no_trusted_copy', runId: manifest.runId })
}

/** 记录回退完成后清理现场；Migrate 回退明确报告旧布局尚未转换。 */
async function backupRestored(root: string, manifest: ApprovedManifest): Promise<RuntimeResponse> {
  // 记录原始快照已经恢复的事务终态清单。
  const restored: TransactionManifest = { ...manifest, phase: 'restored', recovery: { outcome: 'backup_restored' } }
  await writeManifest(root, restored)
  // 当前能力按协议构造的结果响应。
  const response = transactionResponse({
    outcome: 'backup_restored',
    runId: manifest.runId,
    contextFingerprint: manifest.snapshot.contextFingerprint as string,
  }, manifest.command === 'migrate'
    ? [diagnostic('MIGRATION_ROLLED_BACK', 'The original snapshot was restored. Migration did not complete.', 'warning', CONTEXT_ROOT)]
    : undefined)
  await cleanupTerminalArtifacts(root, restored)
  return response
}

/** 先持久记录回退意图，再幂等恢复可信的原始快照。 */
async function restoreBackup(root: string, manifest: ApprovedManifest, facts: RecoveryFacts): Promise<RuntimeResponse> {
  // 持久账本保存的上次审查或内容一致性记录。
  const recorded = hasRestoreIntent(manifest)
  // 必须先于破坏性目录操作持久保存的回退意图。
  const intent: ApprovedManifest = {
    ...baseFacts(manifest),
    ...validatedPair(manifest),
    phase: 'committing',
    approval: manifest.approval,
    recovery: { intent: 'restore_backup' },
  }
  // 先持久化回退意图再执行破坏性重命名，避免崩溃后误把回退当成提交完成。
  if (!recorded)
    await writeManifest(root, intent)

  // 记录回退意图后重新读取的三份目录事实。
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
  // 仅供受控回退使用的原始备份绝对路径。
  const backupAbsolute = await ownedLeafAbsolute(root, `${runPath(manifest.runId)}/backup`, 'context')
  // 仅供受控目录切换使用的正式 Context 绝对路径。
  const liveAbsolute = await ownedLeafAbsolute(root, undefined, CONTEXT_ROOT)
  await filesystemOperation(() => fs.rename(backupAbsolute, liveAbsolute), backupPath(manifest.runId))
  // 回退操作后重新读取的正式目录事实。
  const restoredLive = await treeFact(root, CONTEXT_ROOT)
  if (!isSnapshotFact(manifest, restoredLive))
    return manualRecovery(root, intent)
  return backupRestored(root, intent)
}

/** 根据三份目录事实和已记录意图继续提交、回退或请求人工恢复。 */
async function recoverCommitting(root: string, manifest: ApprovedManifest): Promise<RuntimeResponse> {
  // 本次重新读取的候选、源码或三个目录副本事实。
  const facts = await readRecoveryFacts(root, manifest)
  if (hasRestoreIntent(manifest))
    return restoreBackup(root, manifest, facts)
  if (isCandidateFact(manifest, facts.live))
    return finalizeCommitted(root, manifest, 'candidate_completed')

  if (isSnapshotFact(manifest, facts.live) && isCandidateFact(manifest, facts.candidate) && facts.backup.state === 'absent') {
    // 重试目录切换前重新验证的候选和源码指纹。
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

/** 复核快照、候选和批准后切换目录，已知切换故障进入恢复决策。 */
async function transactionCommit(root: string, input: TransactionCommitInput): Promise<RuntimeResponse> {
  // 候选写入确认后重新读取的严格校验结果。
  const validated = await loadManifest(root, input.runId)
  if (validated.phase !== 'validated')
    throw new RuntimeFault('TRANSACTION_PHASE_INVALID', 'transaction.commit requires a validated run.')
  // 先判断写锁所有者再读取候选或源码，不能用其他事务的候选错误遮蔽所有权冲突。
  const initialLock = await classifyLock(root)
  if (initialLock.state !== 'valid' || initialLock.runId !== validated.runId)
    return foreignLock(initialLock)

  try {
    await assertPreSwitchSnapshotFresh(root, validated)
  }
  catch (error) {
    return preSwitchFailure(root, validated, error)
  }

  // 本次重新读取的候选、源码或三个目录副本事实。
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

  // 进入目录切换前最后复核的写锁所有者状态。
  const finalLock = await classifyLock(root)
  if (finalLock.state !== 'valid' || finalLock.runId !== validated.runId)
    return foreignLock(finalLock)
  // 已经绑定批准、即将持久保存的提交中清单。
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

/** 恢复时获取缺失的锁，绝不覆盖其他事务所有者。 */
async function acquireResumeLock(root: string, manifest: TransactionManifest): Promise<LockFact> {
  // 当前仓库写锁的所有者状态。
  const lock = await classifyLock(root)
  if (lock.state === 'absent')
    return createLock(root, manifest.runId)
  return lock
}

/** 仅放弃尚未开始目录切换的暂存或已验证事务。 */
async function abandonTransaction(root: string, manifest: TransactionManifest): Promise<RuntimeResponse> {
  if (manifest.phase !== 'staged' && manifest.phase !== 'validated')
    throw new RuntimeFault('TRANSACTION_ABANDON_INVALID', 'Only staged or validated transactions can be abandoned.')
  // 当前事务原始 Context 备份的目录事实。
  const backup = await treeFact(root, backupPath(manifest.runId))
  if (backup.state !== 'absent')
    return lockIncomplete(manifest.runId, true)
  try {
    await assertSnapshotFresh(root, manifest)
  }
  catch (error) {
    return preSwitchFailure(root, manifest, error)
  }
  // 当前能力按协议构造的结果响应。
  const response = transactionResponse({ outcome: 'abandoned', runId: manifest.runId })
  await cleanupTerminalArtifacts(root, manifest)
  return response
}

/** 恢复暂存事务，必要时重新建立丢失的完整候选。 */
async function resumeStaged(root: string, manifest: TransactionManifest): Promise<RuntimeResponse> {
  try {
    await assertPreSwitchSnapshotFresh(root, manifest)
  }
  catch (error) {
    return preSwitchFailure(root, manifest, error)
  }
  // 本次正在校验或推导的候选值。
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
  return transactionResponse({ outcome: manifest.command === 'migrate' ? 'migration_staged' : 'staged', runId: manifest.runId, candidatePath: candidatePath(manifest.runId) })
}

/** 复核已验证事务，返回待审结果或撤销过期验证。 */
async function resumeValidated(root: string, manifest: ValidatedManifest): Promise<RuntimeResponse> {
  try {
    await assertPreSwitchSnapshotFresh(root, manifest)
  }
  catch (error) {
    return preSwitchFailure(root, manifest, error)
  }
  // 本次重新读取的候选、源码或三个目录副本事实。
  let facts: ValidatedFacts
  try {
    facts = await validatedFacts(root, manifest)
  }
  catch (error) {
    if (!(error instanceof RuntimeFault))
      throw error
    if (error.code === 'REPOSITORY_IO_FAILED' || SNAPSHOT_CONFLICTS.has(error.code))
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
    // 当前能力按协议构造的结果响应。
    const response = transactionResponse({ outcome: 'validated', runId: manifest.runId, candidateFingerprint, sourceEvidenceFingerprint })
    await cleanupTerminalArtifacts(root, manifest)
    return response
  }
  return transactionResponse({ outcome: 'ready_for_review', runId: manifest.runId, candidateFingerprint, sourceEvidenceFingerprint, ...(manifest.compact === undefined ? {} : { retention: { ...manifest.compact.summary } }) })
}

/** 重新证明清单记录的终态与当前副本一致后才清理现场。 */
async function terminalResume(root: string, manifest: ApprovedManifest): Promise<RuntimeResponse> {
  // 本次重新读取的候选、源码或三个目录副本事实。
  const facts = await readRecoveryFacts(root, manifest)
  if (manifest.phase === 'committed' && isCandidateFact(manifest, facts.live)) {
    // 本次调用读取的知识快照，后续判断都以它为依据。
    const graph = await loadKnowledge(root, undefined, { sourcePolicy: 'formal-only' })
    if (graph.formalState !== 'ready' || graph.contextFingerprint !== manifest.candidateFingerprint)
      return manualRecovery(root, manifest)
    // 当前能力按协议构造的结果响应。
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

/** 按清单阶段恢复事务，或处理显式放弃请求。 */
async function transactionResume(root: string, input: TransactionResumeInput): Promise<RuntimeResponse> {
  // 已解析的事务阶段、冻结输入和恢复事实。
  const manifest = await loadManifest(root, input.runId)
  // 当前仓库写锁的所有者状态。
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

/**
 * 以安全仓库根目录为边界执行一个事务动作。
 *
 * @param root - 业务仓库根目录。
 * @param request - 当前能力的请求；除入口解析函数外应已通过协议校验。
 * @returns 当前动作的事务响应，具体 outcome 指明继续、清理或人工恢复要求。
 * @throws 可预期错误按阶段转换为响应；未知异常继续抛出并保留需要恢复的现场。
 * @remarks 调用阶段：显式授权后的事务 begin、validate、commit 或 resume；按阶段写入自有候选、确认及恢复现场。
 */
export async function transaction(root: string, request: RuntimeRequest): Promise<RuntimeResponse> {
  switch (request.action) {
    case 'begin': return transactionBegin(root, request.input as TransactionBeginInput)
    case 'validate': return transactionValidate(root, request.input as TransactionValidateInput)
    case 'commit': return transactionCommit(root, request.input as TransactionCommitInput)
    case 'resume': return transactionResume(root, request.input as TransactionResumeInput)
    default: throw new RuntimeFault('ACTION_UNKNOWN', 'transaction action is unknown.')
  }
}
