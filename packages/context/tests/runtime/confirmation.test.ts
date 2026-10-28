import type { ConfirmationRecord } from '../../src/runtime/confirmation.js'
import type { MetadataManifest } from '../../src/runtime/document.js'
import type { FixtureDocument } from './fixture.js'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import confirmationSchema from '../../public/schemas/confirmation.schema.json' with { type: 'json' }
import metaSchema from '../../public/schemas/meta.schema.json' with { type: 'json' }
import { checkConfirmations, confirmationKey, currentConfirmation, MAX_CONFIRMATION_BYTES, parseConfirmation, readConfirmationStore } from '../../src/runtime/confirmation.js'
import { parseMetadataManifest, serializeMetadataManifest } from '../../src/runtime/document.js'
import { loadKnowledge } from '../../src/runtime/graph.js'
import { FORMAT } from '../../src/runtime/protocol.js'
import { CONFIRMATIONS_ROOT, inspectMetadataLayout, METADATA_MANIFEST_PATH, METADATA_ROOT } from '../../src/runtime/repository.js'
import { stableJson } from '../../src/runtime/stable-json.js'
import { call, CLIENT_DOMAIN, createRepository, documentSource, removeRepository, REVISION_A, SERVICE_DOMAIN, SERVICE_GUIDE } from './fixture.js'

// 每个测试只操作并清理自己的隔离工作树。
const roots: string[] = []
// 新数据合同使用交付 Schema 校验，不仅依赖实现的类型守卫。
const ajv = new Ajv2020({ strict: true, allErrors: true })
// 公开确认 Schema 的编译校验函数。
const validateConfirmation = ajv.compile(confirmationSchema)
// 覆盖新旧元数据的公开 Schema 校验函数。
const validateMetadata = ajv.compile(metaSchema)
// 与设计文档一致的完整四字段黄金向量。
const golden: ConfirmationRecord = {
  documentId: 'example.guide',
  frontMatterFingerprint: 'a'.repeat(64),
  bodyFingerprint: 'b'.repeat(64),
  sourceFingerprint: 'c'.repeat(64),
}
// 身份只由 format 和完整记录确定，不包含文件路径或软件版本。
const goldenKey = 'c46580779bae2d2bf4427257902fc38839b2b275ee9c84f7e28e7544adf1cb52'

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(removeRepository))
})

/** 创建新布局 fixture；直接改写只发生在测试仓库，不是正式迁移实现。 */
async function repository(documents: readonly FixtureDocument[] = [SERVICE_DOMAIN, SERVICE_GUIDE, CLIENT_DOMAIN]): Promise<string> {
  // 当前用例拥有的隔离仓库根目录。
  const root = await createRepository({ documents, legacy: true })
  roots.push(root)
  await fs.unlink(path.join(root, 'context/meta.json'))
  await fs.mkdir(path.join(root, METADATA_ROOT))
  await fs.writeFile(path.join(root, METADATA_MANIFEST_PATH), serializeMetadataManifest({ format: FORMAT }))
  return root
}

/** 在夹具中保存一份内容记录；只用于模拟已经存在的历史确认。 */
async function storeRecord(root: string, record: ConfirmationRecord): Promise<string> {
  expect(validateConfirmation(record)).toBe(true)
  // 绑定完整确认内容与 format 的稳定身份。
  const key = confirmationKey(FORMAT, record)
  // 当前记录集合所属的安全目录。
  const directory = path.join(root, CONFIRMATIONS_ROOT, record.documentId)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, `${key}.json`), stableJson({ ...record }))
  return key
}

/** 获取已读取且来源完整的当前记录，用于构造明确的确认 fixture。 */
async function recordFor(root: string, documentId = SERVICE_GUIDE.id): Promise<ConfirmationRecord> {
  // 本次实际读取的知识图和来源事实。
  const graph = await loadKnowledge(root, 'context', { format: FORMAT })
  // 本用例明确创建或校验的完整确认记录。
  const record = currentConfirmation(graph, documentId)
  expect(record).toBeDefined()
  return record!
}

