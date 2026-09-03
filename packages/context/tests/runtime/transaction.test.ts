import type { RuntimeResponse } from '../../src/runtime/protocol.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLIENT_DOMAIN, createRepository, documentSource, PROTOCOL, removeRepository, REVISION_A, REVISION_C, SERVICE_DOMAIN, SERVICE_GUIDE, transactionCall, writeGitEvidence, writeMeta } from './fixture.js'

const roots: string[] = []
const changedService = { ...SERVICE_DOMAIN, body: '# Service\n\nChanged service behavior.\n' }

interface Approval {
  readonly approved: true
  readonly candidateFingerprint: string
  readonly sourceEvidenceFingerprint: string
  readonly summary: string
}

interface PreparedRun {
  readonly runId: string
  readonly candidatePath: string
  readonly gitEvidencePath: string
  readonly approval: Approval
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRepository))
})

function dataString(response: RuntimeResponse, key: string): string {
  const value = response.data?.[key]
  if (typeof value !== 'string')
    throw new TypeError(`Response data.${key} is not a string.`)
  return value
}

function approval(response: RuntimeResponse): Approval {
  return {
    approved: true,
    candidateFingerprint: dataString(response, 'candidateFingerprint'),
    sourceEvidenceFingerprint: dataString(response, 'sourceEvidenceFingerprint'),
    summary: 'Independent semantic review approved the candidate.',
  }
}

async function readyRoot(): Promise<string> {
  const root = await createRepository({
    documents: [SERVICE_DOMAIN, SERVICE_GUIDE, CLIENT_DOMAIN],
    baselineRevision: REVISION_A,
  })
  roots.push(root)
  return root
}

async function exists(root: string, relative: string): Promise<boolean> {
  return fs.access(path.join(root, relative)).then(() => true, () => false)
}

async function beginUpdate(root: string, options: { readonly dryRun?: boolean, readonly evidencePaths?: readonly string[] } = {}): Promise<{ readonly runId: string, readonly candidatePath: string, readonly gitEvidencePath: string }> {
  const gitEvidencePath = await writeGitEvidence(root)
  const response = await transactionCall(root, 'begin', {
    command: 'update',
    mode: 'deep',
    dryRun: options.dryRun ?? false,
    scope: { kind: 'repository' },
    gitEvidencePath,
    evidencePaths: options.evidencePaths ?? ['src/service.ts'],
  })
  expect(response.status, JSON.stringify(response)).toBe('success')
  return { runId: dataString(response, 'runId'), candidatePath: dataString(response, 'candidatePath'), gitEvidencePath }
}

async function prepareChanged(root: string, options: { readonly dryRun?: boolean, readonly glob?: boolean } = {}): Promise<PreparedRun> {
  const prepared = await beginUpdate(root, {
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    evidencePaths: options.glob ? ['src/*.ts'] : ['src/service.ts'],
  })
  const document = options.glob ? { ...changedService, codePaths: ['src/*.ts'] } : changedService
  await fs.writeFile(path.join(root, prepared.candidatePath, SERVICE_DOMAIN.relativePath), documentSource(document))
  const validated = await transactionCall(root, 'validate', { runId: prepared.runId })
  expect(validated.status).toBe(options.dryRun ? 'dry_run' : 'success')
  return { ...prepared, approval: approval(validated) }
}

async function readManifest(root: string, runId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(root, `.scratch/runs/${runId}/manifest.json`), 'utf8')) as Record<string, unknown>
}

async function markCommitting(root: string, run: PreparedRun): Promise<void> {
  const file = path.join(root, `.scratch/runs/${run.runId}/manifest.json`)
  const manifest = await readManifest(root, run.runId)
  await fs.writeFile(file, `${JSON.stringify({ ...manifest, phase: 'committing', approval: run.approval }, null, 2)}\n`)
}

async function markCommitted(root: string, run: PreparedRun): Promise<void> {
  const file = path.join(root, `.scratch/runs/${run.runId}/manifest.json`)
  const manifest = await readManifest(root, run.runId)
  await fs.writeFile(file, `${JSON.stringify({ ...manifest, phase: 'committed', approval: run.approval }, null, 2)}\n`)
}

