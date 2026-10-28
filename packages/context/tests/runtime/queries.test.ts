import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { call, CLIENT_DOMAIN, createRepository, feedbackId, removeRepository, REVISION_A, SERVICE_DOMAIN, SERVICE_GUIDE } from './fixture.js'

// 当前测试文件拥有的临时仓库集合，由 afterEach 统一清理。
const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(removeRepository)))

// 固定复盘文档夹具，用于反馈匹配和检索测试。
const REFLECTION = {
  relativePath: 'service/reflections/retry-learning.md',
  id: 'service.retry-learning',
  kind: 'reflection' as const,
  domain: 'service',
  description: 'Retry corrections for transient failures.',
  relations: { related: ['service.retry'] },
  body: '# Retry learning\n\nRetry only transient failures and preserve permanent errors.\n',
}

/** 创建可读取的正式 Context 及固定源码基线。 */
async function ready(): Promise<string> {
  // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
  const root = await createRepository({ documents: [SERVICE_DOMAIN, SERVICE_GUIDE, CLIENT_DOMAIN, REFLECTION], baselineRevision: REVISION_A })
  roots.push(root)
  return root
}

describe('read queries', () => {
  it('reports absent, ready, and invalid Context/Meta L0 states without returning bodies or Git details', async () => {
    // 尚未创建正式 Context 的隔离测试仓库。
    const absent = await createRepository()
    roots.push(absent)
    expect(await call(absent, 'repository.inspect', {})).toMatchObject({
      status: 'success',
      data: { context: { state: 'absent' }, meta: { state: 'absent' } },
    })

    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await ready()
    const readyResponse = await call(root, 'repository.inspect', {})
    expect(readyResponse).toMatchObject({
      status: 'success',
      data: { context: { state: 'ready' }, meta: { state: 'valid' }, counts: { domains: 2, documents: 4 } },
    })
    expect(JSON.stringify(readyResponse)).not.toContain('Retry only transient')
    expect(JSON.stringify(readyResponse)).not.toContain('currentRevision')
    expect(JSON.stringify(readyResponse)).not.toContain('relationCount')

    await fs.writeFile(path.join(root, 'context/.meta/manifest.json'), '{}')
    const invalid = await call(root, 'repository.inspect', {})
    expect(invalid.data).toMatchObject({ context: { state: 'invalid' }, meta: { state: 'invalid' } })
    expect(invalid.diagnostics?.length).toBeGreaterThan(0)
  })

  it('reports a short active write run without blocking read-only queries', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await ready()
    // 当前事务的 UUID，也是其运行目录和写锁的所有权标识。
    const runId = '00000000-0000-4000-8000-000000000001'
    await fs.mkdir(path.join(root, `.scratch/locks/context-write`), { recursive: true })
    await fs.writeFile(path.join(root, `.scratch/locks/context-write/owner.json`), JSON.stringify({ kind: 'plugydown.context.lock', format: 1, runId }))
    await fs.mkdir(path.join(root, `.scratch/runs/${runId}`), { recursive: true })
    await fs.writeFile(path.join(root, `.scratch/runs/${runId}/manifest.json`), JSON.stringify({ kind: 'plugydown.context.transaction', format: 1, runId, command: 'update', phase: 'staged' }))

    const inspect = await call(root, 'repository.inspect', {})
    expect(inspect.data?.activeRun).toEqual({ runId, command: 'update', phase: 'staged' })
    expect((await call(root, 'frontier.query', { depth: 1 })).status).toBe('success')
  })

  it('does not echo malformed lock owner or manifest identity values', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await ready()
    // 当前事务的 UUID，也是其运行目录和写锁的所有权标识。
    const runId = '00000000-0000-4000-8000-000000000002'
    await fs.mkdir(path.join(root, '.scratch/locks/context-write'), { recursive: true })
    await fs.writeFile(path.join(root, '.scratch/locks/context-write/owner.json'), JSON.stringify({ kind: 'plugydown.context.lock', format: 1, runId }))
    await fs.mkdir(path.join(root, `.scratch/runs/${runId}`), { recursive: true })
    await fs.writeFile(path.join(root, `.scratch/runs/${runId}/manifest.json`), JSON.stringify({ kind: 'plugydown.context.transaction', format: 1, runId, command: '/tmp', phase: '/tmp' }))

    const inspect = await call(root, 'repository.inspect', {})

    expect(inspect.data?.activeRun).toBeUndefined()
    expect(inspect.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ACTIVE_RUN_INVALID', severity: 'warning' })]))
    expect(JSON.stringify(inspect)).not.toContain('/tmp')
  })

  it('rejects a lock owner that the transaction plane would call corrupt', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await ready()
    // 当前事务的 UUID，也是其运行目录和写锁的所有权标识。
    const runId = '00000000-0000-4000-8000-000000000003'
    await fs.mkdir(path.join(root, '.scratch/locks/context-write'), { recursive: true })
    await fs.mkdir(path.join(root, `.scratch/runs/${runId}`), { recursive: true })
    await fs.writeFile(path.join(root, `.scratch/runs/${runId}/manifest.json`), JSON.stringify({ kind: 'plugydown.context.transaction', format: 1, runId, command: 'update', phase: 'staged' }))

    // 清单即使合法，也不能把缺少锁格式标识的所有者误判为活动事务。
    for (const owner of [{ runId }, { kind: 'plugydown.context.lock', format: 1, runId, extra: 1 }]) {
      await fs.writeFile(path.join(root, '.scratch/locks/context-write/owner.json'), JSON.stringify(owner))
      const inspect = await call(root, 'repository.inspect', {})

      expect(inspect.data?.activeRun).toBeUndefined()
      expect(inspect.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'WRITE_LOCK_INVALID' })]))
    }
  })

  it('provides L1 Domain metadata, L2 Document metadata, and only L3 bodies', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await ready()
    const l1 = await call(root, 'frontier.query', { depth: 1 })
    const l2 = await call(root, 'frontier.query', { depth: 2, selectors: { domainIds: ['service'] } })
    // 显式选择正文及前置依赖的深度三查询参数。
    const l3Input = { depth: 3 as const, selectors: { documentIds: ['service.retry'] }, requiresClosure: true }
    const l3 = await call(root, 'frontier.query', l3Input)
    const l3Body = await call(root, 'frontier.query', l3Input, { cursor: l3.cursor as string })
    const l3Domain = await call(root, 'frontier.query', { depth: 3, selectors: { domainIds: ['service'] } })

    expect((l1.data?.items as unknown[])).toHaveLength(2)
    expect(JSON.stringify(l1.data)).not.toContain('body')
    expect((l2.data?.items as Array<Record<string, unknown>>)[0]?.id).toBe('service')
    expect(JSON.stringify(l2.data)).not.toContain('Retry only transient failures')
    expect(l3).toMatchObject({ status: 'incomplete', data: { items: [expect.not.objectContaining({ id: 'service', body: expect.anything() })] } })
    expect(l3Body.data?.items).toEqual([
      expect.objectContaining({
        id: 'service.retry',
        body: expect.objectContaining({ text: expect.stringContaining('Retry only transient failures'), startByte: 0, complete: true }),
      }),
    ])
    expect((l3Domain.data?.items as Array<Record<string, unknown>>).every(item => !('body' in item))).toBe(true)
  })

  it('supports Domain, Document, kind, relation, and code path selectors with explained requires closure', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await ready()
    const byDomain = await call(root, 'frontier.query', { depth: 2, selectors: { domainIds: ['client'] } })
    expect((byDomain.data?.items as Array<Record<string, unknown>>).map(item => item.id)).toEqual(['client'])

    const byDocument = await call(root, 'frontier.query', { depth: 2, selectors: { documentIds: ['service.retry'] }, requiresClosure: true })
    expect((byDocument.data?.items as Array<Record<string, unknown>>).map(item => item.id)).toEqual(['service', 'service.retry'])
    expect(JSON.stringify(byDocument.data)).toContain('required by service.retry')

    const byKind = await call(root, 'frontier.query', { depth: 2, selectors: { kinds: ['reflection'] } })
    expect((byKind.data?.items as Array<Record<string, unknown>>).map(item => item.id)).toEqual(['service.retry-learning'])

    const byRelation = await call(root, 'frontier.query', { depth: 2, selectors: { relation: { type: 'requires', documentId: 'service.retry' } } })
    expect((byRelation.data?.items as Array<Record<string, unknown>>).map(item => item.id)).toEqual(['service'])

    const byCode = await call(root, 'frontier.query', { depth: 2, selectors: { codePaths: ['src/retry.ts'] } })
    expect((byCode.data?.items as Array<Record<string, unknown>>).map(item => item.id)).toEqual(['service.retry'])
  })

  it('selects every Document whose declaration falls inside a code path glob', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await ready()

    const wide = await call(root, 'frontier.query', { depth: 2, selectors: { codePaths: ['src/**'] } })
    expect((wide.data?.items as Array<Record<string, unknown>>).map(item => item.id))
      .toEqual(['client', 'service', 'service.retry'])

    const narrow = await call(root, 'frontier.query', { depth: 2, selectors: { codePaths: ['src/client.ts'] } })
    expect((narrow.data?.items as Array<Record<string, unknown>>).map(item => item.id)).toEqual(['client'])

    const elsewhere = await call(root, 'frontier.query', { depth: 2, selectors: { codePaths: ['packages/other/**'] } })
    expect(elsewhere.data?.items).toEqual([])
  })

  it('derives targeted source freshness for compact continuation', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await ready()
    const fresh = await call(root, 'repository.inspect', { selectedDocumentIds: ['service.retry'] })
    expect(fresh.data?.selected).toEqual([
      expect.objectContaining({ documentId: 'service.retry', confirmationState: 'matched' }),
    ])

    await fs.writeFile(path.join(root, 'src/retry.ts'), 'changed\n')
    const stale = await call(root, 'repository.inspect', { selectedDocumentIds: ['service.retry'] })
    expect(stale.data?.selected).toEqual([expect.objectContaining({ documentId: 'service.retry', confirmationState: 'unmatched' })])
  })

  it('keeps formal-only reads usable when an unrelated source is unavailable', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await ready()
    await fs.rm(path.join(root, 'src/client.ts'))

    const inspect = await call(root, 'repository.inspect', {})
    expect(inspect).toMatchObject({ status: 'success', data: { context: { state: 'ready', sourceState: 'unchecked' } } })
    expect((await call(root, 'frontier.query', { depth: 1 })).status).toBe('success')
    expect((await call(root, 'growth.measure', {})).status).toBe('success')

    const selectedService = await call(root, 'repository.inspect', { selectedDocumentIds: ['service.retry'] })
    expect(selectedService).toMatchObject({ status: 'success', data: { context: { sourceState: 'ready' } } })
    const selectedClient = await call(root, 'repository.inspect', { selectedDocumentIds: ['client'] })
    expect(selectedClient).toMatchObject({
      status: 'success',
      data: { context: { state: 'ready', sourceState: 'degraded' }, selected: [{ documentId: 'client', confirmationState: 'unavailable' }] },
    })
    expect((await call(root, 'graph.validate', {}))).toMatchObject({ status: 'failed' })
  })

  it('measures current/baseline/delta/per-Domain growth and stable convergence candidates without writes', async () => {
    const { relations: _relations, codePaths: _codePaths, ...guideBase } = SERVICE_GUIDE
    // 用于触发碎片化候选的小型文档夹具。
    const tinyA = { ...guideBase, id: 'service.a', relativePath: 'service/manual/a.md', body: '# A\n' }
    // 与同领域小文档并列的第二份碎片化夹具。
    const tinyB = { ...tinyA, id: 'service.b', relativePath: 'service/manual/b.md' }
    // 与同领域小文档并列的第三份碎片化夹具。
    const tinyC = { ...tinyA, id: 'service.c', relativePath: 'service/manual/c.md' }
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await createRepository({ documents: [SERVICE_DOMAIN, tinyA, tinyB, tinyC] })
    roots.push(root)
    const before = JSON.stringify((await call(root, 'repository.inspect', {})).data)
    const first = await call(root, 'growth.measure', {})
    const second = await call(root, 'growth.measure', {})

    expect(first.status).toBe('success')
    expect(first.data).toMatchObject({ current: { documentCount: 4 }, baseline: { source: 'init' }, delta: { documentCount: 0 } })
    expect(first.data?.perDomain).toEqual([expect.objectContaining({ id: 'service' })])
    expect(JSON.stringify(first.data?.candidates)).toContain('fragmented')
    expect(first).toEqual(second)
    expect(JSON.stringify((await call(root, 'repository.inspect', {})).data)).toBe(before)

    const pageOne = await call(root, 'growth.measure', {}, { budget: { items: 1, bytes: 1024 * 1024, estimatedTokens: 128000 } })
    expect(pageOne).toMatchObject({ status: 'incomplete', data: { perDomain: [expect.objectContaining({ id: 'service' })], candidates: [] } })
    const pageTwo = await call(root, 'growth.measure', {}, { cursor: pageOne.cursor as string })
    expect(JSON.stringify(pageTwo.data?.candidates)).toContain('fragmented')
  })

  it('matches temporary Feedback and formal Reflection deterministically without score, promotion, or writes', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await ready()
    // 固定的反馈情境、行为、结果与复用边界。
    const feedbackFields = {
      context: 'Retry requests',
      observedBehavior: 'Permanent errors retried',
      outcomeOrCorrection: 'Retry transient failures only',
      reuseBoundary: 'Service requests',
    }
    // 从反馈匹配字段生成的持久叶子身份。
    const storedId = feedbackId(feedbackFields)
    // 当前测试拥有的反馈 Markdown 相对路径。
    const feedbackPath = `.scratch/feedback/${storedId}.md`
    await fs.mkdir(path.dirname(path.join(root, feedbackPath)), { recursive: true })
    // 当前测试使用的完整反馈 Markdown 文本或匹配响应。
    const feedback = `# Context\n${feedbackFields.context}\n# Observed behavior\n${feedbackFields.observedBehavior}\n# Outcome or correction\n${feedbackFields.outcomeOrCorrection}\n# Evidence\nsrc/retry.ts\n# Reuse boundary\n${feedbackFields.reuseBoundary}\n`
    await fs.writeFile(path.join(root, feedbackPath), feedback)
    // 当前能力已解析的业务参数。
    const input = { context: 'Retry service requests', observedBehavior: 'Permanent errors retried', outcomeOrCorrection: 'Retry transient failures only', reuseBoundary: 'Service requests' }
    const first = await call(root, 'feedback.match', input)
    const second = await call(root, 'feedback.match', input)

    expect(first.status).toBe('success')
    expect(first.data?.suggestedId).toBe(second.data?.suggestedId)
    expect(first.data?.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'feedback', id: storedId }),
      expect.objectContaining({ kind: 'reflection', id: 'service.retry-learning' }),
    ]))
    expect(JSON.stringify(first)).not.toMatch(/score|mature|promot/i)
    expect(await fs.readFile(path.join(root, feedbackPath), 'utf8')).toBe(feedback)
  })

  it('paginates Growth and Feedback candidates instead of truncating them', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await ready()
    await fs.mkdir(path.join(root, '.scratch/feedback'), { recursive: true })
    for (const label of ['one', 'two']) {
      // 当前协议对象需要校验的业务字段集合。
      const fields = { context: `${label} retry`, observedBehavior: 'retry', outcomeOrCorrection: 'retry', reuseBoundary: 'retry' }
      // 根据反馈身份生成的叶子文件名。
      const name = feedbackId(fields)
      await fs.writeFile(path.join(root, `.scratch/feedback/${name}.md`), `# Context\n${fields.context}\n# Observed behavior\nretry\n# Outcome or correction\nretry\n# Evidence\nretry\n# Reuse boundary\nretry\n`)
    }
    const response = await call(root, 'feedback.match', { context: 'retry', observedBehavior: 'retry', outcomeOrCorrection: 'retry', reuseBoundary: 'retry' }, {
      budget: { items: 1, bytes: 1024 * 1024, estimatedTokens: 128000 },
    })
    expect(response.status).toBe('incomplete')
    expect(response.cursor).toEqual(expect.any(String))
  })

  it('binds Inspect and Feedback cursors to their capability-owned datasets', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await ready()
    // 指定多个文档身份的分页检查请求。
    const selectedInput = { selectedDocumentIds: ['client', 'service', 'service.retry', 'service.retry-learning'] }
    const inspect = await call(root, 'repository.inspect', selectedInput, {
      budget: { items: 1, bytes: 1024 * 1024, estimatedTokens: 128000 },
    })
    expect(inspect.status).toBe('incomplete')
    await fs.writeFile(path.join(root, 'src/client.ts'), 'changed after cursor\n')
    expect(await call(root, 'repository.inspect', selectedInput, { cursor: inspect.cursor as string })).toMatchObject({
      status: 'failed',
      diagnostics: [{ code: 'CURSOR_STALE' }],
    })

    await fs.mkdir(path.join(root, '.scratch/feedback'), { recursive: true })
    // 测试创建的反馈文件路径，供后续修改来源验证游标过期。
    const stored: string[] = []
    for (const label of ['first', 'second']) {
      // 当前协议对象需要校验的业务字段集合。
      const fields = { context: `${label} retry`, observedBehavior: 'retry failed', outcomeOrCorrection: 'retry transient', reuseBoundary: 'service' }
      // 当前从队列或所有者键解析出的稳定文档身份。
      const id = feedbackId(fields)
      // 当前文件相对所属根目录的稳定路径。
      const relative = `.scratch/feedback/${id}.md`
      stored.push(relative)
      await fs.writeFile(path.join(root, relative), `# Context\n${fields.context}\n# Observed behavior\n${fields.observedBehavior}\n# Outcome or correction\n${fields.outcomeOrCorrection}\n# Evidence\none\n# Reuse boundary\n${fields.reuseBoundary}\n`)
    }
    // 用于跨页验证的固定反馈匹配参数。
    const feedbackInput = { context: 'retry', observedBehavior: 'retry failed', outcomeOrCorrection: 'retry transient', reuseBoundary: 'service' }
    const feedback = await call(root, 'feedback.match', feedbackInput, {
      budget: { items: 1, bytes: 1024 * 1024, estimatedTokens: 128000 },
    })
    expect(feedback.status).toBe('incomplete')
    const changed = await fs.readFile(path.join(root, stored[1] as string), 'utf8')
    await fs.writeFile(path.join(root, stored[1] as string), changed.replace('# Evidence\none', '# Evidence\ntwo'))
    expect(await call(root, 'feedback.match', feedbackInput, { cursor: feedback.cursor as string })).toMatchObject({
      status: 'failed',
      diagnostics: [{ code: 'CURSOR_STALE' }],
    })
  })

  it('rejects Feedback outside the unified slug plus short content hash naming contract', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await ready()
    await fs.mkdir(path.join(root, '.scratch/feedback'), { recursive: true })
    await fs.writeFile(path.join(root, '.scratch/feedback/retry.md'), '# Context\nretry\n# Observed behavior\nretry\n# Outcome or correction\nretry\n# Evidence\nretry\n# Reuse boundary\nretry\n')

    const response = await call(root, 'feedback.match', { context: 'retry', observedBehavior: 'retry', outcomeOrCorrection: 'retry', reuseBoundary: 'retry' })

    expect(response).toMatchObject({ status: 'failed', diagnostics: [{ code: 'FEEDBACK_FILE_INVALID' }] })
  })

  it('accepts BOM/CRLF Feedback, uses the ASCII fallback, and rejects duplicate headings', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await ready()
    // 当前协议对象需要校验的业务字段集合。
    const fields = { context: '重试请求', observedBehavior: '永久错误', outcomeOrCorrection: '只重试瞬态失败', reuseBoundary: '服务请求' }
    // 当前从队列或所有者键解析出的稳定文档身份。
    const id = feedbackId(fields)
    expect(id).toMatch(/^feedback-[a-f0-9]{8}$/)
    // 当前文件相对所属根目录的稳定路径。
    const relative = `.scratch/feedback/${id}.md`
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true })
    const valid = `\uFEFF# Context\r\n${fields.context}\r\n# Observed behavior\r\n${fields.observedBehavior}\r\n# Outcome or correction\r\n${fields.outcomeOrCorrection}\r\n# Evidence\r\n任意证据\r\n# Reuse boundary\r\n${fields.reuseBoundary}\r\n`
    await fs.writeFile(path.join(root, relative), valid)
    expect((await call(root, 'feedback.match', fields)).status).toBe('success')

    await fs.writeFile(path.join(root, relative), `${valid}# Context\r\nduplicate\r\n`)
    expect(await call(root, 'feedback.match', fields)).toMatchObject({
      status: 'failed',
      diagnostics: [{ code: 'FEEDBACK_FORMAT_INVALID', path: '.scratch/feedback' }],
    })
  })

  it('rejects Feedback filename/body identity mismatch without disclosing the leaf', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await ready()
    // 当前文件相对所属根目录的稳定路径。
    const relative = '.scratch/feedback/private-deadbeef.md'
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true })
    await fs.writeFile(path.join(root, relative), '# Context\nretry\n# Observed behavior\nretry\n# Outcome or correction\nretry\n# Evidence\nsecret\n# Reuse boundary\nretry\n')
    const response = await call(root, 'feedback.match', { context: 'retry', observedBehavior: 'retry', outcomeOrCorrection: 'retry', reuseBoundary: 'retry' })
    expect(response).toMatchObject({
      status: 'failed',
      diagnostics: [{ code: 'FEEDBACK_IDENTITY_INVALID', path: '.scratch/feedback' }],
    })
    expect(JSON.stringify(response)).not.toContain('private-deadbeef')
  })
})

