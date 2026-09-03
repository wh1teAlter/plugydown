import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { call, CLIENT_DOMAIN, createRepository, nameStatus, porcelainModified, removeRepository, REVISION_A, REVISION_C, SERVICE_DOMAIN, SERVICE_GUIDE, writeGitEvidence, writeMeta } from './fixture.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(removeRepository)))

async function repository(): Promise<string> {
  const root = await createRepository({ documents: [SERVICE_DOMAIN, SERVICE_GUIDE, CLIENT_DOMAIN], baselineRevision: REVISION_A })
  roots.push(root)
  return root
}

const taskEvidence = { intentKnown: true, scopeComplete: true, newCapabilitySuspected: false, crossDomainContractUncertain: false }

describe('delta.compute', () => {
  it('keeps baseline A across a local A-to-C update and later finds the untouched Domain', async () => {
    const root = await repository()
    const originalMeta = JSON.parse(await fs.readFile(path.join(root, 'context/meta.json'), 'utf8'))
    await fs.writeFile(path.join(root, 'src/service.ts'), 'service C\n')
    await fs.writeFile(path.join(root, 'src/client.ts'), 'client C\n')
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

    await writeMeta(root, [SERVICE_DOMAIN, SERVICE_GUIDE, CLIENT_DOMAIN], { baselineRevision: REVISION_A })
    const locallyUpdated = JSON.parse(await fs.readFile(path.join(root, 'context/meta.json'), 'utf8'))
    locallyUpdated.documents.client = originalMeta.documents.client
    locallyUpdated.repository.baseline.revision = REVISION_A
    await fs.writeFile(path.join(root, 'context/meta.json'), JSON.stringify(locallyUpdated))

    const later = await call(root, 'delta.compute', { gitEvidencePath: evidence, scope: { kind: 'repository' }, taskEvidence })
    expect(later.data?.repositoryBaseline).toBe(REVISION_A)
    expect(JSON.stringify(later.data?.directImpact)).not.toContain('service')
    expect(JSON.stringify(later.data?.directImpact)).toContain('client')
  })

  it('parses NUL-safe committed, worktree, rename, and untracked evidence', async () => {
    const root = await repository()
    await fs.writeFile(path.join(root, 'src/retry.ts'), 'changed\n')
    const status = `${porcelainModified('src/retry.ts')}? src/untracked file.ts\0`
    const diff = nameStatus([{ status: 'R100', previousPath: 'src/old client.ts', path: 'src/client.ts' }])
    const evidence = await writeGitEvidence(root, { revision: REVISION_C, status, diff })
    const response = await call(root, 'delta.compute', { gitEvidencePath: evidence, scope: { kind: 'repository' }, taskEvidence })

    expect(response.status).toBe('success')
    expect(JSON.stringify(response.data?.changedPaths)).toContain('src/untracked file.ts')
    expect(JSON.stringify(response.data?.changedPaths)).toContain('src/old client.ts')
    expect(JSON.stringify(response.data?.changedPaths)).toContain('renamed')
  })

  it('returns direct and explained requires/Domain impact closure', async () => {
    const root = await repository()
    await fs.writeFile(path.join(root, 'src/retry.ts'), 'changed\n')
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
    const root = await repository()
    const evidence = await writeGitEvidence(root)
    const response = await call(root, 'delta.compute', { gitEvidencePath: evidence, scope: { kind: 'repository' }, taskEvidence: evidenceFlags })
    expect(response.data?.light).toEqual(expect.objectContaining({ eligible: false, blockers: expect.arrayContaining([blocker]) }))
  })

  it('reports mid-operation, unmapped, and broken baseline evidence and refuses baseline advancement', async () => {
    const root = await repository()
    const evidence = await writeGitEvidence(root, {
      revision: REVISION_C,
      midOperation: 'rebase',
      status: '? unknown/new.ts\0',
    })
    const response = await call(root, 'delta.compute', { gitEvidencePath: evidence, scope: { kind: 'repository' }, taskEvidence })

    expect(response.status).toBe('success')
    expect(response.data?.unmappedPaths).toEqual(['unknown/new.ts'])
    expect(response.data?.brokenEvidence).toEqual(['repository baseline differs from HEAD but diff.bin is missing'])
    expect(response.data?.repositoryBaselineEligible).toBe(false)
    expect(response.data?.light).toEqual(expect.objectContaining({ eligible: false }))
  })

  it('requires Git metadata and valid host evidence rather than executing Git or claiming no change', async () => {
    const root = await repository()
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

  it('uses a cursor when Delta lists exceed the output budget', async () => {
    const root = await repository()
    await fs.writeFile(path.join(root, 'src/service.ts'), 'changed\n')
    await fs.writeFile(path.join(root, 'src/client.ts'), 'changed\n')
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
})
