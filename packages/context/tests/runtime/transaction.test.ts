import type { RuntimeResponse } from '../../src/runtime/protocol.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { call, CLIENT_DOMAIN, createRepository, documentSource, handle, porcelainModified, PROTOCOL, removeRepository, REVISION_A, REVISION_C, SERVICE_DOMAIN, SERVICE_GUIDE, transactionCall, writeGitEvidence, writeMeta } from './fixture.js'

// 当前测试文件拥有的临时仓库集合，由 afterEach 统一清理。
const roots: string[] = []
// 修改服务正文后的固定夹具，用于事务验证和恢复测试。
const changedService = { ...SERVICE_DOMAIN, body: '# Service\n\nChanged service behavior.\n' }

/** 测试主助手批准，绑定候选与源码证据两个指纹。 */
interface Approval {
  /** 是否显式批准；可提交的批准必须为 true。 */
  readonly approved: true
  /** 已验证候选完整目录树的 SHA-256 指纹。 */
  readonly candidateFingerprint: string
  /** 当前候选引用源码与显式证据的整体 SHA-256 指纹。 */
  readonly sourceEvidenceFingerprint: string
  /** 审查批准的简短说明；不替代指纹绑定。 */
  readonly summary: string
}

/** 已验证测试事务及其候选、证据和批准，供故障注入复用。 */
interface PreparedRun {
  /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
  readonly runId: string
  /** 当前测试事务拥有的完整候选目录。 */
  readonly candidatePath: string
  /** 本次工作流拥有的 .scratch/evidence/ 直接子目录。 */
  readonly gitEvidencePath: string
  /** 对当前已验证候选与源码证据的显式批准。 */
  readonly approval: Approval
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(removeRepository))
})

/** 从测试响应取得必需字符串字段，缺失时立即失败。 */
function dataString(response: RuntimeResponse, key: string): string {
  // 从测试响应取得的必需字段，缺失或类型错误时立即失败。
  const value = response.data?.[key]
  if (typeof value !== 'string')
    throw new TypeError(`Response data.${key} is not a string.`)
  return value
}

/** 用验证响应的两个指纹构造测试批准。 */
function approval(response: RuntimeResponse): Approval {
  return {
    approved: true,
    candidateFingerprint: dataString(response, 'candidateFingerprint'),
    sourceEvidenceFingerprint: dataString(response, 'sourceEvidenceFingerprint'),
    summary: 'Independent semantic review approved the candidate.',
  }
}

/** 创建具有领域、指南和固定账本基线的测试仓库。 */
async function readyRoot(): Promise<string> {
  // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
  const root = await createRepository({
    documents: [SERVICE_DOMAIN, SERVICE_GUIDE, CLIENT_DOMAIN],
    baselineRevision: REVISION_A,
  })
  roots.push(root)
  return root
}

/** 检查测试仓库中的指定路径是否仍存在。 */
async function exists(root: string, relative: string): Promise<boolean> {
  return fs.access(path.join(root, relative)).then(() => true, () => false)
}

/** 收集固定 Git 证据并开始 Update 测试事务。 */
async function beginUpdate(root: string, options: {
  /** 为 true 时验证后结束并清理，不切换正式 Context。 */
  readonly dryRun?: boolean
  /** 宿主显式补充的仓库相对证据声明，事务期间必须保持新鲜。 */
  readonly evidencePaths?: readonly string[]
} = {}): Promise<{
  /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
  readonly runId: string
  /** 当前事务拥有的完整候选 Context 相对目录。 */
  readonly candidatePath: string
  /** 本次工作流拥有的 .scratch/evidence/ 直接子目录。 */
  readonly gitEvidencePath: string
}> {
  const gitEvidencePath = await writeGitEvidence(root)
  const response = await transactionCall(root, 'begin', {
    command: 'update',
    mode: 'deep',
    dryRun: options.dryRun ?? false,
    scope: { kind: 'repository' },
    gitEvidencePath,
    evidencePaths: options.evidencePaths ?? ['src/service.ts'],
  })
  expect(response.status, JSON.stringify(response)).toBe('success')
  return { runId: dataString(response, 'runId'), candidatePath: dataString(response, 'candidatePath'), gitEvidencePath }
}

/** 建立含内容变化的候选并取得验证指纹，供提交和恢复测试使用。 */
async function prepareChanged(root: string, options: {
  /** 为 true 时验证后结束并清理，不切换正式 Context。 */
  readonly dryRun?: boolean
  /** 测试是否使用 glob 声明覆盖源码。 */
  readonly glob?: boolean
} = {}): Promise<PreparedRun> {
  // 当前测试已建立的事务与候选路径。
  const prepared = await beginUpdate(root, {
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    evidencePaths: options.glob ? ['src/*.ts'] : ['src/service.ts'],
  })
  // 当前通过 ID 找到的文档，作为本次判断的依据。
  const document = options.glob ? { ...changedService, codePaths: ['src/*.ts'] } : changedService
  await fs.writeFile(path.join(root, prepared.candidatePath, SERVICE_DOMAIN.relativePath), documentSource(document))
  const validated = await transactionCall(root, 'validate', { runId: prepared.runId })
  expect(validated.status).toBe(options.dryRun ? 'dry_run' : 'success')
  return { ...prepared, approval: approval(validated) }
}

/** 读取测试事务清单，用于核对阶段与冻结授权。 */
async function readManifest(root: string, runId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(root, `.scratch/runs/${runId}/manifest.json`), 'utf8')) as Record<string, unknown>
}

