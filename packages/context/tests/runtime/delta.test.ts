import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { call, CLIENT_DOMAIN, createRepository, documentSource, nameStatus, porcelainModified, removeRepository, REVISION_A, REVISION_C, SERVICE_DOMAIN, SERVICE_GUIDE, transactionCall, writeGitEvidence } from './fixture.js'

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

    const began = await transactionCall(root, 'begin', {
      command: 'update',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'domains', ids: ['service'] },
      gitEvidencePath: evidence,
      evidencePaths: ['src/service.ts'],
    })
    const runId = began.data?.runId as string
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
    const root = await repository()
    const originalMeta = JSON.parse(await fs.readFile(path.join(root, 'context/meta.json'), 'utf8'))
    await fs.writeFile(path.join(root, 'src/service.ts'), 'service C\n')
    await fs.writeFile(path.join(root, 'src/retry.ts'), 'retry C\n')
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
    const runId = began.data?.runId as string
    const candidatePath = began.data?.candidatePath as string

    // The Recorder synchronizes only domain.md and leaves the authorized sibling untouched.
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

  async function repositoryUpdate(root: string, options: {
    readonly diff: readonly { readonly status: string, readonly path: string }[]
    readonly reaffirmedDocumentIds?: readonly string[]
  }): Promise<{ readonly baseline: string }> {
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
    const root = await repository()
    await fs.writeFile(path.join(root, 'src/service.ts'), 'service C\n')
    await fs.writeFile(path.join(root, 'src/retry.ts'), 'retry C\n')
    const changes = [{ status: 'M', path: 'src/service.ts' }, { status: 'M', path: 'src/retry.ts' }]

    // Only the Domain document is synchronized; service.retry cites a changed file but is untouched.
    const after = await repositoryUpdate(root, { diff: changes })
    expect(after.baseline).toBe(REVISION_A)

    // The queue comes from fingerprints, not history: even with no diff at all, service.retry stays in it.
    const later = await writeGitEvidence(root, { id: 'after-partial', revision: REVISION_C })
    const delta = await call(root, 'delta.compute', { gitEvidencePath: later, scope: { kind: 'repository' }, taskEvidence })
    expect((delta.data?.directImpact as Array<{ documentId: string }>).map(item => item.documentId)).toEqual(['service.retry'])
  })

  it('keeps the review queue complete when a squash merge orphaned the baseline commit', async () => {
    const root = await repository()
    await fs.writeFile(path.join(root, 'src/retry.ts'), 'retry C\n')
    // Baseline A no longer exists, so the host supplies status at C and no diff.bin.
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
    const root = await repository()
    // `git status` without --untracked-files=all reports a brand-new directory as `dir/`.
    const evidence = await writeGitEvidence(root, { status: '? features/\0' })
    const response = await call(root, 'delta.compute', { gitEvidencePath: evidence, scope: { kind: 'repository' }, taskEvidence })

    expect(response.status).toBe('failed')
    expect(response.diagnostics?.[0]).toMatchObject({ code: 'GIT_STATUS_UNTRACKED_COLLAPSED', path: 'status.bin' })
    expect(response.diagnostics?.[0]?.message).toContain('--untracked-files=all')
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

  it('reports mid-operation and working-tree-only changes, and refuses baseline advancement mid-operation', async () => {
    const root = await repository()
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
    const referenced = await repository()
    await fs.writeFile(path.join(referenced, 'src/service.ts'), 'service C\n')
    const staleAnchor = await writeGitEvidence(referenced, {
      revision: REVISION_A,
      diff: nameStatus([{ status: 'M', path: 'src/service.ts' }]),
      status: porcelainModified('src/service.ts'),
    })
    // A cited file that moved is exactly what must force Deep.
    await fs.rm(path.join(referenced, 'src/service.ts'))
    const broken = await call(referenced, 'delta.compute', { gitEvidencePath: staleAnchor, scope: { kind: 'repository' }, taskEvidence })
    expect(broken.data?.brokenEvidence).not.toEqual([])
    expect(broken.data?.light).toEqual(expect.objectContaining({ eligible: false, blockers: ['evidence is incomplete'] }))

    // Static assets and lockfiles are cited by nobody, so no recorded knowledge can be stale.
    const root = await repository()
    await fs.mkdir(path.join(root, 'assets'))
    await fs.writeFile(path.join(root, 'assets/logo.png'), 'png\n')
    await fs.writeFile(path.join(root, 'lockfile.lock'), 'lock\n')
    const evidence = await writeGitEvidence(root, {
      revision: REVISION_A,
      status: `${porcelainModified('assets/logo.png')}${porcelainModified('lockfile.lock')}`,
    })
    const response = await call(root, 'delta.compute', { gitEvidencePath: evidence, scope: { kind: 'repository' }, taskEvidence })

    expect(response.data?.unreferencedPaths).toEqual(['assets/logo.png', 'lockfile.lock'])
    expect(response.data?.directImpact).toEqual([])
    expect(response.data?.light).toEqual({ eligible: true, blockers: [] })
    // Nor do they pin the baseline: no recorded fingerprint covers them, so passing them claims nothing.
    expect(response.data?.repositoryBaselineEligible).toBe(true)
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

  it('strictly validates Porcelain v2 headers, HEAD binding, and unmerged record arity', async () => {
    const root = await repository()
    const evidence = await writeGitEvidence(root)
    const statusPath = path.join(root, evidence, 'status.bin')
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

  it('keeps source-degraded Delta actionable and invalidates its cursor when source facts change', async () => {
    const root = await repository()
    await fs.rm(path.join(root, 'src/retry.ts'))
    const evidence = await writeGitEvidence(root, {
      revision: REVISION_C,
      diff: nameStatus([{ status: 'D', path: 'src/retry.ts' }, { status: 'M', path: 'src/service.ts' }]),
    })
    const input = { gitEvidencePath: evidence, scope: { kind: 'repository' as const }, taskEvidence }
    const first = await call(root, 'delta.compute', input, {
      budget: { items: 1, bytes: 1024 * 1024, estimatedTokens: 128000 },
    })
    expect(first.status).toBe('incomplete')

    let page = first
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
