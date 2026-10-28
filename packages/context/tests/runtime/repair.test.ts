import type { Meta } from '../../src/runtime/document.js'
import type { RuntimeResponse, TransactionBeginInput } from '../../src/runtime/protocol.js'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { call, CLIENT_DOMAIN, createRepository, documentSource, removeRepository, REVISION_A, REVISION_C, SERVICE_DOMAIN, SERVICE_GUIDE, transactionCall, writeGitEvidence } from './fixture.js'

// 当前测试文件拥有的临时仓库集合，由 afterEach 统一清理。
const roots: string[] = []
// 测试显式提供的任务确定性信号，避免依赖外部推断。
const taskEvidence = { intentKnown: true, scopeComplete: true, newCapabilitySuspected: false, crossDomainContractUncertain: false }
/** 从磁盘读取的账本夹具，保留 JSON 中的格式版本字段。 */
type StoredMeta = Omit<Meta, 'schema'> & {
  /** 磁盘 JSON 中的账本格式版本标识。 */
  $schema: string
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(removeRepository))
})

/** 创建并登记由当前测试清理的独立仓库夹具。 */
async function repository(documents = [SERVICE_DOMAIN, SERVICE_GUIDE, CLIENT_DOMAIN]) {
  // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
  const root = await createRepository({ documents, baselineRevision: REVISION_A })
  roots.push(root)
  return root
}

/** 读取指定正式或候选目录中的测试账本。 */
async function meta(root: string, directory = 'context'): Promise<StoredMeta> {
  return JSON.parse(await fs.readFile(path.join(root, directory, 'meta.json'), 'utf8'))
}

/** 追加固定文档内容，构造正文与账本失配。 */
async function edit(root: string, relative = SERVICE_GUIDE.relativePath) {
  await fs.appendFile(path.join(root, 'context', relative), '\nMerged content needing review.\n')
}

/** 检查测试仓库中的指定路径是否仍存在。 */
async function exists(root: string, relative: string) {
  return fs.access(path.join(root, relative)).then(() => true, () => false)
}

/** 读取测试响应中的必需字符串，避免缺失字段掩盖失败。 */
function text(response: RuntimeResponse, key: string): string {
  // 从测试响应取得的必需字段，缺失或类型错误时立即失败。
  const value = response.data?.[key]
  if (typeof value !== 'string')
    throw new TypeError(`Missing ${key}: ${JSON.stringify(response)}`)
  return value
}

/** 用验证响应的两个指纹构造测试批准。 */
function approval(response: RuntimeResponse) {
  return {
    approved: true,
    candidateFingerprint: text(response, 'candidateFingerprint'),
    sourceEvidenceFingerprint: text(response, 'sourceEvidenceFingerprint'),
    summary: 'Fixture review approved the stated operation, preserving outstanding review obligations.',
  }
}

/** 使用可覆盖的冻结输入开始 Repair 或其他测试事务。 */
async function begin(root: string, overrides: Partial<TransactionBeginInput> = {}) {
  const gitEvidencePath = overrides.gitEvidencePath ?? await writeGitEvidence(root)
  return transactionCall(root, 'begin', {
    command: 'repair',
    mode: 'deep',
    dryRun: false,
    scope: { kind: 'documents', ids: [SERVICE_GUIDE.id] },
    gitEvidencePath,
    evidencePaths: [],
    ...overrides,
  })
}

/** 创建并验证候选，返回测试后续动作所需的事务身份和批准。 */
async function prepared(root: string, overrides: Partial<TransactionBeginInput> = {}) {
  const response = await begin(root, overrides)
  expect(response.status, JSON.stringify(response)).toBe('success')
  // 当前事务的 UUID，也是其运行目录和写锁的所有权标识。
  const runId = text(response, 'runId')
  // 本测试事务独占的完整候选 Context 相对目录。
  const candidatePath = text(response, 'candidatePath')
  const validated = await transactionCall(root, 'validate', { runId })
  expect(validated.status, JSON.stringify(validated)).toBe(overrides.dryRun ? 'dry_run' : 'success')
  return { runId, candidatePath, validated, approval: approval(validated) }
}