/** 按测试场景修改持久清单，以模拟中断或损坏状态。 */
async function updateManifest(root: string, runId: string, update: (manifest: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  // 当前受检文件的实际路径，仅用于内部读写操作。
  const file = path.join(root, '.scratch', 'runs', runId, 'manifest.json')
  await fs.writeFile(file, `${JSON.stringify(update(await readManifest(root, runId)), null, 2)}\n`)
}

/** 将已验证夹具标为正在提交，模拟目录切换前的崩溃窗口。 */
async function markCommitting(root: string, run: PreparedRun): Promise<void> {
  // 当前受检文件的实际路径，仅用于内部读写操作。
  const file = path.join(root, `.scratch/runs/${run.runId}/manifest.json`)
  // 已解析的事务阶段、冻结输入和恢复事实。
  const manifest = await readManifest(root, run.runId)
  await fs.writeFile(file, `${JSON.stringify({ ...manifest, phase: 'committing', approval: run.approval }, null, 2)}\n`)
}

/** 写入已提交阶段，模拟提交完成但尚未清理的现场。 */
async function markCommitted(root: string, run: PreparedRun): Promise<void> {
  // 当前受检文件的实际路径，仅用于内部读写操作。
  const file = path.join(root, `.scratch/runs/${run.runId}/manifest.json`)
  // 已解析的事务阶段、冻结输入和恢复事实。
  const manifest = await readManifest(root, run.runId)
  await fs.writeFile(file, `${JSON.stringify({ ...manifest, phase: 'committed', approval: run.approval }, null, 2)}\n`)
}

describe('transaction lifecycle', () => {
  it('stages a complete candidate under one write lock and leaves read capabilities available', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    const first = await beginUpdate(root)
    const second = await transactionCall(root, 'begin', {
      command: 'update',
      mode: 'light',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath: '.scratch/evidence/request',
      evidencePaths: ['src/service.ts'],
    })
    const inspected = await handle(root, { protocol: PROTOCOL, format: 1, capability: 'repository.inspect', input: {} })

    expect(second.status).toBe('incomplete')
    expect(second.data).toMatchObject({ runId: first.runId, outcome: 'active_run', nextAction: 'resume' })
    expect(inspected.status).toBe('success')
    expect(await fs.readFile(path.join(root, first.candidatePath, SERVICE_DOMAIN.relativePath), 'utf8')).toBe(documentSource(SERVICE_DOMAIN))
    expect(JSON.stringify(await readManifest(root, first.runId))).not.toContain(root)
  })

  it.each([
    ['init', 'light', true, 'TRANSACTION_MODE_INVALID'],
    ['init', 'deep', true, 'TRANSACTION_PRECONDITION_FAILED'],
    ['prune', 'light', true, 'TRANSACTION_MODE_INVALID'],
    ['update', 'deep', false, 'TRANSACTION_PRECONDITION_FAILED'],
  ] as const)('enforces %s/%s begin preconditions', async (command, mode, withContext, code) => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await createRepository({
      ...(withContext ? { documents: [SERVICE_DOMAIN], baselineRevision: REVISION_A } : {}),
    })
    roots.push(root)
    const gitEvidencePath = await writeGitEvidence(root)
    const response = await transactionCall(root, 'begin', {
      command,
      mode,
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath,
      evidencePaths: ['src/service.ts'],
    })

    expect(response.status).toBe('failed')
    expect(response.diagnostics?.[0]?.code).toBe(code)
  })

  it('initializes an absent repository from an empty complete candidate root', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await createRepository()
    roots.push(root)
    const gitEvidencePath = await writeGitEvidence(root)
    const began = await transactionCall(root, 'begin', {
      command: 'init',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath,
      evidencePaths: ['src/service.ts'],
    })
    // 当前事务的 UUID，也是其运行目录和写锁的所有权标识。
    const runId = dataString(began, 'runId')
    // 本测试事务独占的完整候选 Context 相对目录。
    const candidatePath = dataString(began, 'candidatePath')
    await fs.mkdir(path.join(root, candidatePath, 'service'), { recursive: true })
    await fs.writeFile(path.join(root, candidatePath, SERVICE_DOMAIN.relativePath), documentSource(SERVICE_DOMAIN))
    const validated = await transactionCall(root, 'validate', { runId })
    const committed = await transactionCall(root, 'commit', { runId, approval: approval(validated) })

    expect(validated.status).toBe('success')
    expect(committed.status).toBe('success')
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')).toBe(documentSource(SERVICE_DOMAIN))
  })

  it('commits a deep prune when complete source coverage remains', async () => {
    // 允许在 Prune 中删除且不丢失唯一覆盖的文档夹具。
    const removableGuide = {
      relativePath: SERVICE_GUIDE.relativePath,
      id: SERVICE_GUIDE.id,
      kind: 'guide' as const,
      domain: SERVICE_GUIDE.domain,
      description: 'Retry behavior and constraints.',
      relations: { requires: ['service'] },
      body: '# Retry\n\nRetry only transient failures.\n',
    }
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await createRepository({
      documents: [SERVICE_DOMAIN, removableGuide, CLIENT_DOMAIN],
      baselineRevision: REVISION_A,
    })
    roots.push(root)
    const gitEvidencePath = await writeGitEvidence(root)
    const began = await transactionCall(root, 'begin', {
      command: 'prune',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath,
      evidencePaths: ['src/service.ts'],
    })
    // 当前事务的 UUID，也是其运行目录和写锁的所有权标识。
    const runId = dataString(began, 'runId')
    // 本测试事务独占的完整候选 Context 相对目录。
    const candidatePath = dataString(began, 'candidatePath')
    await fs.rm(path.join(root, candidatePath, 'service/manual'), { recursive: true })
    const validated = await transactionCall(root, 'validate', { runId })
    const committed = await transactionCall(root, 'commit', { runId, approval: approval(validated) })

    expect(validated.status).toBe('success')
    expect(committed.status).toBe('success')
    expect(await fs.access(path.join(root, 'context/service/manual')).then(() => true, () => false)).toBe(false)
  })

  it('derives Meta, binds approval, switches whole directories, returns a bounded summary, and clears owned leaves', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await prepareChanged(root)
    // 已解析的事务阶段、冻结输入和恢复事实。
    const manifest = await readManifest(root, run.runId)
    const candidateMeta = JSON.parse(await fs.readFile(path.join(root, run.candidatePath, '.meta/manifest.json'), 'utf8')) as Record<string, unknown>
    const committed = await transactionCall(root, 'commit', { runId: run.runId, approval: run.approval })

    expect(manifest.phase).toBe('validated')
    expect(candidateMeta).toMatchObject({
      format: 1,
    })
    expect(committed.status).toBe('success')
    expect(committed.data).toMatchObject({
      outcome: 'committed',
      approvedCandidateFingerprint: run.approval.candidateFingerprint,
      approvedSourceEvidenceFingerprint: run.approval.sourceEvidenceFingerprint,
    })
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')).toBe(documentSource(changedService))
    expect(committed.data).not.toHaveProperty('reportPath')
    expect(JSON.stringify(committed)).not.toContain(root)
    expect(JSON.stringify(committed)).not.toMatch(/timestamp|createdAt|updatedAt|process\.env/i)
    expect(await exists(root, `.scratch/runs/${run.runId}`)).toBe(false)
    expect(await exists(root, run.gitEvidencePath)).toBe(false)
    expect(await exists(root, '.scratch/locks/context-write')).toBe(false)

    const terminal = await transactionCall(root, 'resume', { runId: run.runId })
    expect(terminal.status).toBe('failed')
  })

  it('terminates byte-equivalent candidates as no_change without a directory switch', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    const before = await fs.readFile(path.join(root, 'context/.meta/manifest.json'))
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await beginUpdate(root)
    const result = await transactionCall(root, 'validate', { runId: run.runId })

    expect(result.status).toBe('no_change')
    expect(result.data?.outcome).toBe('no_change')
    expect(await fs.readFile(path.join(root, 'context/.meta/manifest.json'))).toEqual(before)
    expect(await exists(root, `.scratch/runs/${run.runId}`)).toBe(false)
    expect(await exists(root, run.gitEvidencePath)).toBe(false)
    expect(await exists(root, '.scratch/locks/context-write')).toBe(false)
  })

  it('returns dry-run fingerprints, leaves formal Context untouched, and makes the cleaned run non-resumable', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    const before = await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await prepareChanged(root, { dryRun: true })

    expect(await exists(root, '.scratch/locks/context-write')).toBe(false)
    expect(await exists(root, `.scratch/runs/${run.runId}`)).toBe(false)
    expect(await exists(root, run.gitEvidencePath)).toBe(false)
    const resumed = await transactionCall(root, 'resume', { runId: run.runId })
    expect(resumed.status).toBe('failed')
    const committed = await transactionCall(root, 'commit', { runId: run.runId, approval: run.approval })
    expect(committed.status).toBe('failed')
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')).toBe(before)
    expect(await exists(root, run.candidatePath)).toBe(false)
  })

  it('allows source-degraded deep Update, but rejects Prune and non-repository Init scope', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    await fs.rm(path.join(root, 'src/retry.ts'))
    const updateEvidence = await writeGitEvidence(root, { id: 'degraded-update' })
    const update = await transactionCall(root, 'begin', {
      command: 'update',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath: updateEvidence,
      evidencePaths: ['src/service.ts'],
    })
    expect(update).toMatchObject({ status: 'success', data: { outcome: 'staged' } })
    await transactionCall(root, 'resume', { runId: dataString(update, 'runId'), disposition: 'abandon' })

    const pruneEvidence = await writeGitEvidence(root, { id: 'degraded-prune' })
    const prune = await transactionCall(root, 'begin', {
      command: 'prune',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath: pruneEvidence,
      evidencePaths: ['src/service.ts'],
    })
    expect(prune).toMatchObject({ status: 'failed', diagnostics: [{ code: 'TRANSACTION_PRECONDITION_FAILED' }] })

    // 解析缺省关系时使用的空关系集合。
    const empty = await createRepository()
    roots.push(empty)
    const initEvidence = await writeGitEvidence(empty, { id: 'invalid-init-scope' })
    const init = await transactionCall(empty, 'begin', {
      command: 'init',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'domains', ids: ['service'] },
      gitEvidencePath: initEvidence,
      evidencePaths: ['src/service.ts'],
    })
    expect(init).toMatchObject({ status: 'failed', diagnostics: [{ code: 'TRANSACTION_SCOPE_INVALID' }] })
  })

  it('abandons only fresh staged or validated runs and cleans all owned leaves', async () => {
    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const stagedRoot = await readyRoot()
    const staged = await beginUpdate(stagedRoot)
    const abandoned = await transactionCall(stagedRoot, 'resume', { runId: staged.runId, disposition: 'abandon' })
    expect(abandoned).toMatchObject({ status: 'success', data: { runId: staged.runId, outcome: 'abandoned' } })
    expect(await exists(stagedRoot, `.scratch/runs/${staged.runId}`)).toBe(false)
    expect(await exists(stagedRoot, staged.gitEvidencePath)).toBe(false)
    expect(await exists(stagedRoot, '.scratch/locks/context-write')).toBe(false)

    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const validatedRoot = await readyRoot()
    const validated = await prepareChanged(validatedRoot)
    expect(await transactionCall(validatedRoot, 'resume', { runId: validated.runId, disposition: 'abandon' })).toMatchObject({
      status: 'success',
      data: { outcome: 'abandoned' },
    })

    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const committingRoot = await readyRoot()
    // 已经绑定批准、即将持久保存的提交中清单。
    const committing = await prepareChanged(committingRoot)
    await markCommitting(committingRoot, committing)
    const rejected = await transactionCall(committingRoot, 'resume', { runId: committing.runId, disposition: 'abandon' })
    expect(rejected).toMatchObject({ status: 'failed', diagnostics: [{ code: 'TRANSACTION_ABANDON_INVALID' }] })
    expect(await exists(committingRoot, `.scratch/runs/${committing.runId}`)).toBe(true)
    expect(await exists(committingRoot, '.scratch/locks/context-write')).toBe(true)
  })
})