describe('public confirmation facts', () => {
  it('binds paged counts to the whole selection and rejects changed snapshots', async () => {
    const root = await ready()
    const input = { explain: true }
    const first = await call(root, 'confirmation.check', input, { budget: { items: 1 } })
    expect(first).toMatchObject({ status: 'incomplete', data: { summary: { documents: 4, checked: 4, matched: 4, unmatched: 0, unavailable: 0, unchecked: 0 }, recordStore: { state: 'valid', coverage: 'repository' } } })
    const rest = await call(root, 'confirmation.check', input, { cursor: first.cursor! })
    expect(rest.status).toBe('success')
    expect(rest.data?.snapshotFingerprint).toBe(first.data?.snapshotFingerprint)
    await fs.writeFile(path.join(root, 'src/retry.ts'), 'changed\n')
    expect((await call(root, 'confirmation.check', input, { cursor: first.cursor! })).diagnostics?.[0]?.code).toBe('CURSOR_STALE')
  })

  it('reports outside scope as unchecked and supports a path selection with no matching Document', async () => {
    const root = await ready()
    expect((await call(root, 'confirmation.check', { scope: { kind: 'documents', ids: ['service.retry'] } })).data?.summary).toEqual({ documents: 4, checked: 1, matched: 1, unmatched: 0, unavailable: 0, unchecked: 3 })
    expect(await call(root, 'confirmation.check', { scope: { kind: 'paths', paths: ['src/other.ts'] } })).toMatchObject({ status: 'success', data: { sourceState: 'unchecked', items: [], summary: { checked: 0, unchecked: 4 } } })
  })
})
