import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { call, CLIENT_DOMAIN, createRepository, nameStatus, porcelainModified, removeRepository, REVISION_C, SERVICE_DOMAIN, SERVICE_GUIDE, writeGitEvidence } from './fixture.js'

// 每个用例拥有自己的 Context 和宿主证据叶子。
const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(removeRepository)))

/** 为增量查询构造两个相互独立的领域。 */
async function repository() {
  const root = await createRepository({ documents: [SERVICE_DOMAIN, SERVICE_GUIDE, CLIENT_DOMAIN] })
  roots.push(root)
  return root
}

describe('scoped content-based Delta', () => {
  it('separates local confirmation mismatch, reading prerequisites and outside Git impact', async () => {
    const root = await repository()
    await fs.writeFile(path.join(root, 'src/retry.ts'), 'changed\n')
    await fs.writeFile(path.join(root, 'src/client.ts'), 'outside\n')
    const gitEvidencePath = await writeGitEvidence(root, { status: porcelainModified('src/client.ts') + porcelainModified('src/retry.ts') })
    const result = await call(root, 'delta.compute', { gitEvidencePath, scope: { kind: 'documents', ids: ['service.retry'] } })
    expect(result.status).toBe('success')
    expect(result.data).toMatchObject({ historyCoverage: 'not_provided', confirmationMismatches: [{ documentId: 'service.retry' }], sourceAffected: [{ documentId: 'service.retry' }], outOfScopeAffected: [{ documentId: 'client' }] })
    expect(result.data?.requiredContext).toContainEqual({ documentId: 'service' })
    expect(result.data).not.toHaveProperty('repositoryBaselineEligible')
    expect(result.data).not.toHaveProperty('light')
  })

  it('does not add Domain siblings or unrelated historical drift', async () => {
    const root = await repository()
    await fs.writeFile(path.join(root, 'src/service.ts'), 'old unrelated change\n')
    const gitEvidencePath = await writeGitEvidence(root)
    const result = await call(root, 'delta.compute', { gitEvidencePath, scope: { kind: 'documents', ids: ['service.retry'] } })
    expect(result.data?.confirmationMismatches).toEqual([])
    expect(result.data?.requiredContext).toEqual([])
  })

  it('reports deleted exact sources and maps both sides of a Git move', async () => {
    const root = await repository()
    await fs.rename(path.join(root, 'src/retry.ts'), path.join(root, 'src/moved.ts'))
    const gitEvidencePath = await writeGitEvidence(root, { revision: REVISION_C, diff: nameStatus([{ status: 'R100', path: 'src/moved.ts', previousPath: 'src/retry.ts' }]) })
    const result = await call(root, 'delta.compute', { gitEvidencePath, scope: { kind: 'paths', paths: ['src/retry.ts'] } })
    expect(result.data).toMatchObject({ historyCoverage: 'provided', confirmationMismatches: [{ documentId: 'service.retry', confirmationState: 'unavailable' }], sourceAffected: [{ documentId: 'service.retry', changedPaths: ['src/retry.ts'] }] })
  })

  it('requires comparison metadata with diff and rejects stale or unknown evidence fields', async () => {
    const root = await repository()
    const gitEvidencePath = await writeGitEvidence(root, { diff: nameStatus([{ status: 'M', path: 'src/retry.ts' }]) })
    await fs.rm(path.join(root, gitEvidencePath, 'comparison.json'))
    expect((await call(root, 'delta.compute', { gitEvidencePath, scope: { kind: 'repository' } })).status).toBe('failed')
    await fs.writeFile(path.join(root, gitEvidencePath, 'comparison.json'), JSON.stringify({ kind: 'two-tree', base: REVISION_C, head: REVISION_C }))
    expect((await call(root, 'delta.compute', { gitEvidencePath, scope: { kind: 'repository' } })).status).toBe('failed')
  })

  it('paginates one bound result stream and refuses changed source evidence on continuation', async () => {
    const root = await repository()
    await fs.writeFile(path.join(root, 'src/retry.ts'), 'changed\n')
    const gitEvidencePath = await writeGitEvidence(root, { status: porcelainModified('src/retry.ts') })
    const input = { gitEvidencePath, scope: { kind: 'repository' } }
    const first = await call(root, 'delta.compute', input, { budget: { items: 1 } })
    expect(first.status).toBe('incomplete')
    expect((await call(root, 'delta.compute', input, { cursor: first.cursor! })).status).toBe('success')
    await fs.writeFile(path.join(root, 'src/retry.ts'), 'changed again\n')
    expect((await call(root, 'delta.compute', input, { cursor: first.cursor! })).diagnostics?.[0]?.code).toBe('CURSOR_STALE')
  })

  it.each([{ kind: 'domains', ids: ['missing'] }, { kind: 'documents', ids: ['missing'] }, { kind: 'paths', paths: ['../escape'] }])('rejects invalid scope %#', async (scope) => {
    const root = await repository()
    const gitEvidencePath = await writeGitEvidence(root)
    expect((await call(root, 'delta.compute', { gitEvidencePath, scope })).status).toBe('failed')
  })
})