/** 在测试夹具中完整执行验证与批准提交。 */
async function repair(root: string, overrides: Partial<TransactionBeginInput> = {}) {
  // 当前测试建立并拥有的事务、候选路径与批准信息。
  const run = await prepared(root, overrides)
  expect(await transactionCall(root, 'commit', { runId: run.runId, approval: run.approval })).toMatchObject({ status: 'success' })
  return run
}

describe('controlled content fingerprint repair', () => {
  it('previews exact fields, migrates only necessary records, and retains review debt with unchanged sources', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    const before = await meta(root)
    await edit(root)
    const document = await fs.readFile(path.join(root, 'context', SERVICE_GUIDE.relativePath))
    const inspected = await call(root, 'repository.inspect', { repair: true, selectedDocumentIds: [SERVICE_GUIDE.id] })
    expect(inspected).toMatchObject({
      status: 'success',
      data: {
        context: { state: 'invalid', repairable: true },
        repair: { eligible: true, documentCount: 1, remainingDocumentCount: 0, schemaMigrationRequired: true, items: [{
          documentId: SERVICE_GUIDE.id,
          selected: true,
          fields: [{ field: 'bodyFingerprint', before: before.documents[SERVICE_GUIDE.id]!.bodyFingerprint }, { field: 'reviewRequired', before: null, after: true }],
        }] },
      },
    })
    expect(await begin(root, { command: 'update', evidencePaths: ['src/retry.ts'] })).toMatchObject({ status: 'failed' })
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await repair(root)
    expect(run.validated.data?.repair).toEqual({ documentCount: 1, planFingerprint: (inspected.data?.repair as Record<string, unknown>).planFingerprint })
    const after = await meta(root)
    expect(after.$schema).toBe('plugydown.context.meta/v2')
    expect(after).toEqual({
      ...before,
      $schema: 'plugydown.context.meta/v2',
      documents: {
        ...before.documents,
        [SERVICE_GUIDE.id]: { ...before.documents[SERVICE_GUIDE.id], bodyFingerprint: expect.any(String), reviewRequired: true },
      },
    })
    expect(after.documents[SERVICE_GUIDE.id]!.bodyFingerprint).not.toBe(before.documents[SERVICE_GUIDE.id]!.bodyFingerprint)
    expect(await fs.readFile(path.join(root, 'context', SERVICE_GUIDE.relativePath))).toEqual(document)
    expect(await call(root, 'graph.validate', {})).toMatchObject({ status: 'success', diagnostics: [{ code: 'DOCUMENT_REVIEW_PENDING' }] })
    expect(await call(root, 'repository.inspect', { selectedDocumentIds: [SERVICE_GUIDE.id] })).toMatchObject({
      data: { context: { state: 'ready', contentReviewRequiredCount: 1 }, selected: [{ id: SERVICE_GUIDE.id, state: 'stale', reviewRequired: true }] },
    })
    expect(await call(root, 'frontier.query', { depth: 3, selectors: { documentIds: [SERVICE_GUIDE.id] } })).toMatchObject({ status: 'success' })
    const gitEvidencePath = await writeGitEvidence(root)
    expect(await call(root, 'delta.compute', { gitEvidencePath, scope: { kind: 'repository' }, taskEvidence })).toMatchObject({
      status: 'success',
      data: { directImpact: [{ documentId: SERVICE_GUIDE.id, reasons: ['content fingerprint repair requires semantic review'] }] },
    })
  })

  it('dry-runs all four selected Documents deterministically without modifying formal bytes', async () => {
    // 在标准夹具之外增加的文档，用于验证多文档范围。
    const extra = { ...SERVICE_GUIDE, id: 'service.print', relativePath: 'service/manual/print.md' }
    // 本场景包含的文档夹具集合。
    const documents = [SERVICE_DOMAIN, SERVICE_GUIDE, CLIENT_DOMAIN, extra]
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository(documents)
    for (const document of documents)
      await edit(root, document.relativePath)
    const before = await call(root, 'repository.inspect', {})
    const originalMeta = await fs.readFile(path.join(root, 'context/meta.json'))
    const first = await prepared(root, { dryRun: true, scope: { kind: 'documents', ids: documents.map(document => document.id) } })
    const second = await prepared(root, { dryRun: true, scope: { kind: 'documents', ids: documents.map(document => document.id).reverse() } })
    expect(second.validated.data?.repair).toEqual(first.validated.data?.repair)
    expect(second.approval).toEqual(first.approval)
    expect(await call(root, 'repository.inspect', {})).toEqual(before)
    expect(await fs.readFile(path.join(root, 'context/meta.json'))).toEqual(originalMeta)
    for (const run of [first, second])
      expect(await exists(root, `.scratch/runs/${run.runId}`)).toBe(false)
    expect(await exists(root, '.scratch/locks/context-write')).toBe(false)
    expect(await exists(root, '.scratch/evidence/request')).toBe(false)
    expect(await transactionCall(root, 'commit', { runId: first.runId, approval: first.approval })).toMatchObject({ status: 'failed' })
  })

  it('returns a complete paged plan and rejects incomplete scope without silently adding Documents', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    await edit(root)
    await edit(root, CLIENT_DOMAIN.relativePath)
    // 当前能力已解析的业务参数。
    const input = { repair: true, selectedDocumentIds: [SERVICE_GUIDE.id] }
    const first = await call(root, 'repository.inspect', input, { budget: { items: 1 } })
    expect(first).toMatchObject({ status: 'incomplete', cursor: expect.any(String), data: { repair: { documentCount: 2, remainingDocumentCount: 1 } } })
    const next = await call(root, 'repository.inspect', input, { cursor: first.cursor! })
    expect(next.status).toBe('success')
    expect((first.data?.repair as Record<string, unknown>).items).toMatchObject([{ documentId: CLIENT_DOMAIN.id, selected: false }])
    expect((next.data?.repair as Record<string, unknown>).items).toMatchObject([{ documentId: SERVICE_GUIDE.id, selected: true }])
    expect(await begin(root)).toMatchObject({ status: 'failed', diagnostics: [{ code: 'REPAIR_SCOPE_INCOMPLETE' }] })
    expect(await exists(root, '.scratch/locks/context-write')).toBe(false)
    await edit(root)
    expect(await call(root, 'repository.inspect', input, { cursor: first.cursor! })).toMatchObject({ status: 'failed', diagnostics: [{ code: 'CURSOR_STALE' }] })
  })

  it('retains obligations without code.paths, pins baseline, and clears only explicitly reviewed Documents', async () => {
    const { codePaths: _paths, ...withoutSources } = SERVICE_GUIDE
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository([SERVICE_DOMAIN, withoutSources, CLIENT_DOMAIN])
    await edit(root)
    await repair(root)
    const before = await meta(root)
    expect(await begin(root, { command: 'prune', scope: { kind: 'repository' }, evidencePaths: ['src/service.ts'] })).toMatchObject({ status: 'failed', diagnostics: [{ code: 'DOCUMENT_REVIEW_REQUIRED' }] })
    const gitEvidencePath = await writeGitEvidence(root, { revision: REVISION_C })
    const untouched = await begin(root, { command: 'update', scope: { kind: 'repository' }, evidencePaths: ['src/service.ts'], gitEvidencePath })
    expect(await transactionCall(root, 'validate', { runId: text(untouched, 'runId') })).toMatchObject({ status: 'no_change' })
    expect(await meta(root)).toEqual(before)
    await repairOrReview(root, 'update', [SERVICE_GUIDE.id])
    const after = await meta(root)
    expect(after.documents[SERVICE_GUIDE.id]).not.toHaveProperty('reviewRequired')
    expect(after.repository).toEqual(before.repository) // 限定文档的复核不能推进全仓基线。
    expect(await call(root, 'graph.validate', {})).toMatchObject({ status: 'success' })
    expect((await call(root, 'graph.validate', {})).diagnostics).toBeUndefined()
  })

  it('preserves stale source review evidence and handles front matter changes independently', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    const before = await meta(root)
    await fs.writeFile(path.join(root, 'context', SERVICE_GUIDE.relativePath), documentSource({ ...SERVICE_GUIDE, description: 'Merged metadata.', codePaths: ['src/client.ts'] }))
    await fs.appendFile(path.join(root, 'src/client.ts'), 'export const newSource = true\n')
    await repair(root)
    const after = await meta(root)
    expect(after.documents[SERVICE_GUIDE.id]).toMatchObject({
      bodyFingerprint: before.documents[SERVICE_GUIDE.id]!.bodyFingerprint,
      sourceFingerprint: before.documents[SERVICE_GUIDE.id]!.sourceFingerprint,
      reviewRequired: true,
    })
    expect(after.documents[SERVICE_GUIDE.id]!.frontMatterFingerprint).not.toBe(before.documents[SERVICE_GUIDE.id]!.frontMatterFingerprint)
    expect(after.documents[CLIENT_DOMAIN.id]).toEqual(before.documents[CLIENT_DOMAIN.id])
  })

  it('clears only reviewed obligations and advances baseline only after the last one is settled', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    await edit(root)
    await edit(root, CLIENT_DOMAIN.relativePath)
    await repair(root, { scope: { kind: 'documents', ids: [SERVICE_GUIDE.id, CLIENT_DOMAIN.id] } })
    const before = await meta(root)
    const reviewed = await prepared(root, {
      command: 'update',
      scope: { kind: 'repository' },
      evidencePaths: ['src/retry.ts'],
      reaffirmedDocumentIds: [SERVICE_GUIDE.id],
      gitEvidencePath: await writeGitEvidence(root, { revision: REVISION_C }),
    })
    await transactionCall(root, 'commit', { runId: reviewed.runId, approval: reviewed.approval })
    const partly = await meta(root)
    expect(partly.documents[SERVICE_GUIDE.id]).not.toHaveProperty('reviewRequired')
    expect(partly.documents[CLIENT_DOMAIN.id]).toEqual(before.documents[CLIENT_DOMAIN.id])
    expect(partly.repository).toEqual(before.repository)
    const last = await begin(root, {
      command: 'update',
      scope: { kind: 'repository' },
      evidencePaths: ['src/client.ts'],
      gitEvidencePath: await writeGitEvidence(root, { revision: REVISION_C }),
    })
    await fs.appendFile(path.join(root, text(last, 'candidatePath'), CLIENT_DOMAIN.relativePath), '\nReviewed correction.\n')
    // 当前事务的 UUID，也是其运行目录和写锁的所有权标识。
    const runId = text(last, 'runId')
    const validated = await transactionCall(root, 'validate', { runId })
    expect(await transactionCall(root, 'commit', { runId, approval: approval(validated) })).toMatchObject({ status: 'success' })
    const after = await meta(root)
    expect(after.documents[CLIENT_DOMAIN.id]).not.toHaveProperty('reviewRequired')
    expect(after.repository?.baseline.revision).toBe(REVISION_C)
    expect(after.convergence).toEqual(before.convergence)
  })

  it('preserves existing obligations when repairing v2 again or finding no mismatch', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    await edit(root)
    await repair(root)
    const once = await meta(root)
    const noChange = await begin(root)
    expect(await transactionCall(root, 'validate', { runId: text(noChange, 'runId') })).toMatchObject({ status: 'no_change' })
    await edit(root)
    const preview = await call(root, 'repository.inspect', { repair: true })
    expect(preview.data?.repair).toMatchObject({ schemaMigrationRequired: false, items: [{ fields: [{ field: 'bodyFingerprint' }] }] })
    await repair(root)
    const twice = await meta(root)
    expect(twice.documents[SERVICE_GUIDE.id]).toMatchObject({ sourceFingerprint: once.documents[SERVICE_GUIDE.id]!.sourceFingerprint, reviewRequired: true })
    expect(twice.documents.service).toEqual(once.documents.service)
  })

  it.each([
    ['plugydown.context.meta/v1', true],
    ['plugydown.context.meta/v2', false],
    ['plugydown.context.meta/v2', 'pending'],
  ])('rejects invalid review state in %s: %s', async (schema, reviewRequired) => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    const ledger = await meta(root)
    await fs.writeFile(path.join(root, 'context/meta.json'), JSON.stringify({
      ...ledger,
      $schema: schema,
      documents: {
        ...ledger.documents,
        [SERVICE_GUIDE.id]: { ...ledger.documents[SERVICE_GUIDE.id], reviewRequired },
      },
    }))
    expect(await call(root, 'graph.validate', {})).toMatchObject({ status: 'failed', diagnostics: [{ code: 'META_DOCUMENT_INVALID' }] })
  })

  it('uses every internal diagnostic, even when public diagnostics are capped', async () => {
    // 本场景包含的文档夹具集合。
    const documents = Array.from({ length: 110 }, (_, index) => ({
      ...SERVICE_GUIDE,
      id: `service.item-${index}`,
      relativePath: `service/manual/item-${index}.md`,
    }))
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository([SERVICE_DOMAIN, ...documents])
    for (const document of documents)
      await edit(root, document.relativePath)
    await fs.writeFile(path.join(root, 'context', documents[109]!.relativePath), documentSource({
      ...documents[109]!,
      relations: { related: ['missing.target'] },
    }))
    expect(await call(root, 'repository.inspect', { repair: true })).toMatchObject({ data: { repair: { eligible: false } } })
    expect(await begin(root, { scope: { kind: 'documents', ids: documents.map(document => document.id) } })).toMatchObject({ status: 'failed', diagnostics: [{ code: 'REPAIR_NOT_ELIGIBLE' }] })
  })

  it.each(['schema', 'missing ledger', 'duplicate ID', 'dangling relation', 'conflict marker', 'symlink'] as const)('refuses %s even when fingerprints also mismatch', async (damage) => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    await edit(root)
    // 当前受检文件的实际路径，仅用于内部读写操作。
    const file = path.join(root, 'context', SERVICE_GUIDE.relativePath)
    if (damage === 'schema' || damage === 'missing ledger') {
      const ledger = await meta(root)
      if (damage === 'schema')
        ledger.$schema = 'unknown'
      else
        delete (ledger.documents as Record<string, unknown>)[SERVICE_GUIDE.id]
      await fs.writeFile(path.join(root, 'context/meta.json'), JSON.stringify(ledger))
    }
    if (damage === 'duplicate ID')
      await fs.copyFile(file, path.join(root, 'context/service/manual/duplicate.md'))
    if (damage === 'dangling relation')
      await fs.writeFile(file, documentSource({ ...SERVICE_GUIDE, relations: { requires: ['missing.document'] } }))
    if (damage === 'conflict marker')
      await fs.appendFile(file, '\n<<<<<<< unresolved\n')
    if (damage === 'symlink') {
      await fs.unlink(file)
      await fs.symlink(path.join(root, 'src/retry.ts'), file)
    }
    expect(await call(root, 'repository.inspect', { repair: true })).toMatchObject({ data: { repair: { eligible: false } } })
    expect(await begin(root)).toMatchObject({ status: 'failed', diagnostics: [{ code: 'REPAIR_NOT_ELIGIBLE' }] })
    expect(await exists(root, '.scratch/locks/context-write')).toBe(false)
  })

  it.each([
    { mode: 'light' },
    { scope: { kind: 'repository' } },
    { scope: { kind: 'documents', ids: ['missing.document'] } },
    { reaffirmedDocumentIds: [SERVICE_GUIDE.id] },
    { evidencePaths: ['../escape'] },
  ] as Partial<TransactionBeginInput>[])('refuses invalid repair authorization %#', async (overrides) => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    await edit(root)
    expect(await begin(root, overrides)).toMatchObject({ status: 'failed' })
    expect(await exists(root, '.scratch/locks/context-write')).toBe(false)
  })

  it('refuses active Git operations and unreadable source evidence without losing merged bytes', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    await edit(root)
    expect(await begin(root, { gitEvidencePath: await writeGitEvidence(root, { midOperation: 'rebase' }) })).toMatchObject({ status: 'failed', diagnostics: [{ code: 'REPAIR_GIT_OPERATION_ACTIVE' }] })
    // 构造 Git 状态记录使用的固定对象 ID。
    const hash = '0'.repeat(40)
    // 当前 Git 差异条目的状态码。
    const status = `u UU N... 100644 100644 100644 100644 ${hash} ${hash} ${hash} context/meta.json\0`
    expect(await begin(root, { gitEvidencePath: await writeGitEvidence(root, { status }) })).toMatchObject({ status: 'failed', diagnostics: [{ code: 'REPAIR_GIT_OPERATION_ACTIVE' }] })
    await fs.unlink(path.join(root, 'src/retry.ts'))
    const started = await begin(root)
    expect(await transactionCall(root, 'validate', { runId: text(started, 'runId') })).toMatchObject({ status: 'incomplete', data: { outcome: 'candidate_edit_required' } })
    expect((await meta(root)).$schema).toBe('plugydown.context.meta/v1')
  })

  it('does nothing on a consistent ledger, without migration or gratuitous review flags', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    const before = await fs.readFile(path.join(root, 'context/meta.json'))
    const started = await begin(root)
    expect(await transactionCall(root, 'validate', { runId: text(started, 'runId') })).toMatchObject({ status: 'no_change' })
    expect(await fs.readFile(path.join(root, 'context/meta.json'))).toEqual(before)
  })
})

