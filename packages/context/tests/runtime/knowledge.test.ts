import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { call, CLIENT_DOMAIN, createRepository, documentSource, removeRepository, SERVICE_DOMAIN, SERVICE_GUIDE, writeMeta } from './fixture.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(removeRepository)))

async function repository(documents = [SERVICE_DOMAIN, SERVICE_GUIDE, CLIENT_DOMAIN]): Promise<string> {
  const root = await createRepository({ documents })
  roots.push(root)
  return root
}

describe('document, Meta, graph, and fingerprints', () => {
  it('accepts the minimum v1 Document and Meta and reports the complete graph', async () => {
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
    const root = await repository([SERVICE_DOMAIN])
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
    const root = await repository([document])
    const response = await call(root, 'graph.validate', {})

    expect(response.status).toBe('failed')
    expect(response.diagnostics?.some(item => item.code === code)).toBe(true)
  })

  it('rejects duplicate IDs, self/dangling relations, and requires cycles', async () => {
    const duplicate = { ...SERVICE_GUIDE, relativePath: 'service/manual/duplicate.md' }
    const root = await repository([SERVICE_DOMAIN, SERVICE_GUIDE, duplicate])
    expect((await call(root, 'graph.validate', {})).diagnostics?.some(item => item.code === 'DOCUMENT_ID_DUPLICATE')).toBe(true)

    const self = { ...SERVICE_GUIDE, relations: { requires: ['service.retry'] } }
    const selfRoot = await repository([SERVICE_DOMAIN, self])
    const selfResponse = await call(selfRoot, 'graph.validate', {})
    expect(selfResponse.diagnostics?.some(item => item.code === 'DOCUMENT_RELATION_SELF')).toBe(true)

    const dangling = { ...SERVICE_GUIDE, relations: { requires: ['missing.document'] } }
    const danglingRoot = await repository([SERVICE_DOMAIN, dangling])
    expect((await call(danglingRoot, 'graph.validate', {})).diagnostics?.some(item => item.code === 'DOCUMENT_RELATION_DANGLING')).toBe(true)

    const first = { ...SERVICE_GUIDE, relations: { requires: ['service.second'] } }
    const second = { ...SERVICE_GUIDE, id: 'service.second', relativePath: 'service/manual/second.md', relations: { requires: ['service.retry'] } }
    const cycleRoot = await repository([SERVICE_DOMAIN, first, second])
    expect((await call(cycleRoot, 'graph.validate', {})).diagnostics?.some(item => item.code === 'DOCUMENT_REQUIRES_CYCLE')).toBe(true)
  })

  it('normalizes front matter key/list order and body BOM/CRLF without changing validity', async () => {
    const related = {
      ...SERVICE_GUIDE,
      relations: { requires: ['service'], related: ['client'] },
    }
    const root = await repository([SERVICE_DOMAIN, related, CLIENT_DOMAIN])
    const file = path.join(root, 'context/service/manual/retry.md')
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
    const root = await repository()
    const before = await call(root, 'repository.inspect', { selectedDocumentIds: ['service.retry'] })
    await fs.rename(path.join(root, 'context/service/manual/retry.md'), path.join(root, 'context/service/manual/retry-policy.md'))
    const after = await call(root, 'repository.inspect', { selectedDocumentIds: ['service.retry'] })

    expect(before.data?.context).not.toEqual(after.data?.context)
    expect(before.data?.selected).toEqual(after.data?.selected)
    expect((await call(root, 'graph.validate', {})).status).toBe('success')
  })

  it('detects front matter/body semantic changes and exact Meta Document set mismatch', async () => {
    const root = await repository()
    const file = path.join(root, 'context/service/manual/retry.md')
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('Retry behavior', 'Changed retry behavior'))
    expect((await call(root, 'graph.validate', {})).diagnostics?.some(item => item.code === 'META_DOCUMENT_FINGERPRINT_MISMATCH')).toBe(true)

    await fs.writeFile(file, documentSource(SERVICE_GUIDE))
    const metaPath = path.join(root, 'context/meta.json')
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'))
    delete meta.documents['service.retry']
    await fs.writeFile(metaPath, JSON.stringify(meta))
    expect((await call(root, 'graph.validate', {})).diagnostics?.some(item => item.code === 'META_DOCUMENT_SET_MISMATCH')).toBe(true)
  })

  it('changes source fingerprints when the declaration, file set, relative path, or raw bytes changes', async () => {
    const globDocument = { ...SERVICE_DOMAIN, codePaths: ['src/*.ts'] }
    const root = await repository([globDocument])
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

    const exact = { ...SERVICE_DOMAIN, codePaths: ['src/client.ts'] }
    await fs.writeFile(path.join(root, 'context/service/domain.md'), documentSource(exact))
    expect((await call(root, 'graph.validate', {})).diagnostics?.some(item => item.code === 'META_DOCUMENT_FINGERPRINT_MISMATCH')).toBe(true)
  })

  it('rejects Meta unknown fields and persisted derived status', async () => {
    const root = await repository([SERVICE_DOMAIN])
    const metaPath = path.join(root, 'context/meta.json')
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'))
    meta.documents.service.status = 'fresh'
    meta.session = {}
    await fs.writeFile(metaPath, JSON.stringify(meta))
    const response = await call(root, 'graph.validate', {})

    expect(response.status).toBe('failed')
    expect(response.diagnostics?.some(item => item.code === 'META_FIELD_UNKNOWN')).toBe(true)
    expect(response.diagnostics?.some(item => item.code === 'META_DOCUMENT_INVALID')).toBe(true)
  })

  it('treats a Context root or Meta symlink as invalid instead of absent', async () => {
    const contextRoot = await repository([SERVICE_DOMAIN])
    await fs.rename(path.join(contextRoot, 'context'), path.join(contextRoot, 'actual-context'))
    await fs.symlink('actual-context', path.join(contextRoot, 'context'))
    const contextResult = await call(contextRoot, 'repository.inspect', {})
    expect(contextResult.data?.context).toMatchObject({ state: 'invalid' })

    const metaRoot = await repository([SERVICE_DOMAIN])
    await fs.rename(path.join(metaRoot, 'context/meta.json'), path.join(metaRoot, 'meta-real.json'))
    await fs.symlink('../meta-real.json', path.join(metaRoot, 'context/meta.json'))
    const metaResult = await call(metaRoot, 'graph.validate', {})
    expect(metaResult.status).toBe('failed')
    expect(metaResult.diagnostics?.some(item => item.code === 'PATH_SYMLINK')).toBe(true)
  })
})