/** 执行固定身份和环境下的 Git 命令，不读写用户配置。 */
function git(root: string, args: readonly string[]): string {
  // 隔离宿主的 Git 目录、索引、配置和对象库变量，避免测试触碰真实工作树。
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  return execFileSync('git', ['-c', 'user.name=Context Fixture', '-c', 'user.email=context@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...environment, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: '@1 +0000', GIT_COMMITTER_DATE: '@1 +0000', GIT_EDITOR: 'true' },
  }).trim()
}

describe('current metadata contract', () => {
  it('preserves historical baselines without making them part of confirmation identity', () => {
    // 本次校验或写入的统一格式入口。
    const metadata: MetadataManifest = {
      format: FORMAT,
      repository: { baseline: { revision: REVISION_A, sourceFingerprint: 'a'.repeat(64) } },
      convergence: { source: 'init' as const, documentCount: 1, frontMatterBytes: 3, bodyBytes: 6, estimatedTokens: 3, perDomain: { service: { documentCount: 1, frontMatterBytes: 3, bodyBytes: 6, estimatedTokens: 3 } } },
    }
    expect(validateMetadata(metadata)).toBe(true)
    expect(parseMetadataManifest(METADATA_MANIFEST_PATH, serializeMetadataManifest(metadata))).toEqual(metadata)
    expect(confirmationKey(metadata.format, golden)).toBe(goldenKey)
  })

  it.each([
    {},
    { format: 2 },
    { format: '1' },
    { format: 1, reviewRequired: true },
    { format: 1, documents: {} },
    { format: 1, repository: null },
    { format: 1, convergence: null },
    { format: 1, repository: { baseline: { revision: 'main', sourceFingerprint: 'a'.repeat(64) } } },
  ])('rejects malformed metadata in both parser and schema: %#', (value) => {
    expect(validateMetadata(value)).toBe(false)
    expect(() => parseMetadataManifest(METADATA_MANIFEST_PATH, JSON.stringify(value))).toThrow()
  })

  it('rejects duplicate fields and noncanonical serialization', () => {
    expect(() => parseMetadataManifest(METADATA_MANIFEST_PATH, '{"format": 1, "format": 1}\n')).toThrow('canonical')
    expect(() => parseMetadataManifest(METADATA_MANIFEST_PATH, '{"format":1}')).toThrow('canonical')
    expect(() => parseMetadataManifest(METADATA_MANIFEST_PATH, '{')).toThrow('valid JSON')
  })

  it('distinguishes absent, incomplete, legacy and current layout', async () => {
    // 当前用例拥有的隔离仓库根目录。
    const root = await createRepository()
    roots.push(root)
    expect(await inspectMetadataLayout(root)).toBe('absent')
    await fs.mkdir(path.join(root, 'context'))
    expect(await inspectMetadataLayout(root)).toBe('incomplete')
    await fs.writeFile(path.join(root, 'context/meta.json'), '{}')
    expect(await inspectMetadataLayout(root)).toBe('legacy')
    await fs.unlink(path.join(root, 'context/meta.json'))
    await fs.mkdir(path.join(root, METADATA_ROOT))
    await expect(inspectMetadataLayout(root)).rejects.toMatchObject({ code: 'METADATA_MANIFEST_MISSING' })
    await fs.writeFile(path.join(root, METADATA_MANIFEST_PATH), serializeMetadataManifest({ format: FORMAT }))
    expect(await inspectMetadataLayout(root)).toBe('current')
    await fs.writeFile(path.join(root, 'context/meta.json'), '{}')
    await expect(inspectMetadataLayout(root)).rejects.toMatchObject({ code: 'METADATA_LAYOUT_CONFLICT' })
  })

  it('rejects a linked manifest and unknown metadata entries', async () => {
    // 当前用例拥有的隔离仓库根目录。
    const root = await repository()
    await fs.unlink(path.join(root, METADATA_MANIFEST_PATH))
    await fs.symlink('../../src/service.ts', path.join(root, METADATA_MANIFEST_PATH))
    await expect(inspectMetadataLayout(root)).rejects.toMatchObject({ code: 'PATH_SYMLINK' })
    await fs.unlink(path.join(root, METADATA_MANIFEST_PATH))
    await fs.writeFile(path.join(root, METADATA_MANIFEST_PATH), serializeMetadataManifest({ format: FORMAT }))
    await fs.writeFile(path.join(root, METADATA_ROOT, 'current.json'), '{}')
    await expect(inspectMetadataLayout(root)).rejects.toMatchObject({ code: 'METADATA_ENTRY_INVALID' })
  })

  it.each([7, 32])('rejects Git conflict markers of width %i in the shared parser', async (width) => {
    // 当前用例拥有的隔离仓库根目录。
    const root = await repository([SERVICE_DOMAIN, { ...SERVICE_GUIDE, body: `# Conflict\n\n${'<'.repeat(width)} ours\nA\n${'='.repeat(width)}\nB\n${'>'.repeat(width)} theirs\n` }])
    await expect(checkConfirmations(root)).rejects.toMatchObject({ code: 'DOCUMENT_CONFLICT_MARKER' })
  })

  it('accepts the current layout through the public entry', async () => {
    // 当前用例拥有的隔离仓库根目录。
    const root = await repository()
    expect(await call(root, 'repository.inspect', {})).toMatchObject({ data: { context: { state: 'ready' } } })
  })
})