/** 按文档范围执行修复或明确重新确认，验证审查义务的生命周期。 */
async function repairOrReview(root: string, command: 'repair' | 'update', ids: string[]) {
  return repair(root, {
    command,
    scope: { kind: 'documents', ids },
    evidencePaths: ['src/service.ts'],
    ...(command === 'update' ? { reaffirmedDocumentIds: ids } : {}),
  })
}

describe('repair approval and failure recovery', () => {
  it.each(['body', 'format', 'path', 'permissions', 'meta'] as const)('rejects candidate %s modifications', async (mutation) => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    await edit(root)
    const started = await begin(root)
    // 本次正在校验或推导的候选值。
    const candidate = text(started, 'candidatePath')
    // 当前受检文件的实际路径，仅用于内部读写操作。
    const file = path.join(root, candidate, SERVICE_GUIDE.relativePath)
    if (mutation === 'body')
      await fs.appendFile(file, 'Extra content\n')
    if (mutation === 'format')
      await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replaceAll('\n', '\r\n'))
    if (mutation === 'path')
      await fs.rename(file, path.join(path.dirname(file), 'renamed.md'))
    if (mutation === 'permissions')
      await fs.chmod(file, 0o600)
    if (mutation === 'meta') {
      const ledger = await meta(root, candidate)
      await fs.writeFile(path.join(root, candidate, 'meta.json'), JSON.stringify({ ...ledger, toolVersion: 'tampered' }))
    }
    const result = await transactionCall(root, 'validate', { runId: text(started, 'runId') })
    expect(result).toMatchObject({ status: 'incomplete', diagnostics: [{ code: mutation === 'meta' ? 'REPAIR_META_CHANGED' : 'REPAIR_DOCUMENT_CHANGED' }] })
  })

  it.each(['candidate', 'source', 'live'] as const)('invalidates approval after %s changes', async (changed) => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    await edit(root)
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await prepared(root)
    // 当前受检文件的实际路径，仅用于内部读写操作。
    const file = changed === 'source' ? 'src/retry.ts' : `${changed === 'live' ? 'context' : run.candidatePath}/${SERVICE_GUIDE.relativePath}`
    await fs.appendFile(path.join(root, file), '\nConcurrent change\n')
    const committed = await transactionCall(root, 'commit', { runId: run.runId, approval: run.approval })
    expect(committed.data?.outcome).toBe(changed === 'live' ? 'snapshot_stale' : 'candidate_stale')
    expect((await meta(root)).$schema).toBe('plugydown.context.meta/v1')
  })

  it('grants one writer under concurrent begins and resumes a staged repair without requiring ready Context', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    await edit(root)
    const gitEvidencePath = await writeGitEvidence(root)
    // 并发事务请求的实际返回集合，用于核对唯一写者。
    const results = await Promise.all([begin(root, { gitEvidencePath }), begin(root, { gitEvidencePath })])
    expect(results.filter(result => result.status === 'success')).toHaveLength(1)
    expect(results.filter(result => result.status === 'incomplete')).toHaveLength(1)
    // 当前资源或写锁的唯一所有者标识。
    const owner = results.find(result => result.status === 'success')!
    // 当前事务的 UUID，也是其运行目录和写锁的所有权标识。
    const runId = text(owner, 'runId')
    expect(await call(root, 'repository.inspect', {})).toMatchObject({ data: { activeRun: { command: 'repair', runId } } })
    await fs.rm(path.join(root, text(owner, 'candidatePath')), { recursive: true })
    expect(await transactionCall(root, 'resume', { runId })).toMatchObject({ data: { outcome: 'repair_staged', nextAction: 'validate' } })
    expect(await transactionCall(root, 'validate', { runId })).toMatchObject({ status: 'success' })
  })

  it.each(['backup', 'completed', 'missing', 'conflict'] as const)('recovers the %s crash state honestly', async (state) => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    await edit(root)
    const original = await fs.readFile(path.join(root, 'context', SERVICE_GUIDE.relativePath))
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await prepared(root)
    // 当前测试事务的持久清单文件路径。
    const manifestFile = path.join(root, `.scratch/runs/${run.runId}/manifest.json`)
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
    await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, phase: 'committing', approval: run.approval }))
    // 当前事务原始 Context 备份的目录事实。
    const backup = path.join(root, `.scratch/runs/${run.runId}/backup/context`)
    await fs.mkdir(path.dirname(backup), { recursive: true })
    await fs.rename(path.join(root, 'context'), backup)
    if (state === 'completed')
      await fs.rename(path.join(root, run.candidatePath), path.join(root, 'context'))
    if (state === 'missing') {
      await fs.rm(backup, { recursive: true })
      await fs.rm(path.join(root, run.candidatePath), { recursive: true })
    }
    if (state === 'conflict') {
      await fs.cp(backup, path.join(root, 'context'), { recursive: true })
      await edit(root)
    }
    const result = await transactionCall(root, 'resume', { runId: run.runId })
    expect(result.data?.outcome).toBe({ backup: 'backup_restored', completed: 'candidate_completed', missing: 'no_trusted_copy', conflict: 'manual_recovery' }[state])
    if (state === 'backup') {
      expect(result).toMatchObject({ status: 'failed', diagnostics: [{ code: 'REPAIR_ROLLED_BACK' }] })
      expect(await call(root, 'repository.inspect', {})).toMatchObject({ data: { context: { state: 'invalid' } } })
      expect(await fs.readFile(path.join(root, 'context', SERVICE_GUIDE.relativePath))).toEqual(original)
    }
    expect(await exists(root, '.scratch/locks/context-write')).toBe(state === 'missing' || state === 'conflict')
  })

  it('restores the original mismatched ledger after an injected directory switch failure', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    await edit(root)
    const before = await fs.readFile(path.join(root, 'context/meta.json'))
    // 当前测试建立并拥有的事务、候选路径与批准信息。
    const run = await prepared(root)
    // 保留的真实重命名函数，故障注入未命中时仍调用它。
    const rename = fs.rename.bind(fs)
    // 故障注入是否已执行，或负责注入的可恢复测试替身。
    let injected = false
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).endsWith(`/${run.candidatePath}`)) {
        injected = true
        // 本测试主动构造的文件系统异常，不来自外部环境。
        const error = new Error('Injected switch failure') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      }
      return rename(from, to)
    })
    expect(await transactionCall(root, 'commit', { runId: run.runId, approval: run.approval })).toMatchObject({ status: 'failed', data: { outcome: 'backup_restored' } })
    expect(injected).toBe(true)
    expect(await fs.readFile(path.join(root, 'context/meta.json'))).toEqual(before)
    expect(await exists(root, '.scratch/locks/context-write')).toBe(false)
  })
})