describe('transaction validation and concurrency', () => {
  it('rejects incomplete candidates and prune candidates that lose source coverage', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    const invalid = await beginUpdate(root)
    await fs.rm(path.join(root, invalid.candidatePath, 'service/domain.md'))
    const invalidResult = await transactionCall(root, 'validate', { runId: invalid.runId })
    expect(invalidResult.status).toBe('incomplete')
    expect(invalidResult.data).toMatchObject({ outcome: 'candidate_edit_required', nextAction: 'edit_candidate' })
    expect(invalidResult.diagnostics?.map(item => item.code)).toContain('DOMAIN_DOCUMENT_MISSING')
    expect(await exists(root, `.scratch/runs/${invalid.runId}`)).toBe(true)
    expect(await exists(root, invalid.gitEvidencePath)).toBe(true)
    await transactionCall(root, 'resume', { runId: invalid.runId, disposition: 'abandon' })

    // 当前工作流拥有的宿主 Git 证据叶子或已校验快照。
    const evidence = await writeGitEvidence(root, { id: 'prune' })
    const began = await transactionCall(root, 'begin', {
      command: 'prune',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath: evidence,
      evidencePaths: ['src/service.ts'],
    })
    // 当前事务的 UUID，也是其运行目录和写锁的所有权标识。
    const runId = dataString(began, 'runId')
    // 本次正在校验或推导的候选值。
    const candidate = dataString(began, 'candidatePath')
    await fs.rm(path.join(root, candidate, 'service/manual'), { recursive: true })
    const pruned = await transactionCall(root, 'validate', { runId })
    expect(pruned.status).toBe('incomplete')
    expect(pruned.data).toMatchObject({ outcome: 'candidate_edit_required', nextAction: 'edit_candidate' })
    expect(pruned.diagnostics?.[0]?.code).toBe('PRUNE_COVERAGE_LOST')
    expect(await exists(root, `.scratch/runs/${runId}`)).toBe(true)
    expect(await exists(root, evidence)).toBe(true)
  })

  it('keeps a Prune candidate editable when live source coverage degrades after begin', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    const gitEvidencePath = await writeGitEvidence(root, { id: 'prune-degraded' })
    const began = await transactionCall(root, 'begin', {
      command: 'prune',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath,
      evidencePaths: ['src/service.ts'],
    })
    // 当前事务的 UUID，也是其运行目录和写锁的所有权标识。
    const runId = dataString(began, 'runId')
    // Prune 在 begin 时要求完整证据；之后丢失源码应保留可编辑候选，而不是静默通过或误报为机械失败。
    await fs.rm(path.join(root, 'src/retry.ts'))

    const result = await transactionCall(root, 'validate', { runId })

    // 候选源码展开首先报告具体缺失声明，PRUNE_SOURCE_DEGRADED 只是后备检查；两种情况都保留事务与锁。
    expect(result).toMatchObject({
      status: 'incomplete',
      data: { outcome: 'candidate_edit_required', nextAction: 'edit_candidate' },
    })
    expect(result.diagnostics?.map(item => item.code)).toContain('SOURCE_EXACT_MISSING')
    expect(await exists(root, `.scratch/runs/${runId}`)).toBe(true)
    expect(await exists(root, '.scratch/locks/context-write')).toBe(true)
  })

  it('stops validate when declared source or formal Context changed after begin', async () => {
    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const sourceRoot = await readyRoot()
    // 当前故障场景建立的事务及候选路径，后续用于注入变化。
    const sourceRun = await beginUpdate(sourceRoot)
    await fs.appendFile(path.join(sourceRoot, 'src/service.ts'), 'export const changed = true\n')
    const sourceResult = await transactionCall(sourceRoot, 'validate', { runId: sourceRun.runId })
    expect(sourceResult.status).toBe('failed')
    expect(sourceResult.diagnostics?.[0]?.code).toBe('DECLARED_EVIDENCE_CONFLICT')
    expect(await exists(sourceRoot, `.scratch/runs/${sourceRun.runId}`)).toBe(false)
    expect(await exists(sourceRoot, sourceRun.gitEvidencePath)).toBe(false)

    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const formalRoot = await readyRoot()
    // 当前故障场景建立的事务及候选路径，后续用于注入变化。
    const formalRun = await beginUpdate(formalRoot)
    await fs.appendFile(path.join(formalRoot, 'context/service/domain.md'), '\n')
    const formalResult = await transactionCall(formalRoot, 'validate', { runId: formalRun.runId })
    expect(formalResult.status).toBe('failed')
    expect(formalResult.diagnostics?.[0]?.code).toBe('FORMAL_CONTEXT_CONFLICT')
    expect(await exists(formalRoot, `.scratch/runs/${formalRun.runId}`)).toBe(false)
    expect(await exists(formalRoot, formalRun.gitEvidencePath)).toBe(false)
  })

  it('treats any byte replacement of the frozen Git evidence as snapshot stale', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await beginUpdate(root)
    await fs.appendFile(path.join(root, run.gitEvidencePath, 'mid-operation.json'), '\n')

    const result = await transactionCall(root, 'validate', { runId: run.runId })

    expect(result).toMatchObject({
      status: 'failed',
      data: { outcome: 'snapshot_stale', nextAction: 'restart_transaction' },
      diagnostics: [{ code: 'GIT_EVIDENCE_CONFLICT' }],
    })
    expect(await exists(root, `.scratch/runs/${run.runId}`)).toBe(false)
    expect(await exists(root, run.gitEvidencePath)).toBe(false)
  })

  it.each(['add', 'delete', 'move', 'content'] as const)('rejects an out-of-scope %s mutation and preserves the editable candidate', async (mutation) => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    const gitEvidencePath = await writeGitEvidence(root, { id: `scope-${mutation}` })
    const began = await transactionCall(root, 'begin', {
      command: 'update',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'domains', ids: ['client'] },
      gitEvidencePath,
      evidencePaths: ['src/client.ts'],
    })
    // 当前事务的 UUID，也是其运行目录和写锁的所有权标识。
    const runId = dataString(began, 'runId')
    // 本次正在校验或推导的候选值。
    const candidate = dataString(began, 'candidatePath')
    if (mutation === 'add') {
      // 候选中新增的文档夹具，用于范围授权验证。
      const added = {
        relativePath: 'service/manual/new-guide.md',
        id: 'service.new-guide',
        kind: 'guide' as const,
        domain: 'service',
        relations: { requires: ['service'] },
        body: '# New guide\n\nNew knowledge.\n',
      }
      await fs.writeFile(path.join(root, candidate, added.relativePath), documentSource(added))
    }
    else if (mutation === 'delete') {
      await fs.rm(path.join(root, candidate, SERVICE_GUIDE.relativePath))
      await fs.rmdir(path.join(root, candidate, 'service/manual'))
    }
    else if (mutation === 'move') {
      await fs.rename(
        path.join(root, candidate, SERVICE_GUIDE.relativePath),
        path.join(root, candidate, 'service/manual/retry-moved.md'),
      )
    }
    else {
      await fs.writeFile(path.join(root, candidate, SERVICE_DOMAIN.relativePath), documentSource(changedService))
    }

    const result = await transactionCall(root, 'validate', { runId })

    expect(result).toMatchObject({
      status: 'incomplete',
      data: { outcome: 'candidate_edit_required', nextAction: 'edit_candidate' },
      diagnostics: [{ code: 'CANDIDATE_SCOPE_VIOLATION' }],
    })
    expect(await exists(root, `.scratch/runs/${runId}`)).toBe(true)
    expect(await exists(root, gitEvidencePath)).toBe(true)
  })

  it('returns incomplete without switching when candidate, source content, glob set, formal Context, or approval changes', async () => {
    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const candidateRoot = await readyRoot()
    // 当前故障场景建立的事务及候选路径，后续用于注入变化。
    const candidateRun = await prepareChanged(candidateRoot)
    await fs.appendFile(path.join(candidateRoot, candidateRun.candidatePath, SERVICE_DOMAIN.relativePath), '\n')
    const candidateResult = await transactionCall(candidateRoot, 'commit', { runId: candidateRun.runId, approval: candidateRun.approval })
    expect(candidateResult.status).toBe('incomplete')
    expect(candidateResult.data).toMatchObject({ outcome: 'candidate_stale', nextAction: 'validate' })

    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const sourceRoot = await readyRoot()
    // 当前故障场景建立的事务及候选路径，后续用于注入变化。
    const sourceRun = await prepareChanged(sourceRoot)
    await fs.appendFile(path.join(sourceRoot, 'src/service.ts'), 'export const concurrent = true\n')
    const sourceResult = await transactionCall(sourceRoot, 'commit', { runId: sourceRun.runId, approval: sourceRun.approval })
    expect(sourceResult.status).toBe('failed')
    expect(sourceResult.data).toMatchObject({ outcome: 'snapshot_stale', nextAction: 'restart_transaction' })

    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const globRoot = await readyRoot()
    // 当前故障场景建立的事务及候选路径，后续用于注入变化。
    const globRun = await prepareChanged(globRoot, { glob: true })
    await fs.writeFile(path.join(globRoot, 'src/new.ts'), 'export const added = true\n')
    expect(await transactionCall(globRoot, 'commit', { runId: globRun.runId, approval: globRun.approval })).toMatchObject({
      status: 'failed',
      data: { outcome: 'snapshot_stale', nextAction: 'restart_transaction' },
    })

    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const formalRoot = await readyRoot()
    // 当前故障场景建立的事务及候选路径，后续用于注入变化。
    const formalRun = await prepareChanged(formalRoot)
    await fs.appendFile(path.join(formalRoot, 'context/client/domain.md'), '\n')
    expect(await transactionCall(formalRoot, 'commit', { runId: formalRun.runId, approval: formalRun.approval })).toMatchObject({
      status: 'failed',
      data: { outcome: 'snapshot_stale', nextAction: 'restart_transaction' },
    })

    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const approvalRoot = await readyRoot()
    // 当前故障场景建立的事务及候选路径，后续用于注入变化。
    const approvalRun = await prepareChanged(approvalRoot)
    // 故意破坏候选指纹的批准输入。
    const mismatched = { ...approvalRun.approval, candidateFingerprint: '0'.repeat(64) }
    const approvalResult = await transactionCall(approvalRoot, 'commit', { runId: approvalRun.runId, approval: mismatched })
    expect(approvalResult.status).toBe('incomplete')
    expect(approvalResult.diagnostics?.[0]?.code).toBe('APPROVAL_MISMATCH')
  })

  it('preserves repository baseline across history rewrites and updates', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    const gitEvidencePath = await writeGitEvidence(root, { id: 'baseline-gap', revision: REVISION_C })
    const began = await transactionCall(root, 'begin', {
      command: 'update',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath,
      evidencePaths: ['src/service.ts'],
    })
    // 当前事务的 UUID，也是其运行目录和写锁的所有权标识。
    const runId = dataString(began, 'runId')
    // 本测试事务独占的完整候选 Context 相对目录。
    const candidatePath = dataString(began, 'candidatePath')
    await fs.writeFile(path.join(root, candidatePath, SERVICE_DOMAIN.relativePath), documentSource(changedService))

    const validated = await transactionCall(root, 'validate', { runId })
    const meta = JSON.parse(await fs.readFile(path.join(root, candidatePath, '.meta/manifest.json'), 'utf8')) as {
      /** 上次可证明全仓审查完成时记录的源码基线。 */
      repository?: {
        /** 特定用途的持久基线，不能因局部修复自动推进。 */
        baseline?: {
          /** 完整 Git 提交对象 ID，不依赖分支名称。 */
          revision?: string
        }
      }
    }

    expect(validated.status).toBe('success')
    expect(meta.repository?.baseline?.revision).toBe(REVISION_A)
  })

  it.each(['candidateFingerprint', 'sourceEvidenceFingerprint'] as const)('rejects an approval whose %s does not bind current bytes', async (field) => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await prepareChanged(root)
    // 分别破坏两个批准指纹，验证任何一项比较都不能省略。
    const approval = { ...run.approval, [field]: 'b'.repeat(64) }

    const result = await transactionCall(root, 'commit', { runId: run.runId, approval })

    expect(result).toMatchObject({
      status: 'incomplete',
      data: { outcome: 'approval_mismatch', nextAction: 'semantic_review' },
      diagnostics: [{ code: 'APPROVAL_MISMATCH' }],
    })
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')).toBe(documentSource(SERVICE_DOMAIN))
  })

  it('invalidates the old approval after a validated candidate changes', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await prepareChanged(root)
    // 第二次更改的候选正文，用于验证旧批准失效。
    const changedAgain = { ...changedService, body: '# Service\n\nA second reviewed candidate.\n' }
    await fs.writeFile(path.join(root, run.candidatePath, SERVICE_DOMAIN.relativePath), documentSource(changedAgain))
    const revalidated = await transactionCall(root, 'validate', { runId: run.runId })
    expect(revalidated.status).toBe('success')
    expect(dataString(revalidated, 'candidateFingerprint')).not.toBe(run.approval.candidateFingerprint)

    const staleApproval = await transactionCall(root, 'commit', { runId: run.runId, approval: run.approval })
    expect(staleApproval.status).toBe('incomplete')
    expect(staleApproval.diagnostics?.[0]?.code).toBe('APPROVAL_MISMATCH')
  })

  it('includes every candidate code path in approval freshness even when it was not declared at begin', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await prepareChanged(root)
    await fs.appendFile(path.join(root, 'src/retry.ts'), 'export const concurrentRetry = true\n')

    const result = await transactionCall(root, 'commit', { runId: run.runId, approval: run.approval })

    expect(result).toMatchObject({
      status: 'incomplete',
      data: { outcome: 'candidate_stale', nextAction: 'validate' },
    })
    expect((await readManifest(root, run.runId)).phase).toBe('validated')
    expect(await exists(root, run.gitEvidencePath)).toBe(true)
  })

  it('rejects an invalid manifest without deleting the active scene', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await beginUpdate(root)
    await updateManifest(root, run.runId, manifest => ({ ...manifest, unexpected: true }))

    const result = await transactionCall(root, 'validate', { runId: run.runId })

    expect(result).toMatchObject({ status: 'failed', diagnostics: [{ code: 'TRANSACTION_MANIFEST_INVALID' }] })
    expect(result.data).toBeUndefined()
    expect(await exists(root, `.scratch/runs/${run.runId}`)).toBe(true)
    expect(await exists(root, '.scratch/locks/context-write')).toBe(true)
  })

  it('checks the current lock owner before reading a stale candidate', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await prepareChanged(root)
    await fs.appendFile(path.join(root, run.candidatePath, SERVICE_DOMAIN.relativePath), '\ninvalid after validation\n')
    // 模拟竞争写者的固定事务 UUID。
    const otherRunId = '22222222-2222-4222-8222-222222222222'
    // 模拟竞争事务拥有的运行目录。
    const otherDirectory = path.join(root, '.scratch', 'runs', otherRunId)
    await fs.mkdir(otherDirectory, { recursive: true })
    await fs.writeFile(
      path.join(otherDirectory, 'manifest.json'),
      `${JSON.stringify({ ...(await readManifest(root, run.runId)), runId: otherRunId }, null, 2)}\n`,
    )
    await fs.writeFile(path.join(root, '.scratch/locks/context-write/owner.json'), JSON.stringify({
      kind: 'plugydown.context.lock',
      format: 1,
      runId: otherRunId,
    }))

    const result = await transactionCall(root, 'commit', { runId: run.runId, approval: run.approval })

    expect(result).toMatchObject({
      status: 'incomplete',
      data: { runId: otherRunId, outcome: 'active_run', nextAction: 'resume' },
    })
  })

  it('resumes only fresh staged/validated runs and safely reacquires a lost same-run lock', async () => {
    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const stagedRoot = await readyRoot()
    // 当前故障场景建立的事务及候选路径，后续用于注入变化。
    const stagedRun = await beginUpdate(stagedRoot)
    await fs.rm(path.join(stagedRoot, '.scratch/locks/context-write'), { recursive: true })
    const staged = await transactionCall(stagedRoot, 'resume', { runId: stagedRun.runId })
    expect(staged.status).toBe('success')
    expect(staged.data?.nextAction).toBe('edit_candidate')
    await fs.appendFile(path.join(stagedRoot, 'src/service.ts'), 'export const stagedStale = true\n')
    const stagedStale = await transactionCall(stagedRoot, 'resume', { runId: stagedRun.runId })
    expect(stagedStale.status).toBe('failed')
    expect(stagedStale.data).toMatchObject({ outcome: 'snapshot_stale', nextAction: 'restart_transaction' })

    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await prepareChanged(root)
    await fs.rm(path.join(root, '.scratch/locks/context-write'), { recursive: true })
    const fresh = await transactionCall(root, 'resume', { runId: run.runId })
    expect(fresh.status).toBe('success')
    expect(fresh.data?.nextAction).toBe('semantic_review')

    await fs.appendFile(path.join(root, 'src/service.ts'), 'export const stale = true\n')
    const stale = await transactionCall(root, 'resume', { runId: run.runId })
    expect(stale.status).toBe('failed')
    expect(stale.data).toMatchObject({ outcome: 'snapshot_stale', nextAction: 'restart_transaction' })
  })

  it('rebuilds a missing staged candidate only while every begin snapshot remains fresh', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await beginUpdate(root)
    await fs.rm(path.join(root, run.candidatePath), { recursive: true })
    await fs.rm(path.join(root, '.scratch/locks/context-write'), { recursive: true })

    const rebuilt = await transactionCall(root, 'resume', { runId: run.runId })
    expect(rebuilt).toMatchObject({
      status: 'success',
      data: { outcome: 'staged', candidatePath: run.candidatePath, nextAction: 'edit_candidate' },
    })
    expect(await fs.readFile(path.join(root, run.candidatePath, SERVICE_DOMAIN.relativePath), 'utf8')).toBe(documentSource(SERVICE_DOMAIN))

    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const staleRoot = await readyRoot()
    // 当前故障场景建立的事务及候选路径，后续用于注入变化。
    const staleRun = await beginUpdate(staleRoot)
    await fs.rm(path.join(staleRoot, staleRun.candidatePath), { recursive: true })
    await fs.appendFile(path.join(staleRoot, 'src/service.ts'), 'export const staleBeforeRebuild = true\n')
    const stale = await transactionCall(staleRoot, 'resume', { runId: staleRun.runId })
    expect(stale).toMatchObject({
      status: 'failed',
      data: { outcome: 'snapshot_stale', nextAction: 'restart_transaction' },
    })
    expect(await exists(staleRoot, `.scratch/runs/${staleRun.runId}`)).toBe(false)
  })

  it('requires manual recovery for corrupt or differently owned locks', async () => {
    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const corruptRoot = await readyRoot()
    await fs.mkdir(path.join(corruptRoot, '.scratch/locks/context-write'), { recursive: true })
    await fs.writeFile(path.join(corruptRoot, '.scratch/locks/context-write/owner.json'), '{}')
    // 当前工作流拥有的宿主 Git 证据叶子或已校验快照。
    const evidence = await writeGitEvidence(corruptRoot)
    const corrupt = await transactionCall(corruptRoot, 'begin', {
      command: 'update',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath: evidence,
      evidencePaths: ['src/service.ts'],
    })
    expect(corrupt.status).toBe('incomplete')
    expect(corrupt.data?.manualRecoveryRequired).toBe(true)

    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const ownerRoot = await readyRoot()
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await beginUpdate(ownerRoot)
    await fs.writeFile(path.join(ownerRoot, '.scratch/locks/context-write/owner.json'), JSON.stringify({
      kind: 'plugydown.context.lock',
      format: 1,
      runId: '11111111-1111-4111-8111-111111111111',
    }))
    const blocked = await transactionCall(ownerRoot, 'resume', { runId: run.runId })
    expect(blocked.status).toBe('incomplete')
    expect(blocked.data).toMatchObject({
      runId: '11111111-1111-4111-8111-111111111111',
      outcome: 'manual_recovery',
      manualRecoveryRequired: true,
    })
  })

  it('settles a reaffirmed Document whose sources moved without inventing an edit', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    const original = JSON.parse(await fs.readFile(path.join(root, 'context/.meta/manifest.json'), 'utf8'))
    // SERVICE_GUIDE 引用 src/retry.ts，因此该文件变化使其记录的源码指纹过期。
    await fs.writeFile(path.join(root, 'src/retry.ts'), 'retry C\n')
    expect((await call(root, 'confirmation.check', {})).data?.summary).toMatchObject({ unmatched: 1 })

    const gitEvidencePath = await writeGitEvidence(root, { status: porcelainModified('src/retry.ts') })
    const began = await transactionCall(root, 'begin', {
      command: 'update',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'documents', ids: ['service.retry'] },
      gitEvidencePath,
      evidencePaths: ['src/retry.ts'],
      confirmedDocumentIds: ['service.retry'],
    })
    expect(began.status).toBe('success')
    // 当前事务的 UUID，也是其运行目录和写锁的所有权标识。
    const runId = dataString(began, 'runId')

    // 不修改候选正文，验证仍然准确的文档能通过明确重新确认结清审查。
    const first = await transactionCall(root, 'validate', { runId })
    expect(first.data).toMatchObject({ outcome: 'ready_for_review' })
    // 重新验证仍须保留 begin 时冻结的重新确认授权。
    const validated = await transactionCall(root, 'validate', { runId })
    expect(validated.status).toBe('success')
    expect(validated.data).toMatchObject({ outcome: 'ready_for_review' })
    expect((await readManifest(root, runId)).confirmedDocumentIds).toEqual(['service.retry'])
    const committed = await transactionCall(root, 'commit', { runId, approval: approval(validated) })
    expect(committed.status).toBe('success')

    const after = JSON.parse(await fs.readFile(path.join(root, 'context/.meta/manifest.json'), 'utf8'))
    expect(after).toEqual(original)
    expect((await call(root, 'confirmation.check', {})).data?.summary).toMatchObject({ matched: 3, unmatched: 0 })
    expect(await call(root, 'graph.validate', {})).toMatchObject({ status: 'success' })
    expect((await call(root, 'graph.validate', {})).diagnostics).toBeUndefined()
  })

  it('refuses to reaffirm an unknown Document, one outside scope, or any non-update command', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    const gitEvidencePath = await writeGitEvidence(root)
    /** 使用可覆盖的冻结输入开始 Repair 或其他测试事务。 */
    const begin = async (patch: Record<string, unknown>): Promise<RuntimeResponse> => transactionCall(root, 'begin', {
      command: 'update',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'documents', ids: ['service.retry'] },
      gitEvidencePath,
      evidencePaths: ['src/retry.ts'],
      ...patch,
    })

    expect((await begin({ confirmedDocumentIds: ['service.absent'] })).diagnostics?.map(item => item.code))
      .toContain('TRANSACTION_SCOPE_INVALID')
    // client 虽然存在，但不在授权范围内，不能结清其记录。
    expect((await begin({ confirmedDocumentIds: ['client'] })).diagnostics?.map(item => item.code))
      .toContain('TRANSACTION_SCOPE_INVALID')
    expect((await begin({ command: 'prune', scope: { kind: 'repository' }, confirmedDocumentIds: ['service.retry'] })).diagnostics?.map(item => item.code))
      .toContain('TRANSACTION_SCOPE_INVALID')

    // begin 被拒绝后不能留下写锁。
    expect(await exists(root, '.scratch/locks/context-write')).toBe(false)
  })

  it('still withholds a fresh ledger from an in-scope Document that was neither edited nor reaffirmed', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    const original = JSON.parse(await fs.readFile(path.join(root, 'context/.meta/manifest.json'), 'utf8'))
    await fs.writeFile(path.join(root, 'src/retry.ts'), 'retry C\n')
    await fs.writeFile(path.join(root, 'src/service.ts'), 'service C\n')

    const gitEvidencePath = await writeGitEvidence(root, {
      status: `${porcelainModified('src/retry.ts')}${porcelainModified('src/service.ts')}`,
    })
    const began = await transactionCall(root, 'begin', {
      command: 'update',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'domains', ids: ['service'] },
      gitEvidencePath,
      evidencePaths: ['src/retry.ts', 'src/service.ts'],
      confirmedDocumentIds: ['service.retry'],
    })
    // 当前事务的 UUID，也是其运行目录和写锁的所有权标识。
    const runId = dataString(began, 'runId')
    const validated = await transactionCall(root, 'validate', { runId })
    await transactionCall(root, 'commit', { runId, approval: approval(validated) })

    const after = JSON.parse(await fs.readFile(path.join(root, 'context/.meta/manifest.json'), 'utf8'))
    expect(after).toEqual(original)
    expect((await call(root, 'confirmation.check', {})).data?.summary).toMatchObject({ matched: 2, unmatched: 1 })
  })
})

