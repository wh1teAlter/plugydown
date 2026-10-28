import { Buffer } from 'node:buffer'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_JSON_TEXT_BYTES, MAX_SOURCE_BYTES, MAX_SOURCE_FILES } from '../../src/runtime/repository.js'
import { call, createRepository, documentSource, removeRepository, SERVICE_DOMAIN, SERVICE_GUIDE, writeMeta } from './fixture.js'

// 当前测试文件拥有的临时仓库集合，由 afterEach 统一清理。
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(removeRepository))
})

/** 创建并登记由当前测试清理的独立仓库夹具。 */
async function repository(document = SERVICE_DOMAIN): Promise<string> {
  // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
  const root = await createRepository({ documents: [SERVICE_DOMAIN] })
  roots.push(root)
  await fs.writeFile(path.join(root, 'context/service/domain.md'), documentSource(document))
  await writeMeta(root, [document])
  return root
}

/** 通过 Runtime 检查当前路径安全测试夹具的知识树。 */
async function validate(root: string) {
  return call(root, 'graph.validate', {})
}

describe('repository safety', () => {
  it.each([
    '/absolute/file.ts',
    'C:\\absolute\\file.ts',
    'src\\file.ts',
    'src/../file.ts',
    'src/./file.ts',
    'src/$' + '{HOME}.ts',
    'src/~user.ts',
    'src/control\u0001.ts',
    '*.ts',
    '**/*.ts',
    'src/**/nested/**',
    'src/file?.ts',
    '.git/config',
    '.scratch/input.md',
    'context/service/domain.md',
    'src/node_modules/pkg.ts',
    `src/${'x'.repeat(1_021)}`,
  ])('rejects unsafe code.paths pattern %s', async (codePath) => {
    // 当前通过 ID 找到的文档，作为本次判断的依据。
    const document = { ...SERVICE_DOMAIN, codePaths: [codePath] }
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    await fs.writeFile(path.join(root, 'context/service/domain.md'), documentSource(document))

    const response = await validate(root)
    expect(response.status).toBe('failed')
    expect(response.diagnostics?.some(item => item.code === 'DOCUMENT_CODE_PATH_UNSAFE')).toBe(true)
  })

  it.each([
    'packages/context/src/runtime.ts',
    'packages/context/**',
    'tools/.scratch/build.ts',
  ])('accepts a reserved name below the repository root: %s', async (codePath) => {
    // 当前通过 ID 找到的文档，作为本次判断的依据。
    const document = { ...SERVICE_DOMAIN, codePaths: [codePath] }
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository(document)
    await fs.mkdir(path.join(root, 'packages/context/src'), { recursive: true })
    await fs.writeFile(path.join(root, 'packages/context/src/runtime.ts'), 'runtime\n')
    await fs.mkdir(path.join(root, 'tools/.scratch'), { recursive: true })
    await fs.writeFile(path.join(root, 'tools/.scratch/build.ts'), 'build\n')
    await writeMeta(root, [document])

    expect((await validate(root)).status).toBe('success')
  })

  it('expands a package glob in a pnpm-style monorepo without opening unrelated siblings', async () => {
    // 当前通过 ID 找到的文档，作为本次判断的依据。
    const document = { ...SERVICE_DOMAIN, codePaths: ['packages/foo/src/**', 'packages/foo/**'] }
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository(document)
    await fs.mkdir(path.join(root, 'packages/foo/src'), { recursive: true })
    await fs.writeFile(path.join(root, 'packages/foo/src/a.ts'), 'a\n')
    // pnpm 在 node_modules 内建立工作区链接，但本次 glob 不应访问它们。
    await fs.mkdir(path.join(root, 'packages/bar/node_modules'), { recursive: true })
    await fs.symlink(path.join(root, 'packages/foo'), path.join(root, 'packages/bar/node_modules/foo'))
    // 双星号也不能进入 node_modules，包括其中实际存在的链接目录。
    await fs.mkdir(path.join(root, 'packages/foo/node_modules/dep'), { recursive: true })
    await fs.writeFile(path.join(root, 'packages/foo/node_modules/dep/index.js'), 'dep\n')
    await fs.symlink(path.join(root, 'packages/bar'), path.join(root, 'packages/foo/node_modules/bar'))
    // 模式无法命中的兄弟目录不应被列出，因此其不可读状态不影响结果。
    const unrelated = path.join(root, 'packages/bar/build')
    await fs.mkdir(unrelated)
    await fs.chmod(unrelated, 0o000)
    await writeMeta(root, [document])

    try {
      const response = await validate(root)
      expect(response.status).toBe('success')
      expect(response.diagnostics ?? []).toEqual([])
    }
    finally {
      await fs.chmod(unrelated, 0o755)
    }
  })

  it.each([
    ['refuses a symlink the glob would select', 'packages/foo/src/*.ts', 'packages/foo/src/link.ts', 'failed'],
    ['refuses a symlink the glob must descend through', 'packages/foo/**/*.ts', 'packages/foo/src/lib', 'failed'],
    ['leaves unopened a symlink the glob can never reach', 'packages/foo/src/*.ts', 'packages/foo/src/notes', 'success'],
  ] as const)('%s', async (_, pattern, linkPath, status) => {
    // 当前通过 ID 找到的文档，作为本次判断的依据。
    const document = { ...SERVICE_DOMAIN, codePaths: [pattern] }
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository(document)
    await fs.mkdir(path.join(root, 'packages/foo/src'), { recursive: true })
    await fs.writeFile(path.join(root, 'packages/foo/src/a.ts'), 'a\n')
    await fs.symlink(path.join(root, 'packages/foo'), path.join(root, linkPath))
    await writeMeta(root, [document])

    const response = await validate(root)
    expect(response.status).toBe(status)
    expect(response.diagnostics?.some(item => item.code === 'PATH_SYMLINK') ?? false).toBe(status === 'failed')
  })

  it.each([
    ['src/missing.ts', 'SOURCE_EXACT_MISSING'],
    ['src/*.missing', 'SOURCE_GLOB_ZERO_MATCH'],
    ['src', 'SOURCE_NOT_REGULAR_FILE'],
  ])('rejects missing or non-file source declaration %s', async (codePath, code) => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository({ ...SERVICE_DOMAIN, codePaths: [codePath] })
    const response = await validate(root)

    expect(response.status).toBe('failed')
    expect(response.diagnostics?.some(item => item.code === code)).toBe(true)
  })

  it('does not give directories implicit recursive semantics', async () => {
    // 当前通过 ID 找到的文档，作为本次判断的依据。
    const document = { ...SERVICE_DOMAIN, codePaths: ['src/*.ts'] }
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository(document)
    await writeMeta(root, [document])
    await fs.mkdir(path.join(root, 'src/nested'))
    await fs.writeFile(path.join(root, 'src/nested/deep.ts'), 'deep\n')

    expect((await validate(root)).status).toBe('success')

    await fs.rm(path.join(root, 'src/service.ts'))
    await fs.rm(path.join(root, 'src/retry.ts'))
    await fs.rm(path.join(root, 'src/client.ts'))
    const response = await validate(root)
    expect(response.status).toBe('failed')
    expect(response.diagnostics?.some(item => item.code === 'SOURCE_GLOB_ZERO_MATCH')).toBe(true)
  })

  it('rejects a symlink file and a symlink parent without following either', async () => {
    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const directRoot = await repository({ ...SERVICE_DOMAIN, codePaths: ['src/link.ts'] })
    await fs.symlink(path.join(directRoot, 'src/service.ts'), path.join(directRoot, 'src/link.ts'))
    const direct = await validate(directRoot)
    expect(direct.status).toBe('failed')
    expect(direct.diagnostics?.some(item => item.code === 'PATH_SYMLINK')).toBe(true)

    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const parentRoot = await repository({ ...SERVICE_DOMAIN, codePaths: ['linked/service.ts'] })
    await fs.symlink(path.join(parentRoot, 'src'), path.join(parentRoot, 'linked'))
    const parent = await validate(parentRoot)
    expect(parent.status).toBe('failed')
    expect(parent.diagnostics?.some(item => item.code === 'PATH_SYMLINK')).toBe(true)
  })

  it('rejects a special source file', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository({ ...SERVICE_DOMAIN, codePaths: ['src/runtime.sock'] })
    // 用于验证特殊文件拒绝逻辑的 Unix socket 路径。
    const socket = path.join(root, 'src/runtime.sock')
    // 测试独占的 socket 服务，结束时必须关闭。
    const server = net.createServer()
    await new Promise<void>((resolve, reject) => server.listen(socket, resolve).once('error', reject))
    try {
      const response = await validate(root)
      expect(response.status).toBe('failed')
      expect(response.diagnostics?.some(item => item.code === 'SOURCE_NOT_REGULAR_FILE')).toBe(true)
    }
    finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('rejects invalid UTF-8 Markdown and accepts BOM plus CRLF', async () => {
    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const invalidRoot = await repository()
    await fs.writeFile(path.join(invalidRoot, 'context/service/domain.md'), Buffer.from([0xFF, 0xFE]))
    const invalid = await validate(invalidRoot)
    expect(invalid.status).toBe('failed')
    expect(invalid.diagnostics?.some(item => item.code === 'FILE_ENCODING_INVALID')).toBe(true)

    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const validRoot = await repository()
    // 当前安全读取或待生成的资源文本。
    const source = `\uFEFF${documentSource(SERVICE_DOMAIN, '\r\n')}`
    await fs.writeFile(path.join(validRoot, 'context/service/domain.md'), source)
    const stale = await validate(validRoot)
    expect(stale.status).toBe('success')
  })

  it('enforces Markdown, front matter, Meta, and Git evidence size limits before partial results', async () => {
    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const markdownRoot = await repository()
    await fs.writeFile(path.join(markdownRoot, 'context/service/domain.md'), documentSource({ ...SERVICE_DOMAIN, body: `# Big\n${'x'.repeat(1024 * 1024)}` }))
    expect((await validate(markdownRoot)).diagnostics?.some(item => item.code === 'FILE_SIZE_EXCEEDED')).toBe(true)

    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const frontMatterRoot = await repository()
    // 故意超出 front matter 字节限制的 Markdown 原文。
    const oversized = documentSource({ ...SERVICE_DOMAIN, description: 'x'.repeat(65 * 1024) })
    await fs.writeFile(path.join(frontMatterRoot, 'context/service/domain.md'), oversized)
    expect((await validate(frontMatterRoot)).diagnostics?.some(item => item.code === 'DOCUMENT_FRONT_MATTER_SIZE_EXCEEDED')).toBe(true)

    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const metaRoot = await repository()
    await fs.truncate(path.join(metaRoot, 'context/meta.json'), 4 * 1024 * 1024 + 1)
    expect((await validate(metaRoot)).diagnostics?.some(item => item.code === 'FILE_SIZE_EXCEEDED')).toBe(true)

    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const evidenceRoot = await repository()
    // 当前工作流拥有的宿主 Git 证据叶子或已校验快照。
    const evidence = '.scratch/evidence/large'
    await fs.mkdir(path.join(evidenceRoot, evidence), { recursive: true })
    await fs.writeFile(path.join(evidenceRoot, evidence, 'head.txt'), `${'a'.repeat(40)}\n`)
    await fs.writeFile(path.join(evidenceRoot, evidence, 'mid-operation.json'), '{"active":false}')
    await fs.writeFile(path.join(evidenceRoot, evidence, 'status.bin'), '')
    await fs.truncate(path.join(evidenceRoot, evidence, 'status.bin'), 16 * 1024 * 1024 + 1)
    const delta = await call(evidenceRoot, 'delta.compute', {
      gitEvidencePath: evidence,
      scope: { kind: 'repository' },
      taskEvidence: { intentKnown: true, scopeComplete: true, newCapabilitySuspected: false, crossDomainContractUncertain: false },
    })
    expect(delta.status).toBe('failed')
    expect(delta.diagnostics?.some(item => item.code === 'FILE_SIZE_EXCEEDED')).toBe(true)
  })

  it('accepts only one normalized evidence leaf directly under .scratch/evidence', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    const response = await call(root, 'delta.compute', {
      gitEvidencePath: '.scratch/evidence/request/nested',
      scope: { kind: 'repository' },
      taskEvidence: { intentKnown: true, scopeComplete: true, newCapabilitySuspected: false, crossDomainContractUncertain: false },
    })

    expect(response.status).toBe('failed')
    expect(response.diagnostics?.[0]?.code).toBe('GIT_EVIDENCE_PATH_INVALID')
  })

  it('maps only known filesystem errno values and lets unknown failures reach the transport boundary', async () => {
    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const knownRoot = await repository()
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('private machine detail'), { code: 'EIO' }))
    const known = await validate(knownRoot)
    expect(known).toMatchObject({ status: 'failed' })
    expect(known.diagnostics?.some(item => item.code === 'REPOSITORY_IO_FAILED')).toBe(true)
    expect(JSON.stringify(known)).not.toContain('private machine detail')
    vi.restoreAllMocks()

    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const unknownRoot = await repository()
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('unexpected filesystem failure'), { code: 'EUNKNOWN' }))
    await expect(validate(unknownRoot)).rejects.toThrow('unexpected filesystem failure')
  })

  it('enforces source aggregate byte and file-count limits without a partial fingerprint', async () => {
    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const byteRoot = await repository({ ...SERVICE_DOMAIN, codePaths: ['large/blob.bin'] })
    await fs.mkdir(path.join(byteRoot, 'large'))
    await fs.writeFile(path.join(byteRoot, 'large/blob.bin'), '')
    await fs.truncate(path.join(byteRoot, 'large/blob.bin'), MAX_SOURCE_BYTES + 1)
    const bytes = await validate(byteRoot)
    expect(bytes.status).toBe('failed')
    expect(bytes.data).toBeUndefined()
    expect(bytes.diagnostics?.some(item => item.code === 'SOURCE_BYTE_LIMIT_EXCEEDED')).toBe(true)

    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const countRoot = await createRepository({ documents: [
      { ...SERVICE_DOMAIN, codePaths: ['bulk-a/**'] },
      { ...SERVICE_GUIDE, codePaths: ['bulk-b/**'] },
    ] })
    roots.push(countRoot)
    await fs.mkdir(path.join(countRoot, 'bulk-a'))
    await fs.mkdir(path.join(countRoot, 'bulk-b'))
    // 让单份文档不过限但全局展开超限的文件数量。
    const perDocument = Math.floor(MAX_SOURCE_FILES / 2) + 1
    await Promise.all(Array.from({ length: perDocument }, async (_, index) => {
      await Promise.all([
        fs.writeFile(path.join(countRoot, `bulk-a/${index}.txt`), ''),
        fs.writeFile(path.join(countRoot, `bulk-b/${index}.txt`), ''),
      ])
    }))
    const count = await validate(countRoot)
    expect(count.status).toBe('failed')
    expect(count.data).toBeUndefined()
    expect(count.diagnostics?.some(item => item.code === 'SOURCE_FILE_LIMIT_EXCEEDED')).toBe(true)
  }, 30_000)

  it('rejects an over-long repository path before touching the filesystem, without echoing it', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    // 故意超过路径字符上限的测试输入。
    const long = 'e'.repeat(1_100)

    // 证据路径在请求入口限制为 1024 字符，源码声明在词法校验时限制；非法路径都不得回显。
    const evidencePath = await call(root, 'delta.compute', {
      gitEvidencePath: `.scratch/evidence/${long}`,
      scope: { kind: 'repository' },
      taskEvidence: { intentKnown: true, scopeComplete: true, newCapabilitySuspected: false, crossDomainContractUncertain: false },
    })
    expect(evidencePath.status).toBe('failed')
    expect(evidencePath.diagnostics?.[0]?.code).toBe('REQUEST_FIELD_INVALID')
    expect(JSON.stringify(evidencePath)).not.toContain('e'.repeat(64))

    const declared = await call(root, 'frontier.query', { depth: 2, selectors: { codePaths: [`src/${long}.ts`] } })
    expect(declared.status).toBe('failed')
    expect(declared.diagnostics?.[0]?.code).toBe('PATH_LENGTH_EXCEEDED')
    expect(JSON.stringify(declared)).not.toContain('e'.repeat(64))
  })

  it('enforces the per-file formal Markdown ceiling before any tree aggregate', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    await fs.writeFile(path.join(root, 'context/service/filler.md'), '')
    await fs.truncate(path.join(root, 'context/service/filler.md'), MAX_JSON_TEXT_BYTES + 1)

    const response = await validate(root)

    expect(response.status).toBe('failed')
    expect(response.data).toBeUndefined()
    expect(response.diagnostics?.some(item => item.code === 'FILE_SIZE_EXCEEDED')).toBe(true)
  })
})
