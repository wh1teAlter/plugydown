import type { RuntimeResponse } from '../../src/runtime/protocol.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkConfirmations } from '../../src/runtime/confirmation.js'
import { fingerprintTree } from '../../src/runtime/repository.js'
import { call, createRepository, documentSource, removeRepository, REVISION_A, SERVICE_DOMAIN, SERVICE_GUIDE, transactionCall, writeGitEvidence } from './fixture.js'

// 隔离夹具只用于迁移实验，不触及正式知识或安装缓存。
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(removeRepository))
})

/** 创建可精确复原的旧账本及两份 Markdown。 */
async function legacy() {
  const root = await createRepository({ documents: [SERVICE_DOMAIN, SERVICE_GUIDE], baselineRevision: REVISION_A, legacy: true })
  roots.push(root)
  return root
}

/** 明确信任策略后开始迁移，输入只能在 begin 固定。 */
async function begin(root: string, patch: Record<string, unknown> = {}) {
  const gitEvidencePath = await writeGitEvidence(root)
  return transactionCall(root, 'begin', { command: 'migrate', mode: 'deep', dryRun: false, scope: { kind: 'repository' }, gitEvidencePath, evidencePaths: [], migrationStrategy: 'import-trusted', ...patch })
}

/** 构造测试批准，仅绑定已验证候选与证据。 */
function approval(result: RuntimeResponse) {
  return { approved: true, candidateFingerprint: result.data?.candidateFingerprint, sourceEvidenceFingerprint: result.data?.sourceEvidenceFingerprint, summary: 'Review historical evidence conversion and exact Markdown preservation.' }
}

/** 修改旧夹具账本，模拟可审阅的历史数据。 */
async function changeMeta(root: string, change: (meta: any) => void) {
  const filename = path.join(root, 'context/meta.json')
  const meta = JSON.parse(await fs.readFile(filename, 'utf8'))
  change(meta)
  await fs.writeFile(filename, JSON.stringify(meta))
  return meta
}