describe('immutable confirmation records', () => {
  it('matches the independently computed design vector without storing a version field', () => {
    expect(validateConfirmation(golden)).toBe(true)
    expect(confirmationKey(FORMAT, golden)).toBe(goldenKey)
    expect(parseConfirmation(FORMAT, golden.documentId, goldenKey, stableJson({ ...golden }))).toEqual(golden)
    expect(() => confirmationKey(2, golden)).toThrow('unsupported')
  })

  it.each([
    { ...golden, format: 1 },
    { ...golden, reviewRequired: true },
    { ...golden, sourceFingerprint: 'missing' },
    { ...golden, documentId: '../escape' },
    { ...golden, frontMatterFingerprint: null },
    { documentId: golden.documentId },
  ])('rejects invalid records in the parser and schema: %#', (value) => {
    expect(validateConfirmation(value)).toBe(false)
    expect(() => parseConfirmation(FORMAT, golden.documentId, goldenKey, JSON.stringify(value))).toThrow()
  })

  it('rejects duplicate JSON keys, wrong ownership, wrong keys and oversized records', () => {
    // 用于校验精确字节规则的规范 JSON。
    const canonical = stableJson({ ...golden })
    // 包含重复键的无效 JSON，不能被解析器静默接受。
    const duplicate = canonical.replace('"documentId":', '"documentId": "example.guide",\n  "documentId":')
    expect(() => parseConfirmation(FORMAT, golden.documentId, goldenKey, duplicate)).toThrow('canonical')
    expect(() => parseConfirmation(FORMAT, 'example.other', goldenKey, canonical)).toThrow('another Document')
    expect(() => parseConfirmation(FORMAT, golden.documentId, '0'.repeat(64), canonical)).toThrow('content key')
    expect(() => parseConfirmation(FORMAT, golden.documentId, goldenKey, ' '.repeat(MAX_CONFIRMATION_BYTES + 1))).toThrow('byte limit')
  })

  it('treats no records as unconfirmed, then finds an exact historical record', async () => {
    // 当前用例拥有的隔离仓库根目录。
    const root = await repository()
    // 变更前的检查结果，用于验证状态变化。
    const before = await checkConfirmations(root, [SERVICE_GUIDE.id])
    expect(before.items).toMatchObject([{ confirmationState: 'unmatched', documentContentKnown: false, reasons: ['NO_CONFIRMATION'] }])
    // 绑定完整确认内容与 format 的稳定身份。
    const key = await storeRecord(root, await recordFor(root))
    // 变更后的检查结果，用于验证匹配与幂等性。
    const after = await checkConfirmations(root, [SERVICE_GUIDE.id])
    expect(after.items).toMatchObject([{ confirmationState: 'matched', matchedKey: key, currentKey: key, documentContentKnown: true }])
    expect(await checkConfirmations(root, [SERVICE_GUIDE.id])).toEqual(after)
  })

  it('distinguishes unchanged prose with changed sources, third prose and missing sources', async () => {
    // 当前用例拥有的隔离仓库根目录。
    const root = await repository()
    await storeRecord(root, await recordFor(root))
    await fs.appendFile(path.join(root, 'src/retry.ts'), '// changed\n')
    expect((await checkConfirmations(root, [SERVICE_GUIDE.id])).items).toMatchObject([{ confirmationState: 'unmatched', documentContentKnown: true, reasons: ['SOURCE_BASIS_CHANGED'] }])
    await fs.appendFile(path.join(root, 'context', SERVICE_GUIDE.relativePath), '\nNew prose.\n')
    expect((await checkConfirmations(root, [SERVICE_GUIDE.id])).items).toMatchObject([{ confirmationState: 'unmatched', documentContentKnown: false, reasons: ['DOCUMENT_CONTENT_UNKNOWN'] }])
    await fs.unlink(path.join(root, 'src/retry.ts'))
    // 来源缺失时的检查结果，不能带有效当前 key。
    const missing = await checkConfirmations(root, [SERVICE_GUIDE.id])
    expect(missing.items).toMatchObject([{ sourceState: 'unavailable', confirmationState: 'unavailable' }])
    expect(missing.items[0]).not.toHaveProperty('currentKey')
    expect(currentConfirmation(missing.graph, SERVICE_GUIDE.id)).toBeUndefined()
  })

  it('does not inspect unselected sources or require active documents for historical records', async () => {
    // 当前用例拥有的隔离仓库根目录。
    const root = await repository()
    await storeRecord(root, await recordFor(root, CLIENT_DOMAIN.id))
    await fs.unlink(path.join(root, 'src/client.ts'))
    // 当前调用已固定的文档选择集合或检查结果。
    const selected = await checkConfirmations(root, [SERVICE_GUIDE.id])
    expect(selected.graph.sourceIssues).toEqual([])
    expect(currentConfirmation(selected.graph, CLIENT_DOMAIN.id)).toBeUndefined()
    await fs.rm(path.join(root, 'context/client'), { recursive: true })
    expect((await checkConfirmations(root)).store.count).toBe(1)
  })

  it('cannot combine fields from different records into a confirmation', async () => {
    // 当前用例拥有的隔离仓库根目录。
    const root = await repository()
    // 本轮可用来源对应的完整内容元组。
    const current = await recordFor(root)
    await storeRecord(root, { ...current, sourceFingerprint: 'a'.repeat(64) })
    await storeRecord(root, { ...current, bodyFingerprint: 'b'.repeat(64) })
    expect((await checkConfirmations(root, [SERVICE_GUIDE.id])).items).toMatchObject([{ confirmationState: 'unmatched', documentContentKnown: true }])
  })

  it('keeps identity through a legal move and detects content changes without sources', async () => {
    // 无来源文档省略声明字段，仍需匹配正文与元数据。
    const { codePaths: _codePaths, ...sourceFree } = SERVICE_GUIDE
    // 本用例拥有的隔离仓库。
    const root = await repository([SERVICE_DOMAIN, sourceFree])
    // 初始内容对应的确认身份。
    const key = await storeRecord(root, await recordFor(root))
    await fs.rename(path.join(root, 'context', SERVICE_GUIDE.relativePath), path.join(root, 'context/service/manual/moved.md'))
    expect((await checkConfirmations(root, [SERVICE_GUIDE.id])).items).toMatchObject([{ matchedKey: key, path: 'context/service/manual/moved.md' }])
    await fs.appendFile(path.join(root, 'context/service/manual/moved.md'), '\nChanged claim.\n')
    expect((await checkConfirmations(root, [SERVICE_GUIDE.id])).items).toMatchObject([{ confirmationState: 'unmatched', documentContentKnown: false }])
  })

  it('rejects source symlinks without creating an empty-source confirmation', async () => {
    // 来源链接不能通过空集合降级获得有效身份。
    const root = await repository()
    await fs.unlink(path.join(root, 'src/retry.ts'))
    await fs.symlink('service.ts', path.join(root, 'src/retry.ts'))
    // 新读取入口必须保留来源归属与不可用状态。
    const result = await checkConfirmations(root, [SERVICE_GUIDE.id])
    expect(result.items).toMatchObject([{ sourceState: 'unavailable', confirmationState: 'unavailable' }])
    expect(result.graph.sourceIssues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PATH_SYMLINK', documentId: SERVICE_GUIDE.id })]))
    expect(result.items[0]).not.toHaveProperty('currentKey')
  })

  it.each(['linked record', 'nested directory', 'unexpected filename', 'modified record'] as const)('rejects %s instead of pretending no record exists', async (damage) => {
    // 当前用例拥有的隔离仓库根目录。
    const root = await repository()
    // 本用例明确创建或校验的完整确认记录。
    const record = await recordFor(root)
    // 绑定完整确认内容与 format 的稳定身份。
    const key = await storeRecord(root, record)
    // 本测试或读取阶段处理的具体安全文件路径。
    const file = path.join(root, CONFIRMATIONS_ROOT, record.documentId, `${key}.json`)
    if (damage === 'linked record') {
      await fs.unlink(file)
      await fs.symlink(path.join(root, 'src/retry.ts'), file)
    }
    if (damage === 'nested directory')
      await fs.mkdir(path.join(path.dirname(file), 'nested'))
    if (damage === 'unexpected filename')
      await fs.rename(file, path.join(path.dirname(file), 'latest.json'))
    if (damage === 'modified record')
      await fs.writeFile(file, stableJson({ ...record, bodyFingerprint: 'f'.repeat(64) }))
    await expect(readConfirmationStore(root, FORMAT)).rejects.toThrow()
  })

  it.each([{ ids: ['service.retry', 'service.retry'] }, { ids: ['../escape'] }, { ids: ['missing.document'] }])('rejects an invalid selection: %#', async ({ ids }) => {
    // 当前用例拥有的隔离仓库根目录。
    const root = await repository()
    await expect(checkConfirmations(root, ids)).rejects.toThrow()
  })

  it('rejects source changes while reading confirmation evidence', async () => {
    // 当前用例拥有的隔离仓库根目录。
    const root = await repository()
    // 绑定完整确认内容与 format 的稳定身份。
    const key = await storeRecord(root, await recordFor(root))
    // 保留原始文件读取方法，仅在其后注入确定性变化。
    const readFile = fs.readFile.bind(fs)
    // 目标确认文件的读取次数，用于固定故障注入位置。
    let reads = 0
    vi.spyOn(fs, 'readFile').mockImplementation(async (file, options) => {
      // 当前读取字节或累计字节数，用于完整性和预算检查。
      const bytes = await readFile(file, options)
      if (String(file).endsWith(`${key}.json`) && ++reads === 2)
        await fs.appendFile(path.join(root, 'src/retry.ts'), '// concurrent edit\n')
      return bytes
    })
    await expect(checkConfirmations(root, [SERVICE_GUIDE.id])).rejects.toMatchObject({ code: 'CHECK_SNAPSHOT_CHANGED' })
  })
})

describe('confirmation identity under actual Git operations', () => {
  it('combines independent document confirmations without a merge driver', async () => {
    // 两分支从相同新布局开始，分别改写不同文档。
    const root = await repository()
    git(root, ['init', '-b', 'main'])
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'test: base'])
    for (const [branch, document] of [['a', SERVICE_GUIDE], ['b', CLIENT_DOMAIN]] as const) {
      git(root, ['switch', '-c', branch, 'main'])
      await fs.writeFile(path.join(root, 'context', document.relativePath), documentSource({ ...document, body: `${document.body}\nBranch ${branch} addition.\n` }))
      await storeRecord(root, await recordFor(root, document.id))
      git(root, ['add', '.'])
      git(root, ['commit', '-m', `test: independent ${branch}`])
    }
    git(root, ['merge', '--no-edit', 'a'])
    // 合并后两份独立确认都应匹配，无需更新元数据入口。
    const result = await checkConfirmations(root, [SERVICE_GUIDE.id, CLIENT_DOMAIN.id])
    expect(result.items.every(item => item.confirmationState === 'matched')).toBe(true)
    expect(result.store.count).toBe(2)
  })

  it('survives rebase without consulting commit identity', async () => {
    // 当前用例拥有的隔离仓库根目录。
    const root = await repository()
    git(root, ['init', '-b', 'main'])
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'test: base'])
    git(root, ['switch', '-c', 'topic'])
    await fs.appendFile(path.join(root, 'context', SERVICE_GUIDE.relativePath), '\nTopic policy.\n')
    // 绑定完整确认内容与 format 的稳定身份。
    const key = await storeRecord(root, await recordFor(root))
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'test: confirmed topic'])
    // 重放前的 Git 身份；内容确认不应依赖它。
    const previousHead = git(root, ['rev-parse', 'HEAD'])
    git(root, ['switch', 'main'])
    await fs.writeFile(path.join(root, 'unrelated.txt'), 'upstream\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'test: unrelated upstream'])
    git(root, ['switch', 'topic'])
    git(root, ['rebase', 'main'])
    expect(git(root, ['rev-parse', 'HEAD'])).not.toBe(previousHead)
    expect((await checkConfirmations(root, [SERVICE_GUIDE.id])).items).toMatchObject([{ confirmationState: 'matched', matchedKey: key }])
  })

  it('retains both branch records while refusing an unconfirmed combined document', async () => {
    // 具有明确段落边界的文档合并夹具。
    const guide = { ...SERVICE_GUIDE, body: '# Retry\n\nFirst policy.\n\nShared 1.\nShared 2.\nShared 3.\nShared 4.\nShared 5.\n\nSecond policy.\n' }
    // 当前用例拥有的隔离仓库根目录。
    const root = await repository([SERVICE_DOMAIN, guide])
    git(root, ['init', '-b', 'main'])
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'test: base'])
    for (const [branch, from, to] of [['a', 'First policy.', 'First policy A.'], ['b', 'Second policy.', 'Second policy B.']] as const) {
      git(root, ['switch', '-c', branch, 'main'])
      await fs.writeFile(path.join(root, 'context', guide.relativePath), documentSource({ ...guide, body: guide.body.replace(from, to) }))
      await storeRecord(root, await recordFor(root))
      git(root, ['add', '.'])
      git(root, ['commit', '-m', `test: branch ${branch}`])
    }
    git(root, ['merge', '--no-edit', 'a'])
    // 本次操作返回的事实，用于检验完整结果。
    const result = await checkConfirmations(root)
    expect(result.store.count).toBe(2)
    expect(result.items.find(item => item.documentId === guide.id)).toMatchObject({ confirmationState: 'unmatched', documentContentKnown: false })
  })
})