// 固定 Git 身份、时间与配置，避免夹具依赖用户环境。
/** 以固定身份、时间和配置执行夹具 Git 命令，隔离用户配置影响。 */
function git(root: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Context Fixture', '-c', 'user.email=context@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

it('recovers an actual Git merge of independently transacted branch edits', async () => {
  // 包含可独立合并段落的指南夹具。
  const guide = { ...SERVICE_GUIDE, body: '# Retry\n\nFirst policy.\n\n## Details\n\nUnchanged middle.\n\n## Boundary\n\nSecond policy.\n' }
  // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
  const root = await repository([SERVICE_DOMAIN, guide, CLIENT_DOMAIN])
  await fs.writeFile(path.join(root, '.gitignore'), '.scratch/\n')
  git(root, ['init', '-b', 'main'])
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'fixture: base'])
  for (const [branch, from, to] of [['a', 'First policy.', 'First policy from A.'], ['b', 'Second policy.', 'Second policy from B.']]) {
    git(root, ['checkout', '-b', branch!, 'main'])
    const gitEvidencePath = await writeGitEvidence(root, { revision: git(root, ['rev-parse', 'HEAD']).trim(), status: git(root, ['status', '--porcelain=v2', '-z']) })
    const started = await begin(root, { command: 'update', evidencePaths: ['src/retry.ts'], gitEvidencePath })
    // 当前事务的 UUID，也是其运行目录和写锁的所有权标识。
    const runId = text(started, 'runId')
    await fs.writeFile(path.join(root, text(started, 'candidatePath'), guide.relativePath), documentSource({ ...guide, body: guide.body.replace(from!, to!) }))
    const validated = await transactionCall(root, 'validate', { runId })
    expect(await transactionCall(root, 'commit', { runId, approval: approval(validated) })).toMatchObject({ status: 'success' })
    git(root, ['add', 'context'])
    git(root, ['commit', '-m', `fixture: branch ${branch}`])
  }
  expect(() => git(root, ['merge', '--no-commit', '--no-ff', 'a'])).toThrow() // 两分支正文可自动合并，只有账本发生冲突。
  const merged = await fs.readFile(path.join(root, 'context', guide.relativePath), 'utf8')
  expect(merged).toContain('First policy from A.')
  expect(merged).toContain('Second policy from B.')
  expect(merged).not.toContain('<<<<<<<')
  await fs.writeFile(path.join(root, 'context/meta.json'), git(root, ['show', 'a:context/meta.json']))
  git(root, ['add', 'context'])
  git(root, ['commit', '-m', 'fixture: merged content with branch A ledger'])
  expect(git(root, ['status', '--porcelain'])).toBe('')
  expect(await call(root, 'repository.inspect', {})).toMatchObject({ data: { context: { state: 'invalid', repairable: true } } })
  const gitEvidencePath = await writeGitEvidence(root, { revision: git(root, ['rev-parse', 'HEAD']).trim(), status: git(root, ['status', '--porcelain=v2', '-z']) })
  expect(await call(root, 'delta.compute', { gitEvidencePath, scope: { kind: 'repository' }, taskEvidence })).toMatchObject({ status: 'failed', diagnostics: [{ code: 'META_DOCUMENT_FINGERPRINT_MISMATCH' }] })
  await repair(root, { gitEvidencePath })
  expect(await fs.readFile(path.join(root, 'context', guide.relativePath), 'utf8')).toBe(merged)
  await repairOrReview(root, 'update', [guide.id])
  expect(await call(root, 'graph.validate', {})).toMatchObject({ status: 'success' })
  expect((await call(root, 'graph.validate', {})).diagnostics).toBeUndefined()
})