describe('explicit legacy migration', () => {
  it.each(['import-trusted', 'reconfirm'] as const)('preserves bytes, permissions and baselines with %s; missing sources never become confirmation', async (migrationStrategy) => {
    const root = await legacy()
    const oldMeta = await changeMeta(root, (meta) => {
      meta.$schema = 'plugydown.context.meta/v2'
      meta.documents[SERVICE_GUIDE.id].reviewRequired = true
    })
    await fs.chmod(path.join(root, 'context/service/domain.md'), 0o640)
    await fs.rm(path.join(root, 'src/retry.ts'))
    await fs.appendFile(path.join(root, 'context/service/domain.md'), '\nMerged third content.\n')
    const before = await fs.readFile(path.join(root, 'context/service/domain.md'))
    expect(await call(root, 'repository.inspect', {})).toMatchObject({ data: { context: { state: 'legacy' } } })
    const preview = await call(root, 'repository.inspect', { migration: true }, { budget: { items: 1 } })
    expect(preview).toMatchObject({ status: 'incomplete', data: { migration: { eligible: true, importCount: 1 } } })
    const run = await begin(root, { migrationStrategy })
    expect(run.data?.outcome).toBe('migration_staged')
    const validated = await transactionCall(root, 'validate', { runId: run.data?.runId })
    expect(validated.status, JSON.stringify(validated)).toBe('success')
    expect((await transactionCall(root, 'commit', { runId: run.data?.runId, approval: approval(validated) })).status).toBe('success')
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'))).toEqual(before)
    expect((await fs.stat(path.join(root, 'context/service/domain.md'))).mode & 0o777).toBe(0o640)
    const metadata = JSON.parse(await fs.readFile(path.join(root, 'context/.meta/manifest.json'), 'utf8'))
    expect(metadata).toEqual({ format: 1, repository: oldMeta.repository, convergence: oldMeta.convergence })
    const checked = await checkConfirmations(root)
    expect(checked.store.count).toBe(migrationStrategy === 'import-trusted' ? 1 : 0)
    expect(checked.items.map(item => item.confirmationState)).toEqual(['unmatched', 'unavailable'])
    expect(await fs.access(path.join(root, 'context/meta.json')).then(() => true, () => false)).toBe(false)
    // 缺源和第三正文不会再阻止 Update begin；在候选中修正路径即可继续。
    const gitEvidencePath = await writeGitEvidence(root)
    const update = await transactionCall(root, 'begin', { command: 'update', mode: 'deep', dryRun: false, scope: { kind: 'repository' }, gitEvidencePath, evidencePaths: [], confirmedDocumentIds: ['service'] })
    expect(update.status).toBe('success')
    await fs.writeFile(path.join(root, String(update.data?.candidatePath), SERVICE_GUIDE.relativePath), documentSource({ ...SERVICE_GUIDE, codePaths: ['src/service.ts'] }))
    const v = await transactionCall(root, 'validate', { runId: update.data?.runId })
    expect(v.status, JSON.stringify(v)).toBe('success')
    expect((await transactionCall(root, 'commit', { runId: update.data?.runId, approval: approval(v) })).status).toBe('success')
    expect((await checkConfirmations(root)).items.every(item => item.confirmationState === 'matched')).toBe(true)
  })

  it('has no implicit write strategy and rejects unsafe or ambiguous legacy input', async () => {
    const root = await legacy()
    expect((await begin(root, { migrationStrategy: undefined })).status).toBe('failed')
    await fs.writeFile(path.join(root, 'context/meta.json'), '{"documents": {}, "documents": {}}')
    expect(await call(root, 'repository.inspect', { migration: true })).toMatchObject({ data: { migration: { eligible: false } } })
    expect((await begin(root)).status).toBe('failed')
  })

  it.each(['markers', 'relation', 'record', 'review-state', 'unsafe-path'])('rejects genuine damage: %s', async (kind) => {
    const root = await legacy()
    if (kind === 'markers')
      await fs.appendFile(path.join(root, 'context/service/domain.md'), '\n<<<<<<< branch\n')
    if (kind === 'relation')
      await fs.writeFile(path.join(root, 'context/service/domain.md'), documentSource({ ...SERVICE_DOMAIN, relations: { requires: ['unknown'] } }))
    if (kind === 'record')
      await changeMeta(root, (meta) => { delete meta.documents.service })
    if (kind === 'review-state')
      await changeMeta(root, (meta) => { meta.documents.service.reviewRequired = true })
    if (kind === 'unsafe-path')
      await fs.writeFile(path.join(root, 'context/service/domain.md'), documentSource({ ...SERVICE_DOMAIN, codePaths: ['../escape.ts'] }))
    expect((await begin(root)).status).toBe('failed')
  })

  it('dry-run and repeated previews leave the exact original tree; active Git is refused', async () => {
    const root = await legacy()
    const before = await fingerprintTree(root, 'context')
    for (let i = 0; i < 2; i++) {
      const run = await begin(root, { dryRun: true })
      expect((await transactionCall(root, 'validate', { runId: run.data?.runId })).status).toBe('dry_run')
      expect(await fingerprintTree(root, 'context')).toBe(before)
    }
    const gitEvidencePath = await writeGitEvidence(root, { midOperation: 'rebase' })
    const run = await transactionCall(root, 'begin', { command: 'migrate', mode: 'deep', dryRun: false, scope: { kind: 'repository' }, evidencePaths: [], gitEvidencePath, migrationStrategy: 'import-trusted' })
    expect(run.diagnostics?.[0]?.code).toBe('MIGRATION_GIT_OPERATION_ACTIVE')
  })

  it('binds migration to original evidence even if current missing sources appear during approval', async () => {
    const root = await legacy()
    await fs.rm(path.join(root, 'src/retry.ts'))
    const run = await begin(root)
    const validated = await transactionCall(root, 'validate', { runId: run.data?.runId })
    await fs.writeFile(path.join(root, 'src/retry.ts'), 'new current source\n')
    const committed = await transactionCall(root, 'commit', { runId: run.data?.runId, approval: approval(validated) })
    expect(committed.status).toBe('success')
    expect((await checkConfirmations(root)).items.find(item => item.documentId === SERVICE_GUIDE.id)?.confirmationState).toBe('unmatched')
  })

  it.each(['candidate', 'formal'])('rejects %s changes during migration approval', async (tree) => {
    const root = await legacy()
    const run = await begin(root)
    const validated = await transactionCall(root, 'validate', { runId: run.data?.runId })
    await fs.appendFile(path.join(root, tree === 'formal' ? 'context' : String(run.data?.candidatePath), SERVICE_DOMAIN.relativePath), '\nChanged during approval.\n')
    const result = await transactionCall(root, 'commit', { runId: run.data?.runId, approval: approval(validated) })
    expect(result.data?.outcome).toBe(tree === 'formal' ? 'snapshot_stale' : 'candidate_stale')
  })

  it('restores the exact legacy tree after a switch failure', async () => {
    const root = await legacy()
    const before = await fingerprintTree(root, 'context')
    const run = await begin(root)
    const validated = await transactionCall(root, 'validate', { runId: run.data?.runId })
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).endsWith('/candidate/context'))
        throw Object.assign(new Error('injected'), { code: 'EACCES' })
      return rename(from, to)
    })
    const result = await transactionCall(root, 'commit', { runId: run.data?.runId, approval: approval(validated) })
    expect(result.data?.outcome).toBe('backup_restored')
    expect(result.diagnostics?.[0]?.code).toBe('MIGRATION_ROLLED_BACK')
    expect(await fingerprintTree(root, 'context')).toBe(before)
  })
})
