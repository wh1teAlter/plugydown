import { Buffer } from 'node:buffer'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_JSON_TEXT_BYTES, MAX_SOURCE_BYTES, MAX_SOURCE_FILES } from '../../src/runtime/repository.js'
import { call, createRepository, documentSource, removeRepository, SERVICE_DOMAIN, SERVICE_GUIDE, writeMeta } from './fixture.js'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(removeRepository))
})

async function repository(document = SERVICE_DOMAIN): Promise<string> {
  const root = await createRepository({ documents: [SERVICE_DOMAIN] })
  roots.push(root)
  await fs.writeFile(path.join(root, 'context/service/domain.md'), documentSource(document))
  await writeMeta(root, [document])
  return root
}

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
    const document = { ...SERVICE_DOMAIN, codePaths: [codePath] }
    const root = await repository()
    await fs.writeFile(path.join(root, 'context/service/domain.md'), documentSource(document))

    const response = await validate(root)
    expect(response.status).toBe('failed')
    expect(response.diagnostics?.some(item => item.code === 'DOCUMENT_CODE_PATH_UNSAFE')).toBe(true)
  })

  it.each([
    ['src/missing.ts', 'SOURCE_EXACT_MISSING'],
    ['src/*.missing', 'SOURCE_GLOB_ZERO_MATCH'],
    ['src', 'SOURCE_NOT_REGULAR_FILE'],
  ])('rejects missing or non-file source declaration %s', async (codePath, code) => {
    const root = await repository({ ...SERVICE_DOMAIN, codePaths: [codePath] })
    const response = await validate(root)

    expect(response.status).toBe('failed')
    expect(response.diagnostics?.some(item => item.code === code)).toBe(true)
  })

  it('does not give directories implicit recursive semantics', async () => {
    const document = { ...SERVICE_DOMAIN, codePaths: ['src/*.ts'] }
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
    const directRoot = await repository({ ...SERVICE_DOMAIN, codePaths: ['src/link.ts'] })
    await fs.symlink(path.join(directRoot, 'src/service.ts'), path.join(directRoot, 'src/link.ts'))
    const direct = await validate(directRoot)
    expect(direct.status).toBe('failed')
    expect(direct.diagnostics?.some(item => item.code === 'PATH_SYMLINK')).toBe(true)

    const parentRoot = await repository({ ...SERVICE_DOMAIN, codePaths: ['linked/service.ts'] })
    await fs.symlink(path.join(parentRoot, 'src'), path.join(parentRoot, 'linked'))
    const parent = await validate(parentRoot)
    expect(parent.status).toBe('failed')
    expect(parent.diagnostics?.some(item => item.code === 'PATH_SYMLINK')).toBe(true)
  })

  it('rejects a special source file', async () => {
    const root = await repository({ ...SERVICE_DOMAIN, codePaths: ['src/runtime.sock'] })
    const socket = path.join(root, 'src/runtime.sock')
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
    const invalidRoot = await repository()
    await fs.writeFile(path.join(invalidRoot, 'context/service/domain.md'), Buffer.from([0xFF, 0xFE]))
    const invalid = await validate(invalidRoot)
    expect(invalid.status).toBe('failed')
    expect(invalid.diagnostics?.some(item => item.code === 'FILE_ENCODING_INVALID')).toBe(true)

    const validRoot = await repository()
    const source = `\uFEFF${documentSource(SERVICE_DOMAIN, '\r\n')}`
    await fs.writeFile(path.join(validRoot, 'context/service/domain.md'), source)
    const stale = await validate(validRoot)
    expect(stale.status).toBe('success')
  })

  it('enforces Markdown, front matter, Meta, and Git evidence size limits before partial results', async () => {
    const markdownRoot = await repository()
    await fs.writeFile(path.join(markdownRoot, 'context/service/domain.md'), documentSource({ ...SERVICE_DOMAIN, body: `# Big\n${'x'.repeat(1024 * 1024)}` }))
    expect((await validate(markdownRoot)).diagnostics?.some(item => item.code === 'FILE_SIZE_EXCEEDED')).toBe(true)

    const frontMatterRoot = await repository()
    const oversized = documentSource({ ...SERVICE_DOMAIN, description: 'x'.repeat(65 * 1024) })
    await fs.writeFile(path.join(frontMatterRoot, 'context/service/domain.md'), oversized)
    expect((await validate(frontMatterRoot)).diagnostics?.some(item => item.code === 'DOCUMENT_FRONT_MATTER_SIZE_EXCEEDED')).toBe(true)

    const metaRoot = await repository()
    await fs.truncate(path.join(metaRoot, 'context/meta.json'), 4 * 1024 * 1024 + 1)
    expect((await validate(metaRoot)).diagnostics?.some(item => item.code === 'FILE_SIZE_EXCEEDED')).toBe(true)

    const evidenceRoot = await repository()
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
    const knownRoot = await repository()
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('private machine detail'), { code: 'EIO' }))
    const known = await validate(knownRoot)
    expect(known).toMatchObject({ status: 'failed' })
    expect(known.diagnostics?.some(item => item.code === 'REPOSITORY_IO_FAILED')).toBe(true)
    expect(JSON.stringify(known)).not.toContain('private machine detail')
    vi.restoreAllMocks()

    const unknownRoot = await repository()
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('unexpected filesystem failure'), { code: 'EUNKNOWN' }))
    await expect(validate(unknownRoot)).rejects.toThrow('unexpected filesystem failure')
  })

  it('enforces source aggregate byte and file-count limits without a partial fingerprint', async () => {
    const byteRoot = await repository({ ...SERVICE_DOMAIN, codePaths: ['large/blob.bin'] })
    await fs.mkdir(path.join(byteRoot, 'large'))
    await fs.writeFile(path.join(byteRoot, 'large/blob.bin'), '')
    await fs.truncate(path.join(byteRoot, 'large/blob.bin'), MAX_SOURCE_BYTES + 1)
    const bytes = await validate(byteRoot)
    expect(bytes.status).toBe('failed')
    expect(bytes.data).toBeUndefined()
    expect(bytes.diagnostics?.some(item => item.code === 'SOURCE_BYTE_LIMIT_EXCEEDED')).toBe(true)

    const countRoot = await createRepository({ documents: [
      { ...SERVICE_DOMAIN, codePaths: ['bulk-a/**'] },
      { ...SERVICE_GUIDE, codePaths: ['bulk-b/**'] },
    ] })
    roots.push(countRoot)
    await fs.mkdir(path.join(countRoot, 'bulk-a'))
    await fs.mkdir(path.join(countRoot, 'bulk-b'))
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
    const root = await repository()
    const long = 'e'.repeat(1_100)

    // The 1024-character ceiling is enforced at the request boundary for evidence paths and
    // inside path lexing for declarations; either way the value must never come back out.
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
    const root = await repository()
    await fs.writeFile(path.join(root, 'context/service/filler.md'), '')
    await fs.truncate(path.join(root, 'context/service/filler.md'), MAX_JSON_TEXT_BYTES + 1)

    const response = await validate(root)

    expect(response.status).toBe('failed')
    expect(response.data).toBeUndefined()
    expect(response.diagnostics?.some(item => item.code === 'FILE_SIZE_EXCEEDED')).toBe(true)
  })
})