describe('transaction lifecycle', () => {
  it('stages a complete candidate under one write lock and leaves read capabilities available', async () => {
    const root = await readyRoot()
    const first = await beginUpdate(root)
    const second = await transactionCall(root, 'begin', {
      command: 'update',
      mode: 'light',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath: '.scratch/evidence/request',
      evidencePaths: ['src/service.ts'],
    })
    const inspected = await (await import('../../src/runtime/handler.js')).handleRequest(root, { protocol: PROTOCOL, capability: 'repository.inspect', input: {} })

    expect(second.status).toBe('incomplete')
    expect(second.data?.activeRunId).toBe(first.runId)
    expect(inspected.status).toBe('success')
    expect(await fs.readFile(path.join(root, first.candidatePath, SERVICE_DOMAIN.relativePath), 'utf8')).toBe(documentSource(SERVICE_DOMAIN))
    expect(JSON.stringify(await readManifest(root, first.runId))).not.toContain(root)
  })

  it.each([
    ['init', 'light', true, 'TRANSACTION_MODE_INVALID'],
    ['init', 'deep', true, 'TRANSACTION_PRECONDITION_FAILED'],
    ['prune', 'light', true, 'TRANSACTION_MODE_INVALID'],
    ['update', 'deep', false, 'TRANSACTION_PRECONDITION_FAILED'],
  ] as const)('enforces %s/%s begin preconditions', async (command, mode, withContext, code) => {
    const root = await createRepository({
      ...(withContext ? { documents: [SERVICE_DOMAIN], baselineRevision: REVISION_A } : {}),
    })
    roots.push(root)
    const gitEvidencePath = await writeGitEvidence(root)
    const response = await transactionCall(root, 'begin', {
      command,
      mode,
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath,
      evidencePaths: ['src/service.ts'],
    })

    expect(response.status).toBe('failed')
    expect(response.diagnostics?.[0]?.code).toBe(code)
  })

  it('initializes an absent repository from an empty complete candidate root', async () => {
    const root = await createRepository()
    roots.push(root)
    const gitEvidencePath = await writeGitEvidence(root)
    const began = await transactionCall(root, 'begin', {
      command: 'init',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath,
      evidencePaths: ['src/service.ts'],
    })
    const runId = dataString(began, 'runId')
    const candidatePath = dataString(began, 'candidatePath')
    await fs.mkdir(path.join(root, candidatePath, 'service'), { recursive: true })
    await fs.writeFile(path.join(root, candidatePath, SERVICE_DOMAIN.relativePath), documentSource(SERVICE_DOMAIN))
    const validated = await transactionCall(root, 'validate', { runId })
    const committed = await transactionCall(root, 'commit', { runId, approval: approval(validated) })

    expect(validated.status).toBe('success')
    expect(committed.status).toBe('success')
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')).toBe(documentSource(SERVICE_DOMAIN))
  })

  it('commits a deep prune when complete source coverage remains', async () => {
    const removableGuide = {
      relativePath: SERVICE_GUIDE.relativePath,
      id: SERVICE_GUIDE.id,
      kind: 'guide' as const,
      domain: SERVICE_GUIDE.domain,
      description: 'Retry behavior and constraints.',
      relations: { requires: ['service'] },
      body: '# Retry\n\nRetry only transient failures.\n',
    }
    const root = await createRepository({
      documents: [SERVICE_DOMAIN, removableGuide, CLIENT_DOMAIN],
      baselineRevision: REVISION_A,
    })
    roots.push(root)
    const gitEvidencePath = await writeGitEvidence(root)
    const began = await transactionCall(root, 'begin', {
      command: 'prune',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath,
      evidencePaths: ['src/service.ts'],
    })
    const runId = dataString(began, 'runId')
    const candidatePath = dataString(began, 'candidatePath')
    await fs.rm(path.join(root, candidatePath, 'service/manual'), { recursive: true })
    const validated = await transactionCall(root, 'validate', { runId })
    const committed = await transactionCall(root, 'commit', { runId, approval: approval(validated) })

    expect(validated.status).toBe('success')
    expect(committed.status).toBe('success')
    expect(await fs.access(path.join(root, 'context/service/manual')).then(() => true, () => false)).toBe(false)
  })

  it('derives Meta, binds approval, switches whole directories, returns a bounded summary, and clears owned leaves', async () => {
    const root = await readyRoot()
    const run = await prepareChanged(root)
    const manifest = await readManifest(root, run.runId)
    const candidateMeta = JSON.parse(await fs.readFile(path.join(root, run.candidatePath, 'meta.json'), 'utf8')) as Record<string, unknown>
    const committed = await transactionCall(root, 'commit', { runId: run.runId, approval: run.approval })

    expect(manifest.phase).toBe('validated')
    expect(candidateMeta).toMatchObject({
      $schema: 'plugydown.context.meta/v1',
      runtimeProtocol: PROTOCOL,
      fingerprintVersion: '1',
    })
    expect(committed.status).toBe('success')
    expect(committed.data).toMatchObject({
      outcome: 'committed',
      approvedCandidateFingerprint: run.approval.candidateFingerprint,
      approvedSourceEvidenceFingerprint: run.approval.sourceEvidenceFingerprint,
    })
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')).toBe(documentSource(changedService))
    expect(committed.data).not.toHaveProperty('reportPath')
    expect(JSON.stringify(committed)).not.toContain(root)
    expect(JSON.stringify(committed)).not.toMatch(/timestamp|createdAt|updatedAt|process\.env/i)
    expect(await exists(root, `.scratch/runs/${run.runId}`)).toBe(false)
    expect(await exists(root, run.gitEvidencePath)).toBe(false)
    expect(await exists(root, '.scratch/locks/context-write')).toBe(false)

    const terminal = await transactionCall(root, 'resume', { runId: run.runId })
    expect(terminal.status).toBe('failed')
  })

  it('terminates byte-equivalent candidates as no_change without a directory switch', async () => {
    const root = await readyRoot()
    const before = await fs.readFile(path.join(root, 'context/meta.json'))
    const run = await beginUpdate(root)
    const result = await transactionCall(root, 'validate', { runId: run.runId })

    expect(result.status).toBe('no_change')
    expect(result.data?.outcome).toBe('no_change')
    expect(await fs.readFile(path.join(root, 'context/meta.json'))).toEqual(before)
    expect(await exists(root, `.scratch/runs/${run.runId}`)).toBe(false)
    expect(await exists(root, run.gitEvidencePath)).toBe(false)
    expect(await exists(root, '.scratch/locks/context-write')).toBe(false)
  })

  it('returns dry-run fingerprints, leaves formal Context untouched, and makes the cleaned run non-resumable', async () => {
    const root = await readyRoot()
    const before = await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')
    const run = await prepareChanged(root, { dryRun: true })

    expect(await exists(root, '.scratch/locks/context-write')).toBe(false)
    expect(await exists(root, `.scratch/runs/${run.runId}`)).toBe(false)
    expect(await exists(root, run.gitEvidencePath)).toBe(false)
    const resumed = await transactionCall(root, 'resume', { runId: run.runId })
    expect(resumed.status).toBe('failed')
    const committed = await transactionCall(root, 'commit', { runId: run.runId, approval: run.approval })
    expect(committed.status).toBe('failed')
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')).toBe(before)
    expect(await exists(root, run.candidatePath)).toBe(false)
  })
})

