import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { call, CLIENT_DOMAIN, createRepository, documentSource, nameStatus, porcelainModified, removeRepository, REVISION_A, REVISION_C, SERVICE_DOMAIN, SERVICE_GUIDE, transactionCall, writeGitEvidence } from './fixture.js'

// 当前测试文件拥有的临时仓库集合，由 afterEach 统一清理。
const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(removeRepository)))

/** 创建并登记由当前测试清理的独立仓库夹具。 */
async function repository(): Promise<string> {
  // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
  const root = await createRepository({ documents: [SERVICE_DOMAIN, SERVICE_GUIDE, CLIENT_DOMAIN], baselineRevision: REVISION_A })
  roots.push(root)
  return root
}

// 测试显式提供的任务确定性信号，避免依赖外部推断。
const taskEvidence = { intentKnown: true, scopeComplete: true, newCapabilitySuspected: false, crossDomainContractUncertain: false }

describe('delta.compute', () => {
  it('keeps baseline A across a local A-to-C update and later finds the untouched Domain', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    const originalMeta = JSON.parse(await fs.readFile(path.join(root, 'context/meta.json'), 'utf8'))
    await fs.writeFile(path.join(root, 'src/service.ts'), 'service C\n')
    await fs.writeFile(path.join(root, 'src/client.ts'), 'client C\n')
    // 当前工作流拥有的宿主 Git 证据叶子或已校验快照。
    const evidence = await writeGitEvidence(root, {
      revision: REVISION_C,
      diff: nameStatus([{ status: 'M', path: 'src/service.ts' }, { status: 'M', path: 'src/client.ts' }]),
    })

    const local = await call(root, 'delta.compute', { gitEvidencePath: evidence, scope: { kind: 'domains', ids: ['service'] }, taskEvidence })
    expect(local.data?.repositoryBaseline).toBe(REVISION_A)
    expect(JSON.stringify(local.data?.directImpact)).toContain('service')
    expect(JSON.stringify(local.data?.directImpact)).toContain('client')
    expect(local.data?.repositoryBaselineEligible).toBe(false)
    expect(JSON.stringify(local.data?.light)).toContain('outside authorized scope')

    const began = await transactionCall(root, 'begin', {
      command: 'update',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'domains', ids: ['service'] },
      gitEvidencePath: evidence,
      evidencePaths: ['src/service.ts'],
    })
    // 当前事务的 UUID，也是其运行目录和写锁的所有权标识。
    const runId = began.data?.runId as string
    // 本测试事务独占的完整候选 Context 相对目录。
    const candidatePath = began.data?.candidatePath as string
    await fs.writeFile(path.join(root, candidatePath, SERVICE_DOMAIN.relativePath), documentSource({
      ...SERVICE_DOMAIN,
      body: '# Service\n\nService behavior synchronized at revision C.\n',
    }))
    const validated = await transactionCall(root, 'validate', { runId })
    const committed = await transactionCall(root, 'commit', {
      runId,
      approval: {
        approved: true,
        candidateFingerprint: validated.data?.candidateFingerprint,
        sourceEvidenceFingerprint: validated.data?.sourceEvidenceFingerprint,
        summary: 'Independent review approved the service-only synchronization.',
      },
    })
    expect(committed.status).toBe('success')
    const locallyUpdated = JSON.parse(await fs.readFile(path.join(root, 'context/meta.json'), 'utf8'))
    expect(locallyUpdated.repository.baseline.revision).toBe(REVISION_A)
    expect(locallyUpdated.documents.client).toEqual(originalMeta.documents.client)
    expect(locallyUpdated.documents.service).not.toEqual(originalMeta.documents.service)

    const laterEvidence = await writeGitEvidence(root, {
      id: 'later-repository-delta',
      revision: REVISION_C,
      diff: nameStatus([{ status: 'M', path: 'src/service.ts' }, { status: 'M', path: 'src/client.ts' }]),
    })
    const later = await call(root, 'delta.compute', { gitEvidencePath: laterEvidence, scope: { kind: 'repository' }, taskEvidence })
    expect(later.data?.repositoryBaseline).toBe(REVISION_A)
    expect(JSON.stringify(later.data?.directImpact)).not.toContain('service')
    expect(JSON.stringify(later.data?.directImpact)).toContain('client')
  })

  it('keeps an unreviewed in-scope sibling impacted after a partial commit rewrites only one Document', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    const originalMeta = JSON.parse(await fs.readFile(path.join(root, 'context/meta.json'), 'utf8'))
    await fs.writeFile(path.join(root, 'src/service.ts'), 'service C\n')
    await fs.writeFile(path.join(root, 'src/retry.ts'), 'retry C\n')
    // 当前工作流拥有的宿主 Git 证据叶子或已校验快照。
    const evidence = await writeGitEvidence(root, {
      revision: REVISION_C,
      diff: nameStatus([{ status: 'M', path: 'src/service.ts' }, { status: 'M', path: 'src/retry.ts' }]),
    })
    const began = await transactionCall(root, 'begin', {
      command: 'update',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'domains', ids: ['service'] },
      gitEvidencePath: evidence,
      evidencePaths: ['src/service.ts'],
    })
    // 当前事务的 UUID，也是其运行目录和写锁的所有权标识。
    const runId = began.data?.runId as string
    // 本测试事务独占的完整候选 Context 相对目录。
    const candidatePath = began.data?.candidatePath as string

    // Recorder 仅同步 domain.md，保留同一授权范围内未修改的兄弟文档。
    await fs.writeFile(path.join(root, candidatePath, SERVICE_DOMAIN.relativePath), documentSource({
      ...SERVICE_DOMAIN,
      body: '# Service\n\nService behavior synchronized at revision C.\n',
    }))
    const validated = await transactionCall(root, 'validate', { runId })
    const committed = await transactionCall(root, 'commit', {
      runId,
      approval: {
        approved: true,
        candidateFingerprint: validated.data?.candidateFingerprint,
        sourceEvidenceFingerprint: validated.data?.sourceEvidenceFingerprint,
        summary: 'Independent review approved rewriting only the Domain document.',
      },
    })
    expect(committed.status).toBe('success')

    const after = JSON.parse(await fs.readFile(path.join(root, 'context/meta.json'), 'utf8'))
    expect(after.documents.service).not.toEqual(originalMeta.documents.service)
    expect(after.documents['service.retry']).toEqual(originalMeta.documents['service.retry'])

    const laterEvidence = await writeGitEvidence(root, {
      id: 'sibling-still-impacted',
      revision: REVISION_C,
      diff: nameStatus([{ status: 'M', path: 'src/service.ts' }, { status: 'M', path: 'src/retry.ts' }]),
    })
    const later = await call(root, 'delta.compute', { gitEvidencePath: laterEvidence, scope: { kind: 'repository' }, taskEvidence })
    expect(JSON.stringify(later.data?.directImpact)).toContain('service.retry')
    expect(JSON.stringify(later.data?.directImpact)).not.toContain('"service"')
  })

  /** 按测试场景执行全仓 Update，验证基线推进与待审记录的关系。 */
  async function repositoryUpdate(root: string, options: {
    /** 测试宿主提供的基线差异原始数据。 */
    readonly diff: readonly {
      /** 产品级执行状态；success 不代表 Context 本身有效。 */
      readonly status: string
      /** 仓库相对路径；正式知识诊断统一使用 context/ 前缀。 */
      readonly path: string
    }[]
    /** 调用方已对照当前源码复核且确认准确的文档 ID，仅 Update 可用。 */
    readonly reaffirmedDocumentIds?: readonly string[]
  }): Promise<{
    /** 特定用途的持久基线，不能因局部修复自动推进。 */
    readonly baseline: string
  }> {
    // 当前工作流拥有的宿主 Git 证据叶子或已校验快照。
    const evidence = await writeGitEvidence(root, { id: 'update', revision: REVISION_C, diff: nameStatus(options.diff) })
    const began = await transactionCall(root, 'begin', {
      command: 'update',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath: evidence,
      evidencePaths: ['src/service.ts'],
      ...(options.reaffirmedDocumentIds === undefined ? {} : { reaffirmedDocumentIds: options.reaffirmedDocumentIds }),
    })
    // 当前事务的 UUID，也是其运行目录和写锁的所有权标识。
    const runId = began.data?.runId as string
    await fs.writeFile(path.join(root, began.data?.candidatePath as string, SERVICE_DOMAIN.relativePath), documentSource({
      ...SERVICE_DOMAIN,
      body: '# Service\n\nService behavior synchronized at revision C.\n',
    }))
    const validated = await transactionCall(root, 'validate', { runId })
    const committed = await transactionCall(root, 'commit', {
      runId,
      approval: {
        approved: true,
        candidateFingerprint: validated.data?.candidateFingerprint,
        sourceEvidenceFingerprint: validated.data?.sourceEvidenceFingerprint,
        summary: 'Repository-scope synchronization.',
      },
    })
    expect(committed.status).toBe('success')
    const meta = JSON.parse(await fs.readFile(path.join(root, 'context/meta.json'), 'utf8'))
    return { baseline: meta.repository.baseline.revision }
  }

  it('does not advance the baseline past a Document a repository-scope Update left unreviewed', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    await fs.writeFile(path.join(root, 'src/service.ts'), 'service C\n')
    await fs.writeFile(path.join(root, 'src/retry.ts'), 'retry C\n')
    // 从 Git 原始证据解析出的文件变更集合。
    const changes = [{ status: 'M', path: 'src/service.ts' }, { status: 'M', path: 'src/retry.ts' }]

    // 仅领域文档已同步；service.retry 引用的源码变化仍未被复核。
    const after = await repositoryUpdate(root, { diff: changes })
    expect(after.baseline).toBe(REVISION_A)

    // 待审队列来自指纹而非 Git 历史；没有 diff 时 service.retry 也必须留在队列中。
    const later = await writeGitEvidence(root, { id: 'after-partial', revision: REVISION_C })
    const delta = await call(root, 'delta.compute', { gitEvidencePath: later, scope: { kind: 'repository' }, taskEvidence })
    expect((delta.data?.directImpact as Array<{
      /** 当前条目所属的稳定文档 ID。 */
      documentId: string
    }>).map(item => item.documentId)).toEqual(['service.retry'])
  })

  it('keeps the review queue complete when a squash merge orphaned the baseline commit', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    await fs.writeFile(path.join(root, 'src/retry.ts'), 'retry C\n')
    // 模拟基线 A 已不可达：宿主仅提供 C 的状态，不提供 diff.bin。
    const evidence = await writeGitEvidence(root, { id: 'orphaned', revision: REVISION_C })
    const delta = await call(root, 'delta.compute', { gitEvidencePath: evidence, scope: { kind: 'repository' }, taskEvidence })

    expect(delta.data?.changedPathsComplete).toBe(false)
    expect(delta.data?.directImpact).toEqual([{
      documentId: 'service.retry',
      changedPaths: [],
      reasons: ['cited sources differ from those recorded at the last review'],
    }])
    expect(delta.data?.brokenEvidence).toEqual([])
    expect(delta.data?.light).toEqual({ eligible: true, blockers: [] })
    expect(delta.data?.repositoryBaselineEligible).toBe(true)
  })

  it('advances the baseline once every impacted Document is settled, despite unreferenced changes', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    await fs.writeFile(path.join(root, 'src/service.ts'), 'service C\n')
    await fs.writeFile(path.join(root, 'src/retry.ts'), 'retry C\n')
    await fs.mkdir(path.join(root, 'assets'))
    await fs.writeFile(path.join(root, 'assets/logo.png'), 'png\n')

    const after = await repositoryUpdate(root, {
      diff: [{ status: 'M', path: 'src/service.ts' }, { status: 'M', path: 'src/retry.ts' }, { status: 'A', path: 'assets/logo.png' }],
      reaffirmedDocumentIds: ['service.retry'],
    })
    expect(after.baseline).toBe(REVISION_C)

    const later = await writeGitEvidence(root, { id: 'after-full', revision: REVISION_C })
    const delta = await call(root, 'delta.compute', { gitEvidencePath: later, scope: { kind: 'repository' }, taskEvidence })
    expect(delta.data?.directImpact).toEqual([])
    expect(delta.data?.light).toEqual({ eligible: true, blockers: [] })
  })

  it('names the fix when Git status collapses a new directory instead of listing its files', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    // 未指定 --untracked-files=all 的 git status 会把新目录折叠为 dir/。
    const evidence = await writeGitEvidence(root, { status: '? features/\0' })
    const response = await call(root, 'delta.compute', { gitEvidencePath: evidence, scope: { kind: 'repository' }, taskEvidence })

    expect(response.status).toBe('failed')
    expect(response.diagnostics?.[0]).toMatchObject({ code: 'GIT_STATUS_UNTRACKED_COLLAPSED', path: 'status.bin' })
    expect(response.diagnostics?.[0]?.message).toContain('--untracked-files=all')
  })

  it('parses NUL-safe committed, worktree, rename, and untracked evidence', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    await fs.writeFile(path.join(root, 'src/retry.ts'), 'changed\n')
    // 当前 Git 差异条目的状态码。
    const status = `${porcelainModified('src/retry.ts')}? src/untracked file.ts\0`
    // 固定的 NUL 分隔 Git 差异字节文本。
    const diff = nameStatus([{ status: 'R100', previousPath: 'src/old client.ts', path: 'src/client.ts' }])
    // 当前工作流拥有的宿主 Git 证据叶子或已校验快照。
    const evidence = await writeGitEvidence(root, { revision: REVISION_C, status, diff })
    const response = await call(root, 'delta.compute', { gitEvidencePath: evidence, scope: { kind: 'repository' }, taskEvidence })

    expect(response.status).toBe('success')
    expect(JSON.stringify(response.data?.changedPaths)).toContain('src/untracked file.ts')
    expect(JSON.stringify(response.data?.changedPaths)).toContain('src/old client.ts')
    expect(JSON.stringify(response.data?.changedPaths)).toContain('renamed')
  })

  it('returns direct and explained requires/Domain impact closure', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    await fs.writeFile(path.join(root, 'src/retry.ts'), 'changed\n')
    // 当前工作流拥有的宿主 Git 证据叶子或已校验快照。
    const evidence = await writeGitEvidence(root, { revision: REVISION_C, diff: nameStatus([{ status: 'M', path: 'src/retry.ts' }]) })
    const response = await call(root, 'delta.compute', { gitEvidencePath: evidence, scope: { kind: 'repository' }, taskEvidence })

    expect(response.status).toBe('success')
    expect(response.data?.directImpact).toEqual([expect.objectContaining({ documentId: 'service.retry' })])
    expect(response.data?.expandedImpact).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentId: 'service.retry' }),
      expect.objectContaining({ documentId: 'service', reasons: expect.arrayContaining([expect.stringContaining('required by impacted')]) }),
    ]))
  })

  it.each([
    [{ intentKnown: false, scopeComplete: true, newCapabilitySuspected: false, crossDomainContractUncertain: false }, 'task intent is not known'],
    [{ intentKnown: true, scopeComplete: false, newCapabilitySuspected: false, crossDomainContractUncertain: false }, 'task scope is incomplete'],
    [{ intentKnown: true, scopeComplete: true, newCapabilitySuspected: true, crossDomainContractUncertain: false }, 'a new capability is suspected'],
    [{ intentKnown: true, scopeComplete: true, newCapabilitySuspected: false, crossDomainContractUncertain: true }, 'a cross-Domain contract is uncertain'],
  ])('emits the mechanical Light blocker %s', async (evidenceFlags, blocker) => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    // 当前工作流拥有的宿主 Git 证据叶子或已校验快照。
    const evidence = await writeGitEvidence(root)
    const response = await call(root, 'delta.compute', { gitEvidencePath: evidence, scope: { kind: 'repository' }, taskEvidence: evidenceFlags })
    expect(response.data?.light).toEqual(expect.objectContaining({ eligible: false, blockers: expect.arrayContaining([blocker]) }))
  })

  it('reports mid-operation and working-tree-only changes, and refuses baseline advancement mid-operation', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    // 当前工作流拥有的宿主 Git 证据叶子或已校验快照。
    const evidence = await writeGitEvidence(root, {
      revision: REVISION_C,
      midOperation: 'rebase',
      status: '? unknown/new.ts\0',
    })
    const response = await call(root, 'delta.compute', { gitEvidencePath: evidence, scope: { kind: 'repository' }, taskEvidence })

    expect(response.status).toBe('success')
    expect(response.data?.unreferencedPaths).toEqual(['unknown/new.ts'])
    expect(response.data?.changedPathsComplete).toBe(false)
    expect(response.data?.brokenEvidence).toEqual([])
    expect(response.data?.repositoryBaselineEligible).toBe(false)
    expect(response.data?.light).toEqual({ eligible: false, blockers: ['Git is in a mid-operation state'] })
  })

  it('keeps Light available for changes no Document cites, but not for broken evidence', async () => {
    // 包含相关源码声明的隔离故障测试仓库。
    const referenced = await repository()
    await fs.writeFile(path.join(referenced, 'src/service.ts'), 'service C\n')
    // 引用已经移动源码路径的固定 Git 证据。
    const staleAnchor = await writeGitEvidence(referenced, {
      revision: REVISION_A,
      diff: nameStatus([{ status: 'M', path: 'src/service.ts' }]),
      status: porcelainModified('src/service.ts'),
    })
    // 被引用文件发生移动时必须进入 Deep 审查。
    await fs.rm(path.join(referenced, 'src/service.ts'))
    const broken = await call(referenced, 'delta.compute', { gitEvidencePath: staleAnchor, scope: { kind: 'repository' }, taskEvidence })
    expect(broken.data?.brokenEvidence).not.toEqual([])
    expect(broken.data?.light).toEqual(expect.objectContaining({ eligible: false, blockers: ['evidence is incomplete'] }))

    // 静态资源与锁文件未被任何文档引用，不会使既有知识指纹过期。
    const root = await repository()
    await fs.mkdir(path.join(root, 'assets'))
    await fs.writeFile(path.join(root, 'assets/logo.png'), 'png\n')
    await fs.writeFile(path.join(root, 'lockfile.lock'), 'lock\n')
    // 当前工作流拥有的宿主 Git 证据叶子或已校验快照。
    const evidence = await writeGitEvidence(root, {
      revision: REVISION_A,
      status: `${porcelainModified('assets/logo.png')}${porcelainModified('lockfile.lock')}`,
    })
    const response = await call(root, 'delta.compute', { gitEvidencePath: evidence, scope: { kind: 'repository' }, taskEvidence })

    expect(response.data?.unreferencedPaths).toEqual(['assets/logo.png', 'lockfile.lock'])
    expect(response.data?.directImpact).toEqual([])
    expect(response.data?.light).toEqual({ eligible: true, blockers: [] })
    // 未引用路径也不固定基线，因为现有记录从未声明覆盖这些路径。
    expect(response.data?.repositoryBaselineEligible).toBe(true)
  })

  it('requires Git metadata and valid host evidence rather than executing Git or claiming no change', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    // 当前工作流拥有的宿主 Git 证据叶子或已校验快照。
    const evidence = await writeGitEvidence(root)
    await fs.rm(path.join(root, '.git'), { recursive: true })
    const missingGit = await call(root, 'delta.compute', { gitEvidencePath: evidence, scope: { kind: 'repository' }, taskEvidence })
    expect(missingGit.status).toBe('failed')
    expect(missingGit.diagnostics?.[0]?.code).toBe('GIT_REPOSITORY_REQUIRED')

    await fs.mkdir(path.join(root, '.git'))
    await fs.writeFile(path.join(root, evidence, 'status.bin'), 'not porcelain\0')
    const corrupt = await call(root, 'delta.compute', { gitEvidencePath: evidence, scope: { kind: 'repository' }, taskEvidence })
    expect(corrupt.status).toBe('failed')
    expect(corrupt.diagnostics?.[0]?.code).toBe('GIT_STATUS_INVALID')
  })

  it('strictly validates Porcelain v2 headers, HEAD binding, and unmerged record arity', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    // 当前工作流拥有的宿主 Git 证据叶子或已校验快照。
    const evidence = await writeGitEvidence(root)
    // 本测试拥有的 status.bin 路径，用于注入损坏证据。
    const statusPath = path.join(root, evidence, 'status.bin')
    // 固定的 Git 版本和分支头信息，用于构造协议边界输入。
    const header = `# branch.oid ${REVISION_A}\0# branch.head main\0`
    const invalid = [
      '',
      `# branch.oid ${REVISION_A}\0# branch.oid ${REVISION_A}\0# branch.head main\0`,
      `${header}# branch.unknown value\0`,
      `# branch.oid ${REVISION_C}\0# branch.head main\0`,
      `${header}u UU N... 100644 100644 src/retry.ts\0`,
    ]
    for (const status of invalid) {
      await fs.writeFile(statusPath, status)
      const response = await call(root, 'delta.compute', { gitEvidencePath: evidence, scope: { kind: 'repository' }, taskEvidence })
      expect(response.status).toBe('failed')
      expect(response.diagnostics?.[0]?.code).toMatch(/^GIT_(?:STATUS_INVALID|STATUS_HEAD_MISMATCH)$/)
    }

    // Git 测试记录使用的全零对象 ID 占位值。
    const zero = '0'.repeat(40)
    await fs.writeFile(
      statusPath,
      [
        `${header}# branch.upstream origin/main\0# branch.ab +1 -2\0u UU N... 100644 100644 100644 100644 ${zero} ${zero} ${zero} src/retry.ts\0`,
        `2 R. N... 100644 100644 100644 ${zero} ${zero} R100 src/client.ts\0`,
        'src/old-client.ts\0',
      ].join(''),
    )
    const valid = await call(root, 'delta.compute', { gitEvidencePath: evidence, scope: { kind: 'repository' }, taskEvidence })
    expect(valid.status).toBe('success')
    expect(JSON.stringify(valid.data?.changedPaths)).toContain('src/retry.ts')
    expect(JSON.stringify(valid.data?.changedPaths)).toContain('src/old-client.ts')
  })

  it('uses a cursor when Delta lists exceed the output budget', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    await fs.writeFile(path.join(root, 'src/service.ts'), 'changed\n')
    await fs.writeFile(path.join(root, 'src/client.ts'), 'changed\n')
    // 当前工作流拥有的宿主 Git 证据叶子或已校验快照。
    const evidence = await writeGitEvidence(root, {
      revision: REVISION_C,
      diff: nameStatus([{ status: 'M', path: 'src/service.ts' }, { status: 'M', path: 'src/client.ts' }]),
    })
    const response = await call(root, 'delta.compute', { gitEvidencePath: evidence, scope: { kind: 'repository' }, taskEvidence }, {
      budget: { items: 1, bytes: 1024 * 1024, estimatedTokens: 128000 },
    })
    expect(response.status).toBe('incomplete')
    expect(response.cursor).toEqual(expect.any(String))
  })

  it('keeps source-degraded Delta actionable and invalidates its cursor when source facts change', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    await fs.rm(path.join(root, 'src/retry.ts'))
    // 当前工作流拥有的宿主 Git 证据叶子或已校验快照。
    const evidence = await writeGitEvidence(root, {
      revision: REVISION_C,
      diff: nameStatus([{ status: 'D', path: 'src/retry.ts' }, { status: 'M', path: 'src/service.ts' }]),
    })
    // 当前能力已解析的业务参数。
    const input = { gitEvidencePath: evidence, scope: { kind: 'repository' as const }, taskEvidence }
    const first = await call(root, 'delta.compute', input, {
      budget: { items: 1, bytes: 1024 * 1024, estimatedTokens: 128000 },
    })
    expect(first.status).toBe('incomplete')

    // 应用响应预算后选出的当前结果页。
    let page = first
    // 续读过程中收集的全部响应页，用于验证不遗漏或重复。
    const pages = [first]
    while (page.cursor !== undefined) {
      page = await call(root, 'delta.compute', input, { cursor: page.cursor })
      pages.push(page)
    }
    expect(JSON.stringify(pages.map(item => item.data?.directImpact))).toContain('service.retry')
    expect(JSON.stringify(pages.map(item => item.data?.brokenEvidence))).toContain('SOURCE_EXACT_MISSING')
    expect(JSON.stringify(pages.map(item => item.data?.light))).toContain('evidence is incomplete')

    await fs.writeFile(path.join(root, 'src/retry.ts'), 'restored after cursor\n')
    const stale = await call(root, 'delta.compute', input, { cursor: first.cursor as string })
    expect(stale).toMatchObject({ status: 'failed', diagnostics: [{ code: 'CURSOR_STALE' }] })
  })
})