describe('transaction crash recovery', () => {
  it('continues a uniquely safe pre-switch window', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await prepareChanged(root)
    await markCommitting(root, run)

    const resumed = await transactionCall(root, 'resume', { runId: run.runId })
    expect(resumed.status).toBe('success')
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')).toBe(documentSource(changedService))
    expect(await exists(root, `.scratch/runs/${run.runId}`)).toBe(false)
    expect(await exists(root, run.gitEvidencePath)).toBe(false)
  })

  it('completes an init pre-switch window when the snapshot and live tree are both absent', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await createRepository()
    roots.push(root)
    const gitEvidencePath = await writeGitEvidence(root, { id: 'init-crash' })
    const began = await transactionCall(root, 'begin', {
      command: 'init',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath,
      evidencePaths: ['src/service.ts'],
    })
    // 当前事务的 UUID，也是其运行目录和写锁的所有权标识。
    const runId = dataString(began, 'runId')
    // 本测试事务独占的完整候选 Context 相对目录。
    const candidatePath = dataString(began, 'candidatePath')
    await fs.mkdir(path.join(root, candidatePath, 'service'), { recursive: true })
    await fs.writeFile(path.join(root, candidatePath, SERVICE_DOMAIN.relativePath), documentSource(SERVICE_DOMAIN))
    const validated = await transactionCall(root, 'validate', { runId })
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run: PreparedRun = { runId, candidatePath, gitEvidencePath, approval: approval(validated) }
    await markCommitting(root, run)

    const resumed = await transactionCall(root, 'resume', { runId })

    expect(resumed.status).toBe('success')
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')).toBe(documentSource(SERVICE_DOMAIN))
    expect(await exists(root, `.scratch/runs/${runId}`)).toBe(false)
    expect(await exists(root, gitEvidencePath)).toBe(false)
    expect(await exists(root, '.scratch/locks/context-write')).toBe(false)
  })

  it('restores a trusted backup after the live-to-backup crash window', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    const before = await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await prepareChanged(root)
    await markCommitting(root, run)
    // 当前事务原始 Context 备份的目录事实。
    const backup = path.join(root, `.scratch/runs/${run.runId}/backup/context`)
    await fs.mkdir(path.dirname(backup), { recursive: true })
    await fs.rename(path.join(root, 'context'), backup)

    const resumed = await transactionCall(root, 'resume', { runId: run.runId })
    expect(resumed.status).toBe('failed')
    expect(resumed.data?.outcome).toBe('backup_restored')
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')).toBe(before)
    expect(await exists(root, `.scratch/runs/${run.runId}`)).toBe(false)
    expect(await exists(root, run.gitEvidencePath)).toBe(false)
    expect(await exists(root, '.scratch/locks/context-write')).toBe(false)
  })

  it('finalizes an already switched approved candidate and cleans backup/lock', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await prepareChanged(root)
    await markCommitting(root, run)
    // 当前事务原始 Context 备份的目录事实。
    const backup = path.join(root, `.scratch/runs/${run.runId}/backup/context`)
    await fs.mkdir(path.dirname(backup), { recursive: true })
    await fs.rename(path.join(root, 'context'), backup)
    await fs.rename(path.join(root, run.candidatePath), path.join(root, 'context'))

    const resumed = await transactionCall(root, 'resume', { runId: run.runId })
    expect(resumed.status).toBe('success')
    expect(await fs.access(backup).then(() => true, () => false)).toBe(false)
    expect(await fs.access(path.join(root, '.scratch/locks/context-write')).then(() => true, () => false)).toBe(false)
    expect(await exists(root, `.scratch/runs/${run.runId}`)).toBe(false)
    expect(await exists(root, run.gitEvidencePath)).toBe(false)
  })

  it('finalizes an already switched candidate without re-reading changed source evidence', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await prepareChanged(root)
    await markCommitting(root, run)
    // 当前事务原始 Context 备份的目录事实。
    const backup = path.join(root, `.scratch/runs/${run.runId}/backup/context`)
    await fs.mkdir(path.dirname(backup), { recursive: true })
    await fs.rename(path.join(root, 'context'), backup)
    await fs.rename(path.join(root, run.candidatePath), path.join(root, 'context'))
    await fs.appendFile(path.join(root, 'src/service.ts'), 'export const changedAfterSwitch = true\n')

    const resumed = await transactionCall(root, 'resume', { runId: run.runId })

    expect(resumed).toMatchObject({ status: 'success', data: { outcome: 'candidate_completed' } })
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')).toBe(documentSource(changedService))
    expect(await exists(root, `.scratch/runs/${run.runId}`)).toBe(false)
  })

  it('preserves a corrupted switched candidate and trusted backup for manual recovery', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    const before = await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await prepareChanged(root)
    await markCommitting(root, run)
    // 当前事务原始 Context 备份的目录事实。
    const backup = path.join(root, `.scratch/runs/${run.runId}/backup/context`)
    await fs.mkdir(path.dirname(backup), { recursive: true })
    await fs.rename(path.join(root, 'context'), backup)
    await fs.rename(path.join(root, run.candidatePath), path.join(root, 'context'))
    await fs.appendFile(path.join(root, 'context/service/domain.md'), '\ncorrupted after switch\n')

    const resumed = await transactionCall(root, 'resume', { runId: run.runId })

    expect(resumed.status).toBe('incomplete')
    expect(resumed.data).toMatchObject({ outcome: 'manual_recovery', manualRecoveryRequired: true })
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')).not.toBe(before)
    expect(await exists(root, `.scratch/runs/${run.runId}`)).toBe(true)
    expect(await exists(root, run.gitEvidencePath)).toBe(true)
    expect(await exists(root, '.scratch/locks/context-write')).toBe(true)
  })

  it('finishes cleanup after a committed-manifest crash window', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await prepareChanged(root)
    await markCommitting(root, run)
    // 当前事务原始 Context 备份的目录事实。
    const backup = path.join(root, `.scratch/runs/${run.runId}/backup/context`)
    await fs.mkdir(path.dirname(backup), { recursive: true })
    await fs.rename(path.join(root, 'context'), backup)
    await fs.rename(path.join(root, run.candidatePath), path.join(root, 'context'))
    await markCommitted(root, run)

    const resumed = await transactionCall(root, 'resume', { runId: run.runId })

    expect(resumed.status).toBe('success')
    expect(resumed.data?.outcome).toBe('committed')
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')).toBe(documentSource(changedService))
    expect(await exists(root, `.scratch/runs/${run.runId}`)).toBe(false)
    expect(await exists(root, run.gitEvidencePath)).toBe(false)
    expect(await exists(root, '.scratch/locks/context-write')).toBe(false)
  })

  it('honors restore intent after backup rename and never switches the still-approved candidate', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    const before = await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await prepareChanged(root)
    await markCommitting(root, run)
    // 当前事务原始 Context 备份的目录事实。
    const backup = path.join(root, `.scratch/runs/${run.runId}/backup/context`)
    await fs.mkdir(path.dirname(backup), { recursive: true })
    await fs.rename(path.join(root, 'context'), backup)
    await fs.symlink(path.join('.scratch', 'runs', run.runId, 'candidate', 'context'), path.join(root, 'context'))
    // 故障注入前保留的真实 fs.rename 实现。
    const realRename = fs.rename.bind(fs)
    // 故障注入是否已执行，或负责注入的可恢复测试替身。
    const injected = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).endsWith('/backup/context'))
        throw new TypeError('injected unknown restore failure')
      return realRename(from, to)
    })

    await expect(transactionCall(root, 'resume', { runId: run.runId })).rejects.toThrow('injected unknown restore failure')
    expect((await readManifest(root, run.runId)).recovery).toEqual({ intent: 'restore_backup' })
    expect(await exists(root, run.candidatePath)).toBe(true)
    injected.mockRestore()
    await fs.rename(backup, path.join(root, 'context'))

    const resumed = await transactionCall(root, 'resume', { runId: run.runId })
    expect(resumed).toMatchObject({ status: 'failed', data: { outcome: 'backup_restored' } })
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')).toBe(before)
    expect(await exists(root, `.scratch/runs/${run.runId}`)).toBe(false)
  })

  it('does not trust a terminal phase when directory facts still describe pre-switch state', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    const before = await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await prepareChanged(root)
    await markCommitted(root, run)

    const resumed = await transactionCall(root, 'resume', { runId: run.runId })

    expect(resumed).toMatchObject({
      status: 'incomplete',
      data: { outcome: 'manual_recovery', manualRecoveryRequired: true },
    })
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')).toBe(before)
    expect(await exists(root, run.candidatePath)).toBe(true)
  })

  it('preserves conflicting complete copies for manual recovery', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await prepareChanged(root)
    await markCommitting(root, run)
    // 当前事务原始 Context 备份的目录事实。
    const backup = path.join(root, `.scratch/runs/${run.runId}/backup/context`)
    await fs.mkdir(path.dirname(backup), { recursive: true })
    await fs.cp(path.join(root, 'context'), backup, { recursive: true })
    // 与原始快照和候选均不同的有效知识副本。
    const conflicting = { ...CLIENT_DOMAIN, body: '# Client\n\nConcurrent valid knowledge.\n' }
    await fs.writeFile(path.join(root, 'context/client/domain.md'), documentSource(conflicting))
    await writeMeta(root, [SERVICE_DOMAIN, SERVICE_GUIDE, conflicting], { baselineRevision: REVISION_A })

    const resumed = await transactionCall(root, 'resume', { runId: run.runId })
    expect(resumed.status).toBe('incomplete')
    expect(resumed.data).toMatchObject({ outcome: 'manual_recovery', manualRecoveryRequired: true })
    expect(await fs.access(backup).then(() => true, () => false)).toBe(true)
    expect(await fs.access(path.join(root, run.candidatePath)).then(() => true, () => false)).toBe(true)
    expect(await exists(root, run.gitEvidencePath)).toBe(true)
    expect(await exists(root, '.scratch/locks/context-write')).toBe(true)
  })

  it('fails without deleting diagnostics when no complete trusted copy remains', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await prepareChanged(root)
    await markCommitting(root, run)
    await fs.rm(path.join(root, 'context'), { recursive: true })
    await fs.rm(path.join(root, run.candidatePath), { recursive: true })

    const resumed = await transactionCall(root, 'resume', { runId: run.runId })
    expect(resumed.status).toBe('failed')
    expect(resumed.data).toMatchObject({ outcome: 'no_trusted_copy', manualRecoveryRequired: true })
    expect(await exists(root, `.scratch/runs/${run.runId}/manifest.json`)).toBe(true)
    expect(await exists(root, run.gitEvidencePath)).toBe(true)
    expect(await exists(root, '.scratch/locks/context-write')).toBe(true)
  })

  it('returns mechanical_failure and cleans when a known filesystem failure occurs before the first switch', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await prepareChanged(root)
    // 故障注入前保留的真实 fs.rename 实现。
    const realRename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).endsWith('manifest.json.tmp')) {
        // 本测试主动构造的文件系统异常，不来自外部环境。
        const error = new Error('injected known failure') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      }
      return realRename(from, to)
    })

    const result = await transactionCall(root, 'commit', { runId: run.runId, approval: run.approval })

    expect(result).toMatchObject({
      status: 'failed',
      data: { outcome: 'mechanical_failure' },
      diagnostics: [{ code: 'REPOSITORY_IO_FAILED' }],
    })
    expect(await exists(root, `.scratch/runs/${run.runId}`)).toBe(false)
    expect(await exists(root, run.gitEvidencePath)).toBe(false)
    expect(await exists(root, '.scratch/locks/context-write')).toBe(false)
  })

  it('leaves no unreadable lock owner when an unknown failure escapes before the manifest exists', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    const gitEvidencePath = await writeGitEvidence(root)
    // 故障注入前保留的真实目录创建实现。
    const realMkdir = fs.mkdir.bind(fs)
    // 故障注入是否已执行，或负责注入的可恢复测试替身。
    const injected = vi.spyOn(fs, 'mkdir').mockImplementation(async (target, options) => {
      if (String(target).includes('/.scratch/runs/') && !String(target).endsWith('/runs'))
        throw new TypeError('injected unknown run staging failure')
      return realMkdir(target, options as Parameters<typeof realMkdir>[1])
    })

    await expect(transactionCall(root, 'begin', {
      command: 'update',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath,
      evidencePaths: ['src/service.ts'],
    })).rejects.toThrow('injected unknown run staging failure')
    injected.mockRestore()

    // 尚未写入清单时不能留下指向不可读事务的锁，后续 begin 必须仍可进行。
    expect(await exists(root, '.scratch/locks/context-write')).toBe(false)
    const retried = await transactionCall(root, 'begin', {
      command: 'update',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath,
      evidencePaths: ['src/service.ts'],
    })
    expect(retried).toMatchObject({ status: 'success', data: { outcome: 'staged' } })
  })

  it('rejects unknown switch failures as transport errors and preserves the committing scene', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await readyRoot()
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await prepareChanged(root)
    // 故障注入前保留的真实 fs.rename 实现。
    const realRename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('/backup/context'))
        throw new TypeError('injected unknown switch failure')
      return realRename(from, to)
    })

    await expect(transactionCall(root, 'commit', { runId: run.runId, approval: run.approval })).rejects.toThrow('injected unknown switch failure')
    expect((await readManifest(root, run.runId)).phase).toBe('committing')
    expect(await exists(root, run.candidatePath)).toBe(true)
    expect(await exists(root, run.gitEvidencePath)).toBe(true)
    expect(await exists(root, '.scratch/locks/context-write')).toBe(true)
  })
})