describe('transaction validation and concurrency', () => {
  it('rejects incomplete candidates and prune candidates that lose source coverage', async () => {
    const root = await readyRoot()
    const invalid = await beginUpdate(root)
    await fs.rm(path.join(root, invalid.candidatePath, 'service/domain.md'))
    const invalidResult = await transactionCall(root, 'validate', { runId: invalid.runId })
    expect(invalidResult.status).toBe('failed')
    expect(invalidResult.diagnostics?.map(item => item.code)).toContain('DOMAIN_DOCUMENT_MISSING')
    expect(await exists(root, `.scratch/runs/${invalid.runId}`)).toBe(false)
    expect(await exists(root, invalid.gitEvidencePath)).toBe(false)

    const evidence = await writeGitEvidence(root, { id: 'prune' })
    const began = await transactionCall(root, 'begin', {
      command: 'prune',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath: evidence,
      evidencePaths: ['src/service.ts'],
    })
    const runId = dataString(began, 'runId')
    const candidate = dataString(began, 'candidatePath')
    await fs.rm(path.join(root, candidate, 'service/manual'), { recursive: true })
    const pruned = await transactionCall(root, 'validate', { runId })
    expect(pruned.status).toBe('failed')
    expect(pruned.diagnostics?.[0]?.code).toBe('PRUNE_COVERAGE_LOST')
    expect(await exists(root, `.scratch/runs/${runId}`)).toBe(false)
    expect(await exists(root, evidence)).toBe(false)
  })

  it('stops validate when declared source or formal Context changed after begin', async () => {
    const sourceRoot = await readyRoot()
    const sourceRun = await beginUpdate(sourceRoot)
    await fs.appendFile(path.join(sourceRoot, 'src/service.ts'), 'export const changed = true\n')
    const sourceResult = await transactionCall(sourceRoot, 'validate', { runId: sourceRun.runId })
    expect(sourceResult.status).toBe('failed')
    expect(sourceResult.diagnostics?.[0]?.code).toBe('DECLARED_EVIDENCE_CONFLICT')
    expect(await exists(sourceRoot, `.scratch/runs/${sourceRun.runId}`)).toBe(false)
    expect(await exists(sourceRoot, sourceRun.gitEvidencePath)).toBe(false)

    const formalRoot = await readyRoot()
    const formalRun = await beginUpdate(formalRoot)
    await fs.appendFile(path.join(formalRoot, 'context/service/domain.md'), '\n')
    const formalResult = await transactionCall(formalRoot, 'validate', { runId: formalRun.runId })
    expect(formalResult.status).toBe('failed')
    expect(formalResult.diagnostics?.[0]?.code).toBe('FORMAL_CONTEXT_CONFLICT')
    expect(await exists(formalRoot, `.scratch/runs/${formalRun.runId}`)).toBe(false)
    expect(await exists(formalRoot, formalRun.gitEvidencePath)).toBe(false)
  })

  it('returns incomplete without switching when candidate, source content, glob set, formal Context, or approval changes', async () => {
    const candidateRoot = await readyRoot()
    const candidateRun = await prepareChanged(candidateRoot)
    await fs.appendFile(path.join(candidateRoot, candidateRun.candidatePath, SERVICE_DOMAIN.relativePath), '\n')
    const candidateResult = await transactionCall(candidateRoot, 'commit', { runId: candidateRun.runId, approval: candidateRun.approval })
    expect(candidateResult.status).toBe('incomplete')
    expect(candidateResult.data?.nextAction).toBe('validate')

    const sourceRoot = await readyRoot()
    const sourceRun = await prepareChanged(sourceRoot)
    await fs.appendFile(path.join(sourceRoot, 'src/service.ts'), 'export const concurrent = true\n')
    const sourceResult = await transactionCall(sourceRoot, 'commit', { runId: sourceRun.runId, approval: sourceRun.approval })
    expect(sourceResult.status).toBe('incomplete')
    expect(sourceResult.data?.nextAction).toBe('validate')

    const globRoot = await readyRoot()
    const globRun = await prepareChanged(globRoot, { glob: true })
    await fs.writeFile(path.join(globRoot, 'src/new.ts'), 'export const added = true\n')
    expect((await transactionCall(globRoot, 'commit', { runId: globRun.runId, approval: globRun.approval })).status).toBe('incomplete')

    const formalRoot = await readyRoot()
    const formalRun = await prepareChanged(formalRoot)
    await fs.appendFile(path.join(formalRoot, 'context/client/domain.md'), '\n')
    expect((await transactionCall(formalRoot, 'commit', { runId: formalRun.runId, approval: formalRun.approval })).status).toBe('incomplete')

    const approvalRoot = await readyRoot()
    const approvalRun = await prepareChanged(approvalRoot)
    const mismatched = { ...approvalRun.approval, candidateFingerprint: '0'.repeat(64) }
    const approvalResult = await transactionCall(approvalRoot, 'commit', { runId: approvalRun.runId, approval: mismatched })
    expect(approvalResult.status).toBe('incomplete')
    expect(approvalResult.diagnostics?.[0]?.code).toBe('APPROVAL_MISMATCH')
  })

  it('does not advance a repository baseline when prior-to-HEAD diff evidence is missing', async () => {
    const root = await readyRoot()
    const gitEvidencePath = await writeGitEvidence(root, { id: 'baseline-gap', revision: REVISION_C })
    const began = await transactionCall(root, 'begin', {
      command: 'update',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath,
      evidencePaths: ['src/service.ts'],
    })
    const runId = dataString(began, 'runId')
    const candidatePath = dataString(began, 'candidatePath')
    await fs.writeFile(path.join(root, candidatePath, SERVICE_DOMAIN.relativePath), documentSource(changedService))

    const validated = await transactionCall(root, 'validate', { runId })
    const meta = JSON.parse(await fs.readFile(path.join(root, candidatePath, 'meta.json'), 'utf8')) as { repository?: { baseline?: { revision?: string } } }

    expect(validated.status).toBe('success')
    expect(meta.repository?.baseline?.revision).toBe(REVISION_A)
  })

  it('invalidates the old approval after a validated candidate changes', async () => {
    const root = await readyRoot()
    const run = await prepareChanged(root)
    const changedAgain = { ...changedService, body: '# Service\n\nA second reviewed candidate.\n' }
    await fs.writeFile(path.join(root, run.candidatePath, SERVICE_DOMAIN.relativePath), documentSource(changedAgain))
    const revalidated = await transactionCall(root, 'validate', { runId: run.runId })
    expect(revalidated.status).toBe('success')
    expect(dataString(revalidated, 'candidateFingerprint')).not.toBe(run.approval.candidateFingerprint)

    const staleApproval = await transactionCall(root, 'commit', { runId: run.runId, approval: run.approval })
    expect(staleApproval.status).toBe('incomplete')
    expect(staleApproval.diagnostics?.[0]?.code).toBe('APPROVAL_MISMATCH')
  })

  it('resumes only fresh staged/validated runs and safely reacquires a lost same-run lock', async () => {
    const stagedRoot = await readyRoot()
    const stagedRun = await beginUpdate(stagedRoot)
    await fs.rm(path.join(stagedRoot, '.scratch/locks/context-write'), { recursive: true })
    const staged = await transactionCall(stagedRoot, 'resume', { runId: stagedRun.runId })
    expect(staged.status).toBe('success')
    expect(staged.data?.nextAction).toBe('edit_candidate')
    await fs.appendFile(path.join(stagedRoot, 'src/service.ts'), 'export const stagedStale = true\n')
    const stagedStale = await transactionCall(stagedRoot, 'resume', { runId: stagedRun.runId })
    expect(stagedStale.status).toBe('incomplete')
    expect(stagedStale.data?.nextAction).toBe('regenerate_candidate')

    const root = await readyRoot()
    const run = await prepareChanged(root)
    await fs.rm(path.join(root, '.scratch/locks/context-write'), { recursive: true })
    const fresh = await transactionCall(root, 'resume', { runId: run.runId })
    expect(fresh.status).toBe('success')
    expect(fresh.data?.nextAction).toBe('semantic_review')

    await fs.appendFile(path.join(root, 'src/service.ts'), 'export const stale = true\n')
    const stale = await transactionCall(root, 'resume', { runId: run.runId })
    expect(stale.status).toBe('incomplete')
    expect(stale.data?.nextAction).toBe('regenerate_candidate')
  })

  it('requires manual recovery for corrupt or differently owned locks', async () => {
    const corruptRoot = await readyRoot()
    await fs.mkdir(path.join(corruptRoot, '.scratch/locks/context-write'), { recursive: true })
    await fs.writeFile(path.join(corruptRoot, '.scratch/locks/context-write/owner.json'), '{}')
    const evidence = await writeGitEvidence(corruptRoot)
    const corrupt = await transactionCall(corruptRoot, 'begin', {
      command: 'update',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath: evidence,
      evidencePaths: ['src/service.ts'],
    })
    expect(corrupt.status).toBe('incomplete')
    expect(corrupt.data?.manualRecoveryRequired).toBe(true)

    const ownerRoot = await readyRoot()
    const run = await beginUpdate(ownerRoot)
    await fs.writeFile(path.join(ownerRoot, '.scratch/locks/context-write/owner.json'), JSON.stringify({
      schema: 'plugydown.context.lock/v1',
      runId: '11111111-1111-4111-8111-111111111111',
    }))
    const blocked = await transactionCall(ownerRoot, 'resume', { runId: run.runId })
    expect(blocked.status).toBe('incomplete')
    expect(blocked.data?.activeRunId).toBe('11111111-1111-4111-8111-111111111111')
  })
})

