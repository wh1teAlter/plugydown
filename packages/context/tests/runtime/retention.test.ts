import type { ConfirmationRecord, ConfirmationStore } from '../../src/runtime/confirmation.js'
import type { RuntimeResponse } from '../../src/runtime/protocol.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { confirmationKey, readConfirmationStore } from '../../src/runtime/confirmation.js'
import { sha256 } from '../../src/runtime/protocol.js'
import { planRetention } from '../../src/runtime/retention.js'
import { stableJson } from '../../src/runtime/stable-json.js'
import { call, createRepository, removeRepository, SERVICE_DOMAIN, transactionCall, writeGitEvidence } from './fixture.js'

// 测试只管理自己建立的隔离仓库。
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(removeRepository))
})

/** 保存明确的历史 fixture，不能被解释为真实业务审查。 */
async function put(root: string, record: ConfirmationRecord): Promise<void> {
  const directory = path.join(root, 'context/.meta/confirmations', record.documentId)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, `${confirmationKey(1, record)}.json`), stableJson({ ...record }))
}

/** 建立来源完整、当前匹配且历史超过阈值的单文档 fixture。 */
async function ready(extra = 24): Promise<string> {
  const root = await createRepository({ documents: [SERVICE_DOMAIN] })
  roots.push(root)
  const current = [...(await readConfirmationStore(root, 1)).records.get('service')!.values()][0]!
  for (let index = 0; index < extra; index++)
    await put(root, { ...current, sourceFingerprint: sha256(`historical fixture ${index}`) })
  return root
}

/** 在相同授权形状下开始集中维护，Git 状态由现有 fixture 显式提供。 */
async function begin(root: string, dryRun = false): Promise<{ runId: string, candidatePath: string }> {
  const response = await transactionCall(root, 'begin', {
    command: 'compact',
    mode: 'deep',
    dryRun,
    scope: { kind: 'repository' },
    gitEvidencePath: await writeGitEvidence(root),
    evidencePaths: [],
  })
  expect(response.status, JSON.stringify(response)).toBe('success')
  return { runId: String(response.data!.runId), candidatePath: String(response.data!.candidatePath) }
}

/** 仅在隔离测试中批准机械计划，绑定 Runtime 返回的完整指纹。 */
function approval(response: RuntimeResponse) {
  return {
    approved: true,
    candidateFingerprint: String(response.data!.candidateFingerprint),
    sourceEvidenceFingerprint: String(response.data!.sourceEvidenceFingerprint),
    summary: 'Fixture mechanical retention reviewed; no semantic confirmation.',
  }
}

/** 将明确的旧记录组合成纯算法输入。 */
function store(records: readonly ConfirmationRecord[]): ConfirmationStore {
  const byDocument = new Map<string, Map<string, ConfirmationRecord>>()
  for (const record of records) {
    const entries = byDocument.get(record.documentId) ?? new Map<string, ConfirmationRecord>()
    entries.set(confirmationKey(1, record), record)
    byDocument.set(record.documentId, entries)
  }
  return { format: 1, records: byDocument, count: records.length }
}

describe('retention selection', () => {
  it('protects current facts, covers content diversity and is deterministic without timestamps', () => {
    const records = Array.from({ length: 30 }, (_, index): ConfirmationRecord => ({
      documentId: 'service',
      frontMatterFingerprint: sha256('front'),
      bodyFingerprint: sha256(`body ${index % 12}`),
      sourceFingerprint: sha256(`source ${index}`),
    }))
    const current = records[29]!
    const plan = planRetention(store(records), new Map([['service', current]]))
    expect(plan.retained.size).toBe(10)
    expect(plan.retained.has(confirmationKey(1, current))).toBe(true)
    expect(new Set([...plan.retained.values()].map(record => record.bodyFingerprint)).size).toBe(10)
    expect(planRetention(store([...records].reverse()), new Map([['service', current]]))).toEqual(plan)
    const repeated = planRetention(store([...plan.retained.values()]), new Map([['service', current]]))
    expect(repeated.removedKeys).toEqual([])
    expect(repeated.retained).toEqual(plan.retained)
  })

  it.each([10, 11, 20, 21])('separates the %i-record trigger from the retained target', (count) => {
    const records = Array.from({ length: count }, (_, index): ConfirmationRecord => ({
      documentId: 'service',
      frontMatterFingerprint: sha256('front'),
      bodyFingerprint: sha256('body'),
      sourceFingerprint: sha256(String(index)),
    }))
    const current = { ...records[0]!, sourceFingerprint: sha256('changed source') }
    const plan = planRetention(store(records), new Map([['service', current]]))
    expect(plan.retained.size).toBe(Math.min(count, 10))
    expect(plan.summary.triggered).toBe(count > 20)
    expect(plan.retained.has(confirmationKey(1, current))).toBe(false)
    expect([...plan.retained.values()].some(record => record.bodyFingerprint === current.bodyFingerprint)).toBe(true)
    expect(planRetention(store(records), new Map()).retained.size).toBe(1)
  })
})

