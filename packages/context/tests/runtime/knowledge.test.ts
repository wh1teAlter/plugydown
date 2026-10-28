import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { afterEach, describe, expect, it } from 'vitest'
import metaSchema from '../../public/schemas/meta.schema.json' with { type: 'json' }
import { parseMeta } from '../../src/runtime/document.js'
import { stableJson } from '../../src/runtime/stable-json.js'
import { call, CLIENT_DOMAIN, createRepository, documentSource, removeRepository, SERVICE_DOMAIN, SERVICE_GUIDE, writeMeta } from './fixture.js'

// 当前测试文件拥有的临时仓库集合，由 afterEach 统一清理。
const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(removeRepository)))

/** 创建并登记由当前测试清理的独立仓库夹具。 */
async function repository(documents = [SERVICE_DOMAIN, SERVICE_GUIDE, CLIENT_DOMAIN]): Promise<string> {
  // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
  const root = await createRepository({ documents })
  roots.push(root)
  return root
}

describe('document, Meta, graph, and fingerprints', () => {
  it('validates both ledger versions through one schema while restricting reviewRequired to v2', () => {
    // 当前公开 Schema 的校验函数。
    const validate = new Ajv2020({ strict: true }).compile(metaSchema)
    for (const [schema, fields, valid] of [
      ['plugydown.context.meta/v1', {}, true],
      ['plugydown.context.meta/v1', { reviewRequired: true }, false],
      ['plugydown.context.meta/v2', {}, true],
      ['plugydown.context.meta/v2', { reviewRequired: true }, true],
      ['plugydown.context.meta/v2', { reviewRequired: false }, false],
      ['plugydown.context.meta/v2', { reviewRequired: 'pending' }, false],
      ['plugydown.context.meta/v2', { unknown: true }, false],
      ['plugydown.context.meta/v3', {}, false],
    ] as const) {
      // 当前文档应保留或新推导的持久记录。
      const ledger = {
        $schema: schema,
        toolVersion: '0.1.0',
        runtimeProtocol: 'plugydown.context.runtime/v1',
        fingerprintVersion: '1',
        documents: {
          service: {
            bodyFingerprint: 'a'.repeat(64),
            frontMatterFingerprint: 'b'.repeat(64),
            sourceFingerprint: 'c'.repeat(64),
            ...fields,
          },
        },
      }
      expect(validate(ledger), JSON.stringify(ledger)).toBe(valid)
      expect(parseMeta('context/.meta/manifest.json', ledger).ok).toBe(valid)
    }
  })

  it('accepts the minimum v1 Document and Meta and reports the complete graph', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository([SERVICE_DOMAIN])
    const response = await call(root, 'graph.validate', {})

    expect(response).toMatchObject({
      status: 'success',
      data: { domainCount: 1, documentCount: 1, relationCount: 0, sourceDeclarationCount: 1 },
    })
  })

  it.each([
    ['unknown Document field', (source: string) => source.replace('kind: domain', 'unknown: true\nkind: domain'), 'DOCUMENT_FIELD_UNKNOWN'],
    ['empty relations', (source: string) => source.replace('---\n# Service', 'relations: {}\n---\n# Service'), 'DOCUMENT_RELATIONS_INVALID'],
    ['empty code.paths', (source: string) => source.replace('  paths:\n    - "src/service.ts"', '  paths: []'), 'DOCUMENT_CODE_PATHS_INVALID'],
    ['empty body', (source: string) => source.replace(/---\n# Service[\s\S]*$/, '---\n'), 'DOCUMENT_BODY_EMPTY'],
  ])('rejects %s', async (_name, mutate, code) => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository([SERVICE_DOMAIN])
    // 当前受检文件的实际路径，仅用于内部读写操作。
    const file = path.join(root, 'context/service/domain.md')
    await fs.writeFile(file, mutate(await fs.readFile(file, 'utf8')))
    const response = await call(root, 'graph.validate', {})

    expect(response.status).toBe('failed')
    expect(response.diagnostics?.some(item => item.code === code)).toBe(true)
  })

  it.each([
    [{ ...SERVICE_DOMAIN, relativePath: 'other/domain.md' }, 'DOCUMENT_DOMAIN_MISMATCH'],
    [{ ...SERVICE_DOMAIN, kind: 'guide' as const }, 'DOCUMENT_PLACEMENT_INVALID'],
    [{ ...SERVICE_GUIDE, id: 'other.retry' }, 'DOCUMENT_ID_DOMAIN_MISMATCH'],
    [{ ...SERVICE_GUIDE, relativePath: 'service/manual/Retry.md' }, 'DOCUMENT_FILENAME_INVALID'],
  ])('rejects physical Domain, kind, ID, or filename mismatch %#', async (document, code) => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository([document])
    const response = await call(root, 'graph.validate', {})

    expect(response.status).toBe('failed')
    expect(response.diagnostics?.some(item => item.code === code)).toBe(true)
  })

  it('rejects duplicate IDs, self/dangling relations, and requires cycles', async () => {
    // 故意复用文档 ID 的第二份物理文件夹具。
    const duplicate = { ...SERVICE_GUIDE, relativePath: 'service/manual/duplicate.md' }
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository([SERVICE_DOMAIN, SERVICE_GUIDE, duplicate])
    expect((await call(root, 'graph.validate', {})).diagnostics?.some(item => item.code === 'DOCUMENT_ID_DUPLICATE')).toBe(true)

    // 含自引用关系的无效文档夹具。
    const self = { ...SERVICE_GUIDE, relations: { requires: ['service.retry'] } }
    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const selfRoot = await repository([SERVICE_DOMAIN, self])
    const selfResponse = await call(selfRoot, 'graph.validate', {})
    expect(selfResponse.diagnostics?.some(item => item.code === 'DOCUMENT_RELATION_SELF')).toBe(true)

    // 引用不存在文档的无效关系夹具。
    const dangling = { ...SERVICE_GUIDE, relations: { requires: ['missing.document'] } }
    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const danglingRoot = await repository([SERVICE_DOMAIN, dangling])
    expect((await call(danglingRoot, 'graph.validate', {})).diagnostics?.some(item => item.code === 'DOCUMENT_RELATION_DANGLING')).toBe(true)

    const first = { ...SERVICE_GUIDE, relations: { requires: ['service.second'] } }
    const second = { ...SERVICE_GUIDE, id: 'service.second', relativePath: 'service/manual/second.md', relations: { requires: ['service.retry'] } }
    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const cycleRoot = await repository([SERVICE_DOMAIN, first, second])
    expect((await call(cycleRoot, 'graph.validate', {})).diagnostics?.some(item => item.code === 'DOCUMENT_REQUIRES_CYCLE')).toBe(true)
  })

  it('normalizes front matter key/list order and body BOM/CRLF without changing validity', async () => {
    // 关系选择器指向的目标文档集合。
    const related = {
      ...SERVICE_GUIDE,
      relations: { requires: ['service'], related: ['client'] },
    }
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository([SERVICE_DOMAIN, related, CLIENT_DOMAIN])
    // 当前受检文件的实际路径，仅用于内部读写操作。
    const file = path.join(root, 'context/service/manual/retry.md')
    // 只改变 front matter 顺序、换行和空白的等价文档原文。
    const reordered = [
      '\uFEFF---',
      'domain: service',
      'kind: guide',
      'description: "Retry behavior and constraints."',
      'id: service.retry',
      'schema: plugydown.context.document/v1',
      'code:',
      '  paths:',
      '    - src/retry.ts',
      'relations:',
      '  related:',
      '    - client',
      '  requires:',
      '    - service',
      '---',
      '# Retry   ',
      '',
      'Retry only transient failures.   ',
      '',
    ].join('\r\n')
    await fs.writeFile(file, reordered)

    expect((await call(root, 'graph.validate', {})).status).toBe('success')
  })

  it('keeps content fingerprints stable across a path move while Context fingerprint changes', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    const before = await call(root, 'repository.inspect', { selectedDocumentIds: ['service.retry'] })
    await fs.rename(path.join(root, 'context/service/manual/retry.md'), path.join(root, 'context/service/manual/retry-policy.md'))
    const after = await call(root, 'repository.inspect', { selectedDocumentIds: ['service.retry'] })

    expect(before.data?.context).not.toEqual(after.data?.context)
    expect((before.data?.selected as any[])[0].currentKey).toEqual((after.data?.selected as any[])[0].currentKey)
    expect((await call(root, 'graph.validate', {})).status).toBe('success')
  })

  it('derives content mismatch without structural damage or a current ledger', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository()
    // 当前受检文件的实际路径，仅用于内部读写操作。
    const file = path.join(root, 'context/service/manual/retry.md')
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('Retry behavior', 'Changed retry behavior'))
    expect((await call(root, 'confirmation.check', {})).data?.summary).toMatchObject({ unmatched: 1 })

    await fs.writeFile(file, documentSource(SERVICE_GUIDE))
    await fs.rm(path.join(root, 'context/.meta/confirmations/service.retry'), { recursive: true })
    expect((await call(root, 'graph.validate', {})).status).toBe('success')
    expect((await call(root, 'confirmation.check', {})).data?.summary).toMatchObject({ unmatched: 1 })
  })

  it('changes source fingerprints when the declaration, file set, relative path, or raw bytes changes', async () => {
    // 使用通配源码声明的文档夹具。
    const globDocument = { ...SERVICE_DOMAIN, codePaths: ['src/*.ts'] }
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository([globDocument])
    /** 读取选中文档的状态快照，供指纹变化断言使用。 */
    const selected = async () => (await call(root, 'repository.inspect', { selectedDocumentIds: ['service'] })).data?.selected
    const initial = await selected()

    await fs.writeFile(path.join(root, 'src/new.ts'), 'same\n')
    const fileSet = await selected()
    expect(fileSet).not.toEqual(initial)

    await writeMeta(root, [globDocument])
    const fresh = await selected()
    await fs.writeFile(path.join(root, 'src/service.ts'), 'changed bytes\n')
    expect(await selected()).not.toEqual(fresh)

    await fs.rename(path.join(root, 'src/new.ts'), path.join(root, 'src/moved.ts'))
    expect((await call(root, 'repository.inspect', { selectedDocumentIds: ['service'] })).data?.selected).not.toEqual(fresh)

    // 使用精确源码路径声明的文档夹具。
    const exact = { ...SERVICE_DOMAIN, codePaths: ['src/client.ts'] }
    await fs.writeFile(path.join(root, 'context/service/domain.md'), documentSource(exact))
    expect((await call(root, 'confirmation.check', {})).data?.summary).toMatchObject({ unmatched: 1 })
  })

  it('reports source staleness as pending review without failing graph validation', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository([SERVICE_DOMAIN])
    await fs.writeFile(path.join(root, 'src/service.ts'), 'changed source bytes\n')

    const inspect = await call(root, 'repository.inspect', { selectedDocumentIds: ['service'] })
    expect(inspect).toMatchObject({
      status: 'success',
      data: { context: { state: 'ready', sourceState: 'ready' }, selected: [{ documentId: 'service', confirmationState: 'unmatched' }] },
    })
    expect(await call(root, 'graph.validate', {})).toMatchObject({
      status: 'success',
      data: { documentCount: 1 },
    })
  })

  it('rejects Meta unknown fields and persisted derived status', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository([SERVICE_DOMAIN])
    // 当前测试拥有的正式 meta.json 路径。
    const metaPath = path.join(root, 'context/.meta/manifest.json')
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'))
    meta.status = 'fresh'
    meta.session = {}
    await fs.writeFile(metaPath, stableJson(meta))
    const response = await call(root, 'graph.validate', {})

    expect(response.status).toBe('failed')
    expect(response.diagnostics?.some(item => item.code === 'METADATA_INVALID')).toBe(true)
  })

  it('rejects whitespace-only descriptions and non-canonical repository revisions', async () => {
    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const descriptionRoot = await repository([SERVICE_DOMAIN])
    // 当前测试受检的正式 Markdown 文件路径。
    const documentPath = path.join(descriptionRoot, 'context/service/domain.md')
    await fs.writeFile(documentPath, (await fs.readFile(documentPath, 'utf8')).replace('description: "Service Domain boundaries and navigation."', 'description: "   "'))
    expect((await call(descriptionRoot, 'graph.validate', {})).diagnostics?.some(item => item.code === 'DOCUMENT_DESCRIPTION_INVALID')).toBe(true)

    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const revisionRoot = await repository([SERVICE_DOMAIN])
    // 当前测试拥有的正式 meta.json 路径。
    const metaPath = path.join(revisionRoot, 'context/.meta/manifest.json')
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'))
    meta.repository = { baseline: { revision: 'A'.repeat(40), sourceFingerprint: '0'.repeat(64) } }
    await fs.writeFile(metaPath, stableJson(meta))
    expect((await call(revisionRoot, 'graph.validate', {})).diagnostics?.some(item => item.code === 'META_REPOSITORY_INVALID')).toBe(true)
  })

  it('bounds diagnostics to the first 99 sorted facts plus one omission record', async () => {
    // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
    const root = await repository([SERVICE_DOMAIN])
    await Promise.all(Array.from({ length: 110 }, async (_, index) => {
      await fs.writeFile(path.join(root, 'context', `invalid-${String(index).padStart(3, '0')}.txt`), 'invalid\n')
    }))
    const response = await call(root, 'graph.validate', {})

    expect(response.status).toBe('failed')
    expect(response.diagnostics).toHaveLength(100)
    expect(response.diagnostics?.at(-1)).toEqual(expect.objectContaining({ code: 'DIAGNOSTICS_OMITTED', severity: 'warning' }))
    expect(response.diagnostics?.every(item => item.message.length <= 512 && (item.path?.length ?? 0) <= 1024)).toBe(true)
  })

  it('treats a Context root or Meta symlink as invalid instead of absent', async () => {
    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const contextRoot = await repository([SERVICE_DOMAIN])
    await fs.rename(path.join(contextRoot, 'context'), path.join(contextRoot, 'actual-context'))
    await fs.symlink('actual-context', path.join(contextRoot, 'context'))
    const contextResult = await call(contextRoot, 'repository.inspect', {})
    expect(contextResult.data?.context).toMatchObject({ state: 'invalid' })

    // 当前故障场景独占的临时仓库，由测试清理钩子回收。
    const metaRoot = await repository([SERVICE_DOMAIN])
    await fs.rename(path.join(metaRoot, 'context/.meta/manifest.json'), path.join(metaRoot, 'meta-real.json'))
    await fs.symlink('../../meta-real.json', path.join(metaRoot, 'context/.meta/manifest.json'))
    const metaResult = await call(metaRoot, 'graph.validate', {})
    expect(metaResult.status).toBe('failed')
    expect(metaResult.diagnostics?.some(item => item.code === 'PATH_SYMLINK')).toBe(true)
  })
})