describe('transaction crash recovery', () => {
  it('continues a uniquely safe pre-switch window', async () => {
    const root = await readyRoot()
    const run = await prepareChanged(root)
    await markCommitting(root, run)

    const resumed = await transactionCall(root, 'resume', { runId: run.runId })
    expect(resumed.status).toBe('success')
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')).toBe(documentSource(changedService))
    expect(await exists(root, `.scratch/runs/${run.runId}`)).toBe(false)
    expect(await exists(root, run.gitEvidencePath)).toBe(false)
  })

  it('completes an init pre-switch window when the snapshot and live tree are both absent', async () => {
    const root = await createRepository()
    roots.push(root)
    const gitEvidencePath = await writeGitEvidence(root, { id: 'init-crash' })
    const began = await transactionCall(root, 'begin', {
      command: 'init',
      mode: 'deep',
      dryRun: false,
      scope: { kind: 'repository' },
      gitEvidencePath,
      evidencePaths: ['src/service.ts'],
    })
    const runId = dataString(began, 'runId')
    const candidatePath = dataString(began, 'candidatePath')
    await fs.mkdir(path.join(root, candidatePath, 'service'), { recursive: true })
    await fs.writeFile(path.join(root, candidatePath, SERVICE_DOMAIN.relativePath), documentSource(SERVICE_DOMAIN))
    const validated = await transactionCall(root, 'validate', { runId })
    const run: PreparedRun = { runId, candidatePath, gitEvidencePath, approval: approval(validated) }
    await markCommitting(root, run)

    const resumed = await transactionCall(root, 'resume', { runId })

    expect(resumed.status).toBe('success')
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')).toBe(documentSource(SERVICE_DOMAIN))
    expect(await exists(root, `.scratch/runs/${runId}`)).toBe(false)
    expect(await exists(root, gitEvidencePath)).toBe(false)
    expect(await exists(root, '.scratch/locks/context-write')).toBe(false)
  })

  it('restores a trusted backup after the live-to-backup crash window', async () => {
    const root = await readyRoot()
    const before = await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')
    const run = await prepareChanged(root)
    await markCommitting(root, run)
    const backup = path.join(root, `.scratch/runs/${run.runId}/backup/context`)
    await fs.mkdir(path.dirname(backup), { recursive: true })
    await fs.rename(path.join(root, 'context'), backup)

    const resumed = await transactionCall(root, 'resume', { runId: run.runId })
    expect(resumed.status).toBe('failed')
    expect(resumed.data?.outcome).toBe('backup_restored')
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')).toBe(before)
    expect(await exists(root, `.scratch/runs/${run.runId}`)).toBe(false)
    expect(await exists(root, run.gitEvidencePath)).toBe(false)
    expect(await exists(root, '.scratch/locks/context-write')).toBe(false)
  })

  it('finalizes an already switched approved candidate and cleans backup/lock', async () => {
    const root = await readyRoot()
    const run = await prepareChanged(root)
    await markCommitting(root, run)
    const backup = path.join(root, `.scratch/runs/${run.runId}/backup/context`)
    await fs.mkdir(path.dirname(backup), { recursive: true })
    await fs.rename(path.join(root, 'context'), backup)
    await fs.rename(path.join(root, run.candidatePath), path.join(root, 'context'))

    const resumed = await transactionCall(root, 'resume', { runId: run.runId })
    expect(resumed.status).toBe('success')
    expect(await fs.access(backup).then(() => true, () => false)).toBe(false)
    expect(await fs.access(path.join(root, '.scratch/locks/context-write')).then(() => true, () => false)).toBe(false)
    expect(await exists(root, `.scratch/runs/${run.runId}`)).toBe(false)
    expect(await exists(root, run.gitEvidencePath)).toBe(false)
  })

  it('restores the trusted backup when final verification observes a corrupted switched candidate', async () => {
    const root = await readyRoot()
    const before = await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')
    const run = await prepareChanged(root)
    await markCommitting(root, run)
    const backup = path.join(root, `.scratch/runs/${run.runId}/backup/context`)
    await fs.mkdir(path.dirname(backup), { recursive: true })
    await fs.rename(path.join(root, 'context'), backup)
    await fs.rename(path.join(root, run.candidatePath), path.join(root, 'context'))
    await fs.appendFile(path.join(root, 'context/service/domain.md'), '\ncorrupted after switch\n')

    const resumed = await transactionCall(root, 'resume', { runId: run.runId })

    expect(resumed.status).toBe('failed')
    expect(resumed.data?.outcome).toBe('backup_restored')
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')).toBe(before)
    expect(await exists(root, `.scratch/runs/${run.runId}`)).toBe(false)
    expect(await exists(root, run.gitEvidencePath)).toBe(false)
    expect(await exists(root, '.scratch/locks/context-write')).toBe(false)
  })

  it('finishes cleanup after a committed-manifest crash window', async () => {
    const root = await readyRoot()
    const run = await prepareChanged(root)
    await markCommitting(root, run)
    const backup = path.join(root, `.scratch/runs/${run.runId}/backup/context`)
    await fs.mkdir(path.dirname(backup), { recursive: true })
    await fs.rename(path.join(root, 'context'), backup)
    await fs.rename(path.join(root, run.candidatePath), path.join(root, 'context'))
    await markCommitted(root, run)

    const resumed = await transactionCall(root, 'resume', { runId: run.runId })

    expect(resumed.status).toBe('success')
    expect(resumed.data?.outcome).toBe('committed')
    expect(await fs.readFile(path.join(root, 'context/service/domain.md'), 'utf8')).toBe(documentSource(changedService))
    expect(await exists(root, `.scratch/runs/${run.runId}`)).toBe(false)
    expect(await exists(root, run.gitEvidencePath)).toBe(false)
    expect(await exists(root, '.scratch/locks/context-write')).toBe(false)
  })

  it('preserves conflicting complete copies for manual recovery', async () => {
    const root = await readyRoot()
    const run = await prepareChanged(root)
    await markCommitting(root, run)
    const backup = path.join(root, `.scratch/runs/${run.runId}/backup/context`)
    await fs.mkdir(path.dirname(backup), { recursive: true })
    await fs.cp(path.join(root, 'context'), backup, { recursive: true })
    const conflicting = { ...CLIENT_DOMAIN, body: '# Client\n\nConcurrent valid knowledge.\n' }
    await fs.writeFile(path.join(root, 'context/client/domain.md'), documentSource(conflicting))
    await writeMeta(root, [SERVICE_DOMAIN, SERVICE_GUIDE, conflicting], { baselineRevision: REVISION_A })

    const resumed = await transactionCall(root, 'resume', { runId: run.runId })
    expect(resumed.status).toBe('incomplete')
    expect(resumed.data).toMatchObject({ outcome: 'manual_recovery', manualRecoveryRequired: true })
    expect(await fs.access(backup).then(() => true, () => false)).toBe(true)
    expect(await fs.access(path.join(root, run.candidatePath)).then(() => true, () => false)).toBe(true)
    expect(await exists(root, run.gitEvidencePath)).toBe(true)
    expect(await exists(root, '.scratch/locks/context-write')).toBe(true)
  })

  it('fails without deleting diagnostics when no complete trusted copy remains', async () => {
    const root = await readyRoot()
    const run = await prepareChanged(root)
    await markCommitting(root, run)
    await fs.rm(path.join(root, 'context'), { recursive: true })
    await fs.rm(path.join(root, run.candidatePath), { recursive: true })

    const resumed = await transactionCall(root, 'resume', { runId: run.runId })
    expect(resumed.status).toBe('failed')
    expect(resumed.data).toMatchObject({ outcome: 'no_trusted_copy', manualRecoveryRequired: true })
    expect(await exists(root, `.scratch/runs/${run.runId}/manifest.json`)).toBe(true)
    expect(await exists(root, run.gitEvidencePath)).toBe(true)
    expect(await exists(root, '.scratch/locks/context-write')).toBe(true)
  })
})