describe('compact transaction', () => {
  it('previews and commits a subset without changing current facts, Markdown, metadata or surviving bytes', async () => {
    const root = await ready()
    const original = await readConfirmationStore(root, 1)
    const record = [...original.records.get('service')!.values()][0]!
    for (let index = 0; index < 4; index++)
      await put(root, { ...record, documentId: 'retired', sourceFingerprint: sha256(`retired ${index}`) })
    const before = await call(root, 'confirmation.check', { explain: true })
    const metadata = await fs.readFile(path.join(root, 'context/.meta/manifest.json'))
    const markdown = await fs.readFile(path.join(root, 'context/service/domain.md'))
    const preview = await call(root, 'confirmation.retention', {})
    expect(preview.data!.retention).toMatchObject({ beforeCount: 29, afterCount: 11, removedCount: 18, triggered: true })
    const run = await begin(root)
    expect((await call(root, 'repository.inspect', {})).data!.activeRun).toMatchObject({ command: 'compact' })
    const validated = await transactionCall(root, 'validate', { runId: run.runId })
    expect(validated.data).toMatchObject({ outcome: 'ready_for_review', nextAction: 'retention_review', retention: { afterCount: 11 } })
    const resumed = await transactionCall(root, 'resume', { runId: run.runId })
    expect(resumed.data!.nextAction).toBe('retention_review')
    const committed = await transactionCall(root, 'commit', { runId: run.runId, approval: approval(validated) })
    expect(committed.data!.outcome).toBe('committed')
    expect((await call(root, 'confirmation.check', { explain: true })).data!.items).toEqual(before.data!.items)
    expect(await fs.readFile(path.join(root, 'context/.meta/manifest.json'))).toEqual(metadata)
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'))).toEqual(markdown)
    const after = await readConfirmationStore(root, 1)
    expect(after.records.get('service')!.size).toBe(10)
    expect(after.records.get('retired')!.size).toBe(1)
    for (const [key, retained] of after.records.get('service')!)
      expect(retained).toEqual(original.records.get('service')!.get(key))
    const repeated = await begin(root)
    expect((await transactionCall(root, 'validate', { runId: repeated.runId })).status).toBe('no_change')
  })

  it('keeps ordinary Update append-only and rejects arbitrary compact scope', async () => {
    const root = await ready()
    const response = await transactionCall(root, 'begin', {
      command: 'update',
      mode: 'light',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath: await writeGitEvidence(root),
      evidencePaths: [],
    })
    expect((await transactionCall(root, 'validate', { runId: response.data!.runId })).status).toBe('no_change')
    expect((await readConfirmationStore(root, 1)).count).toBe(25)
    const invalid = await transactionCall(root, 'begin', {
      command: 'compact',
      mode: 'light',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath: await writeGitEvidence(root),
      evidencePaths: [],
    })
    expect(invalid.status).toBe('failed')
  })

  it('dry-run leaves the original records and cleans only its own transaction', async () => {
    const root = await ready()
    const run = await begin(root, true)
    const response = await transactionCall(root, 'validate', { runId: run.runId })
    expect(response.status).toBe('dry_run')
    expect(response.data!.retention).toMatchObject({ removedCount: 15 })
    expect((await readConfirmationStore(root, 1)).count).toBe(25)
    await expect(fs.access(path.join(root, '.scratch/runs', run.runId))).rejects.toThrow()
  })

  it('cleans a failed partial deletion without changing the formal store', async () => {
    const root = await ready()
    const run = await begin(root)
    const remove = fs.rm.bind(fs)
    let deletions = 0
    vi.spyOn(fs, 'rm').mockImplementation(async (...args) => {
      if (String(args[0]).includes(`${run.candidatePath}/.meta/confirmations/`) && ++deletions === 2)
        throw Object.assign(new Error('fixture deletion failed'), { code: 'EIO' })
      return remove(...args)
    })
    const failed = await transactionCall(root, 'validate', { runId: run.runId })
    expect(failed.data!.outcome).toBe('mechanical_failure')
    expect((await readConfirmationStore(root, 1)).count).toBe(25)
    await expect(fs.access(path.join(root, '.scratch/locks/context-write'))).rejects.toThrow()
    await expect(fs.access(path.join(root, '.scratch/runs', run.runId))).rejects.toThrow()
  })

  it.each(['source', 'source-missing', 'markdown', 'retained-record', 'permissions'])('rejects %s changes after begin', async (change) => {
    const root = await ready()
    const run = await begin(root)
    const original = await call(root, 'confirmation.check', {})
    if (change === 'source') {
      await fs.writeFile(path.join(root, 'src/service.ts'), 'changed\n')
    }
    else if (change === 'source-missing') {
      await fs.unlink(path.join(root, 'src/service.ts'))
    }
    else if (change === 'markdown') {
      await fs.appendFile(path.join(root, run.candidatePath, 'service/domain.md'), '\nUnexpected edit.\n')
    }
    else if (change === 'permissions') {
      await fs.chmod(path.join(root, run.candidatePath, 'service/domain.md'), 0o600)
    }
    else {
      const currentKey = (original.data!.items as { currentKey: string }[])[0]!.currentKey
      await fs.unlink(path.join(root, run.candidatePath, '.meta/confirmations/service', `${currentKey}.json`))
    }
    const failed = await transactionCall(root, 'validate', { runId: run.runId })
    expect(failed.data!.outcome).toBe('candidate_edit_required')
    expect((await readConfirmationStore(root, 1)).count).toBe(25)
    expect((await transactionCall(root, 'resume', { runId: run.runId, disposition: 'abandon' })).data!.outcome).toBe('abandoned')
  })

  it('refuses a stale source approval and concurrent writers', async () => {
    const root = await ready()
    const run = await begin(root)
    const concurrent = await transactionCall(root, 'begin', {
      command: 'compact',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath: await writeGitEvidence(root, { id: 'second' }),
      evidencePaths: [],
    })
    expect(concurrent.data!.outcome).toBe('active_run')
    const validated = await transactionCall(root, 'validate', { runId: run.runId })
    await fs.writeFile(path.join(root, 'src/service.ts'), 'changed after approval\n')
    const response = await transactionCall(root, 'commit', { runId: run.runId, approval: approval(validated) })
    expect(response.data!.outcome).toBe('candidate_stale')
    expect((await readConfirmationStore(root, 1)).count).toBe(25)
  })

  it.each(['candidate_completed', 'backup_restored', 'manual_recovery', 'no_trusted_copy'])('recovers an interrupted switch as %s', async (outcome) => {
    const root = await ready()
    const run = await begin(root)
    const validated = await transactionCall(root, 'validate', { runId: run.runId })
    const directory = path.join(root, '.scratch/runs', run.runId)
    const manifestPath = path.join(directory, 'manifest.json')
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    await fs.writeFile(manifestPath, stableJson({ ...manifest, phase: 'committing', approval: approval(validated) }))
    await fs.mkdir(path.join(directory, 'backup'))
    await fs.rename(path.join(root, 'context'), path.join(directory, 'backup/context'))
    if (outcome === 'candidate_completed')
      await fs.rename(path.join(root, run.candidatePath), path.join(root, 'context'))
    if (outcome === 'backup_restored')
      await fs.appendFile(path.join(root, run.candidatePath, 'service/domain.md'), '\nBroken candidate.\n')
    if (outcome === 'manual_recovery') {
      await fs.mkdir(path.join(root, 'context'))
      await fs.writeFile(path.join(root, 'context/foreign.txt'), 'unrelated tree\n')
    }
    if (outcome === 'no_trusted_copy') {
      await fs.rm(path.join(directory, 'backup/context'), { recursive: true })
      await fs.rm(path.join(root, run.candidatePath), { recursive: true })
    }
    const response = await transactionCall(root, 'resume', { runId: run.runId })
    expect(response.data!.outcome).toBe(outcome)
    if (outcome === 'candidate_completed')
      expect((await readConfirmationStore(root, 1)).count).toBe(10)
    if (outcome === 'backup_restored')
      expect((await readConfirmationStore(root, 1)).count).toBe(25)
  })
})