describe('ordinary Git workflow boundaries', () => {
  it('handles real paragraph conflicts and delete/modify without granting confirmation', async () => {
    const root = await repository([SERVICE_DOMAIN, SERVICE_GUIDE])
    git(root, ['init', '-b', 'main'])
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'test: base'])
    for (const branch of ['a', 'b']) {
      git(root, ['switch', '-c', branch, 'main'])
      await fs.writeFile(path.join(root, 'context', SERVICE_GUIDE.relativePath), documentSource({ ...SERVICE_GUIDE, body: `# Retry\n\nPolicy ${branch}.\n` }))
      await storeRecord(root, await recordFor(root))
      git(root, ['add', '.'])
      git(root, ['commit', '-m', `test: ${branch}`])
    }
    expect(() => git(root, ['merge', '--no-edit', 'a'])).toThrow()
    expect((await call(root, 'graph.validate', {})).status).toBe('failed')
    await fs.writeFile(path.join(root, 'context', SERVICE_GUIDE.relativePath), documentSource({ ...SERVICE_GUIDE, body: '# Retry\n\nChosen third policy.\n' }))
    git(root, ['add', 'context'])
    git(root, ['commit', '-m', 'test: resolve text only'])
    expect((await checkConfirmations(root, [SERVICE_GUIDE.id])).items[0]?.confirmationState).toBe('unmatched')
    git(root, ['switch', '-c', 'delete', 'main'])
    git(root, ['rm', 'context/service/manual/retry.md'])
    git(root, ['commit', '-m', 'test: delete'])
    expect(() => git(root, ['merge', '--no-edit', 'a'])).toThrow()
    expect(git(root, ['diff', '--name-only', '--diff-filter=U'])).toContain('retry.md')
  })

  it('keeps confirmation identity through multiple rebased commits, repeated rebase, worktrees and partial staging', async () => {
    const root = await repository()
    git(root, ['init', '-b', 'main'])
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'test: base'])
    git(root, ['switch', '-c', 'topic'])
    for (const number of [1, 2, 3]) {
      await fs.appendFile(path.join(root, 'context', SERVICE_GUIDE.relativePath), `\nPolicy ${number}.\n`)
      await storeRecord(root, await recordFor(root))
      git(root, ['add', '.'])
      git(root, ['commit', '-m', `test: policy ${number}`])
    }
    const before = (await checkConfirmations(root, [SERVICE_GUIDE.id])).items[0]?.currentKey
    git(root, ['switch', 'main'])
    await fs.writeFile(path.join(root, 'upstream.txt'), 'upstream\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'test: upstream'])
    git(root, ['switch', 'topic'])
    git(root, ['rebase', 'main'])
    git(root, ['rebase', 'main'])
    expect((await checkConfirmations(root, [SERVICE_GUIDE.id])).items[0]?.matchedKey).toBe(before)
    // 临时 worktree 置于本测试拥有的根目录中，并显式清理其 Git 注册。
    const worktree = path.join(root, 'linked')
    git(root, ['worktree', 'add', '--detach', worktree, 'HEAD'])
    try {
      expect((await checkConfirmations(worktree, [SERVICE_GUIDE.id])).items[0]?.matchedKey).toBe(before)
      await fs.appendFile(path.join(worktree, 'context', SERVICE_GUIDE.relativePath), '\nStaged content.\n')
      git(worktree, ['add', 'context'])
      await fs.appendFile(path.join(worktree, 'context', SERVICE_GUIDE.relativePath), '\nUnstaged content.\n')
      const index = git(worktree, ['write-tree'])
      expect((await checkConfirmations(worktree, [SERVICE_GUIDE.id])).items[0]?.confirmationState).toBe('unmatched')
      expect(git(worktree, ['write-tree'])).toBe(index)
      expect((await checkConfirmations(root, [SERVICE_GUIDE.id])).items[0]?.matchedKey).toBe(before)
    }
    finally { git(root, ['worktree', 'remove', '--force', worktree]) }
  })

  it('keeps low-frequency baseline conflicts explicit instead of synthesizing approval', async () => {
    const root = await repository()
    git(root, ['init', '-b', 'main'])
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'test: base'])
    for (const branch of ['a', 'b']) {
      git(root, ['switch', '-c', branch, 'main'])
      await fs.writeFile(path.join(root, METADATA_MANIFEST_PATH), serializeMetadataManifest({ format: 1, repository: { baseline: { revision: branch.repeat(40), sourceFingerprint: branch.repeat(64) } } }))
      git(root, ['add', '.'])
      git(root, ['commit', '-m', `test: baseline ${branch}`])
    }
    expect(() => git(root, ['merge', '--no-edit', 'a'])).toThrow()
    expect((await call(root, 'graph.validate', {})).status).toBe('failed')
  })
})