describe('immutable confirmation write ownership', () => {
  it.each(['delete', 'overwrite', 'permissions', 'forge', 'metadata'])('rejects candidate %s without modifying formal evidence', async (mutation) => {
    const root = await readyRoot()
    const before = await fs.readFile(path.join(root, 'context/.meta/manifest.json'))
    const run = await beginUpdate(root)
    const directory = path.join(root, run.candidatePath, '.meta/confirmations/service')
    const recordPath = path.join(directory, (await fs.readdir(directory))[0]!)
    if (mutation === 'delete')
      await fs.rm(recordPath)
    if (mutation === 'overwrite')
      await fs.writeFile(recordPath, '{}')
    if (mutation === 'permissions')
      await fs.chmod(recordPath, 0o600)
    if (mutation === 'forge')
      await fs.writeFile(path.join(directory, `${'a'.repeat(64)}.json`), '{}')
    if (mutation === 'metadata')
      await fs.rm(path.join(root, run.candidatePath, '.meta/manifest.json'))
    const result = await transactionCall(root, 'validate', { runId: run.runId })
    expect(result.data?.outcome).toBe('candidate_edit_required')
    expect(result.diagnostics?.[0]?.code).toMatch(/MUTATION_FORBIDDEN/)
    expect(await fs.readFile(path.join(root, 'context/.meta/manifest.json'))).toEqual(before)
  })

  it('revalidation replaces only this run’s obsolete generated record and then becomes idempotent', async () => {
    const root = await readyRoot()
    const original = await fs.readdir(path.join(root, 'context/.meta/confirmations/service'))
    const run = await prepareChanged(root)
    const directory = path.join(root, run.candidatePath, '.meta/confirmations/service')
    const first = await fs.readdir(directory)
    expect(first.length).toBe(original.length + 1)
    await fs.appendFile(path.join(root, run.candidatePath, SERVICE_DOMAIN.relativePath), '\nSecond review candidate.\n')
    const second = await transactionCall(root, 'validate', { runId: run.runId })
    const files = await fs.readdir(directory)
    expect(files.length).toBe(original.length + 1)
    expect(files).not.toEqual(first)
    expect(files).toEqual(expect.arrayContaining(original))
    const repeated = await transactionCall(root, 'validate', { runId: run.runId })
    expect(repeated.data?.candidateFingerprint).toBe(second.data?.candidateFingerprint)
    expect((await transactionCall(root, 'commit', { runId: run.runId, approval: approval(repeated) })).status).toBe('success')
    expect((await call(root, 'confirmation.check', {})).data?.summary).toMatchObject({ matched: 3 })
    const next = await beginUpdate(root)
    expect((await transactionCall(root, 'validate', { runId: next.runId })).data?.outcome).toBe('no_change')
  })

  it('retries a crash after a confirmation temporary file is written without losing any original record', async () => {
    const root = await readyRoot()
    const run = await beginUpdate(root)
    await fs.writeFile(path.join(root, run.candidatePath, SERVICE_DOMAIN.relativePath), documentSource(changedService))
    const rename = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).includes('/confirmations/') && String(from).endsWith('.tmp'))
        throw new Error('injected interruption')
      return rename(from, to)
    })
    await expect(transactionCall(root, 'validate', { runId: run.runId })).rejects.toThrow('injected interruption')
    spy.mockRestore()
    const validated = await transactionCall(root, 'validate', { runId: run.runId })
    expect(validated.status, JSON.stringify(validated)).toBe('success')
    expect((await transactionCall(root, 'commit', { runId: run.runId, approval: approval(validated) })).status).toBe('success')
    expect((await fs.readdir(path.join(root, 'context/.meta/confirmations/service'))).length).toBe(2)
  })

  it('allows deletion without deleting historical confirmations', async () => {
    const root = await readyRoot()
    const history = await fs.readdir(path.join(root, 'context/.meta/confirmations/service.retry'))
    const run = await beginUpdate(root)
    await fs.rm(path.join(root, run.candidatePath, 'service/manual'), { recursive: true })
    const validated = await transactionCall(root, 'validate', { runId: run.runId })
    expect(validated.status, JSON.stringify(validated)).toBe('success')
    expect((await transactionCall(root, 'commit', { runId: run.runId, approval: approval(validated) })).status).toBe('success')
    expect(await fs.readdir(path.join(root, 'context/.meta/confirmations/service.retry'))).toEqual(history)
    expect((await call(root, 'confirmation.check', {})).data?.summary).toMatchObject({ documents: 2, matched: 2 })
  })
})

it('preserves confirmations on a legal path move and gives an ID rename its own identity', async () => {
  const root = await readyRoot()
  const originalFiles = await fs.readdir(path.join(root, 'context/.meta/confirmations/service.retry'))
  const move = await beginUpdate(root)
  await fs.rename(path.join(root, move.candidatePath, SERVICE_GUIDE.relativePath), path.join(root, move.candidatePath, 'service/manual/moved.md'))
  const moved = await transactionCall(root, 'validate', { runId: move.runId })
  expect(moved.data?.confirmation).toMatchObject({ newRecordCount: 0 })
  expect((await transactionCall(root, 'commit', { runId: move.runId, approval: approval(moved) })).status).toBe('success')
  expect((await call(root, 'confirmation.check', {})).data?.summary).toMatchObject({ matched: 3 })
  const rename = await beginUpdate(root)
  await fs.writeFile(path.join(root, rename.candidatePath, 'service/manual/moved.md'), documentSource({ ...SERVICE_GUIDE, id: 'service.renamed' }))
  const renamed = await transactionCall(root, 'validate', { runId: rename.runId })
  expect(renamed.data?.confirmation).toMatchObject({ newRecordCount: 1 })
  expect((await transactionCall(root, 'commit', { runId: rename.runId, approval: approval(renamed) })).status).toBe('success')
  expect(await fs.readdir(path.join(root, 'context/.meta/confirmations/service.retry'))).toEqual(originalFiles)
  expect((await call(root, 'confirmation.check', { scope: { kind: 'documents', ids: ['service.renamed'] } })).data?.summary).toMatchObject({ matched: 1 })
})
