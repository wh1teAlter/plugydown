import type { Ledger } from './meta.js'
import type { JsonObject } from './types.js'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { KNOWLEDGE_ROOT, META_PATH, SCRATCH_ROOT } from './constants.js'
import { ledgerToJson } from './meta.js'
import { resolveInsideRepository } from './repository.js'
import { compareCodeUnits, stableJson } from './stable-json.js'

/** The seven ordered phases every formal write passes through. */
export const PHASES = [
  'snapshot',
  'stage',
  'validate',
  'review',
  'concurrency-check',
  'commit',
  'verify',
] as const

/** One transaction phase. */
export type Phase = typeof PHASES[number]

/** How a recovery attempt ended. */
export type RecoveryOutcome = 'recovered' | 'manual-recovery-required' | 'failed'

/** Terminal state of a transaction. */
export type TransactionStatus = 'success' | 'incomplete' | 'failed'

/** One planned file operation. */
export interface Operation {
  readonly kind: 'write' | 'replace' | 'delete'
  /** Repository-relative target path. */
  readonly target: string
  /** New contents, absent for a delete. */
  readonly contents?: string
}

/** One journalled operation and how far it got. */
export interface JournalEntry {
  readonly kind: Operation['kind'] | 'restore'
  readonly target: string
  readonly backup?: string
  readonly state: 'planned' | 'applied' | 'reverted'
}

/** The recorded transaction journal. */
export interface Journal {
  readonly runId: string
  readonly phase: Phase | 'recovery'
  readonly operations: readonly JournalEntry[]
  readonly recovery?: { readonly outcome: RecoveryOutcome, readonly detail?: string }
}

/** Semantic review verdict returned by the caller. */
export interface ReviewVerdict {
  readonly approved: boolean
  readonly reason?: string
}

/** Everything a transaction needs to run. */
export interface TransactionInput {
  readonly root: string
  readonly runId: string
  readonly command: 'init' | 'update' | 'prune'
  readonly mode: string
  readonly scope: JsonObject
  readonly authorization: { readonly source: 'explicit-invocation' | 'confirmed-suggestion', readonly dryRun?: boolean }
  readonly operations: readonly Operation[]
  readonly ledger: Ledger
  /**
   * Computes the authoritative ledger from the staged candidate.
   *
   * The candidate is the only complete view of a formal write, so deriving the ledger there
   * prevents a caller from committing hashes that do not describe the Markdown it reviewed.
   */
  readonly prepareLedger?: (candidateRoot: string) => Promise<Ledger>
  /** Deterministic structural validation over the staged candidate. */
  readonly validate: (candidateRoot: string) => Promise<readonly string[]>
  /** Semantic review of the staged candidate, before anything is committed. */
  readonly review: (candidateRoot: string) => Promise<ReviewVerdict>
  /**
   * Fault injection points, used only by tests.
   *
   * Real failures are indistinguishable from injected ones by design: the recovery path must
   * not have a "this is only a drill" branch.
   */
  readonly faults?: Partial<Record<Phase, () => void>>
}

/** The outcome of a transaction. */
export interface TransactionResult {
  readonly status: TransactionStatus
  readonly runId: string
  readonly reachedPhase: Phase
  readonly summary: string
  readonly issues: readonly string[]
  readonly journal: Journal
  readonly committed: readonly string[]
}

/** @returns the hex SHA-256 of a string. */
function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** @returns the run's staging directory, relative to the repository root. */
export function runDirectory(command: string, runId: string): string {
  return `${SCRATCH_ROOT}/runs/${command}/${runId}`
}

/** @returns the fingerprint of a repository file, or undefined when it does not exist. */
async function fingerprintOf(root: string, target: string): Promise<string | undefined> {
  try {
    return digest(await fs.readFile(await resolveInsideRepository(root, target), 'utf8'))
  }
  catch {
    return undefined
  }
}

/**
 * Records the pre-transaction state of every target.
 *
 * The snapshot is the only thing that makes the concurrency check meaningful, and it
 * deliberately does not widen authorization: it records what the declared operations touch,
 * nothing else.
 *
 * @param input the transaction input.
 * @returns target path to fingerprint, absent when the target did not exist.
 */
async function takeSnapshot(input: TransactionInput): Promise<ReadonlyMap<string, string | undefined>> {
  const snapshot = new Map<string, string | undefined>()
  for (const operation of input.operations)
    snapshot.set(operation.target, await fingerprintOf(input.root, operation.target))
  snapshot.set(META_PATH, await fingerprintOf(input.root, META_PATH))
  return snapshot
}

/**
 * Materializes the candidate under the run's staging directory.
 *
 * Nothing is written to `context/` here. A candidate that fails validation or review is simply
 * left behind for inspection and recovery.
 *
 * @param input the transaction input.
 * @param absoluteRun absolute staging directory.
 * @returns the absolute candidate root.
 */
async function stageCandidate(input: TransactionInput, absoluteRun: string): Promise<string> {
  const candidateRoot = path.join(absoluteRun, 'candidate')
  await fs.mkdir(path.join(candidateRoot, KNOWLEDGE_ROOT), { recursive: true })

  /** The candidate starts as a copy of current formal knowledge so validation sees the whole tree. */
  const currentRoot = path.join(input.root, KNOWLEDGE_ROOT)
  try {
    await fs.cp(currentRoot, path.join(candidateRoot, KNOWLEDGE_ROOT), { recursive: true })
  }
  catch {
    /** An uninitialized repository has nothing to copy; the candidate is built from scratch. */
  }

  for (const operation of input.operations) {
    const target = path.join(candidateRoot, operation.target)
    if (operation.kind === 'delete') {
      await fs.rm(target, { force: true })
      continue
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, operation.contents ?? '')
  }

  await fs.writeFile(path.join(candidateRoot, META_PATH), stableJson(ledgerToJson(input.ledger)))
  return candidateRoot
}

/**
 * Applies the committed operations, journalling each one before and after it happens.
 *
 * Every destructive step keeps a recoverable backup inside the run directory, and no backup is
 * removed while the transaction can still fail.
 *
 * @param input the transaction input.
 * @param absoluteRun absolute staging directory.
 * @param candidateRoot absolute candidate root.
 * @param entries journal accumulator, mutated in place so a mid-commit throw still leaves a record.
 * @returns the repository-relative paths that were committed.
 */
async function applyCommit(
  input: TransactionInput,
  absoluteRun: string,
  candidateRoot: string,
  entries: JournalEntry[],
): Promise<readonly string[]> {
  const backups = path.join(absoluteRun, 'backup')
  await fs.mkdir(backups, { recursive: true })
  const committed: string[] = []

  const targets = [...input.operations.map(operation => operation.target), META_PATH]
    .filter((target, index, all) => all.indexOf(target) === index)
    .sort(compareCodeUnits)

  for (const target of targets) {
    const absolute = await resolveInsideRepository(input.root, target)
    const backup = path.join(backups, target.replaceAll('/', '__'))
    const existing = await fs.readFile(absolute, 'utf8').catch(() => undefined)

    if (existing !== undefined) {
      await fs.writeFile(backup, existing)
      entries.push({ kind: 'replace', target, backup, state: 'planned' })
    }
    else {
      entries.push({ kind: 'write', target, state: 'planned' })
    }

    const staged = await fs.readFile(path.join(candidateRoot, target), 'utf8').catch(() => undefined)
    if (staged === undefined) {
      await fs.rm(absolute, { force: true })
    }
    else {
      await fs.mkdir(path.dirname(absolute), { recursive: true })
      await fs.writeFile(absolute, staged)
    }

    entries[entries.length - 1] = { ...entries[entries.length - 1]!, state: 'applied' }
    committed.push(target)
    input.faults?.commit?.()
  }
  return committed
}

/**
 * Restores every applied operation from its backup.
 *
 * The three outcomes are kept distinct on purpose. Claiming a clean rollback when a restore
 * itself failed would be the single most dangerous lie this system could tell.
 *
 * @param input the transaction input.
 * @param entries the journal entries recorded so far.
 * @returns the recovery outcome and the entries after restoration.
 */
async function recover(
  input: TransactionInput,
  entries: readonly JournalEntry[],
): Promise<{ readonly outcome: RecoveryOutcome, readonly detail?: string, readonly entries: readonly JournalEntry[] }> {
  const restored: JournalEntry[] = []
  let failures = 0
  let partial = false

  for (const entry of [...entries].reverse()) {
    if (entry.state !== 'applied') {
      restored.push(entry)
      continue
    }
    try {
      const absolute = await resolveInsideRepository(input.root, entry.target)
      if (entry.backup === undefined)
        await fs.rm(absolute, { force: true })
      else
        await fs.writeFile(absolute, await fs.readFile(entry.backup, 'utf8'))
      restored.push({ ...entry, state: 'reverted' })
    }
    catch {
      failures += 1
      partial = true
      restored.push(entry)
    }
  }

  if (failures > 0) {
    return {
      outcome: 'failed',
      detail: `${failures} target(s) could not be restored. Formal knowledge is not in a known-good state.`,
      entries: restored.reverse(),
    }
  }
  return {
    outcome: partial ? 'manual-recovery-required' : 'recovered',
    entries: restored.reverse(),
  }
}

/**
 * Verifies committed files match the reviewed candidate.
 *
 * This is read-only by contract. It does not reopen semantic design, and it does not overwrite
 * a concurrent modification that landed after the commit — it only reports the mismatch.
 *
 * @param input the transaction input.
 * @param candidateRoot absolute candidate root.
 * @param committed the committed repository-relative paths.
 * @returns mismatches, empty when the commit is intact.
 */
async function verify(
  input: TransactionInput,
  candidateRoot: string,
  committed: readonly string[],
): Promise<readonly string[]> {
  const issues: string[] = []
  for (const target of committed) {
    const staged = await fs.readFile(path.join(candidateRoot, target), 'utf8').catch(() => undefined)
    const live = await fs.readFile(await resolveInsideRepository(input.root, target), 'utf8').catch(() => undefined)
    if (staged === undefined && live === undefined)
      continue
    if (staged === undefined || live === undefined || digest(staged) !== digest(live))
      issues.push(`Committed "${target}" does not match the reviewed candidate.`)
  }
  return issues
}

/** @returns a terminal result carrying the journal recorded so far. */
function terminal(
  input: TransactionInput,
  reachedPhase: Phase,
  status: TransactionStatus,
  summary: string,
  issues: readonly string[],
  entries: readonly JournalEntry[],
  recovery?: Journal['recovery'],
  committed: readonly string[] = [],
): TransactionResult {
  return {
    status,
    runId: input.runId,
    reachedPhase,
    summary,
    issues,
    journal: {
      runId: input.runId,
      phase: recovery === undefined ? reachedPhase : 'recovery',
      operations: entries,
      ...(recovery === undefined ? {} : { recovery }),
    },
    committed,
  }
}

/**
 * Runs one formal knowledge transaction.
 *
 * Phase order is fixed and total. Nothing reaches `context/` before deterministic validation,
 * semantic review, and the concurrency check have all passed.
 *
 * @param input the transaction input.
 * @returns the transaction result, including the journal.
 */
export async function runTransaction(input: TransactionInput): Promise<TransactionResult> {
  const entries: JournalEntry[] = []
  const relativeRun = runDirectory(input.command, input.runId)
  const absoluteRun = path.join(input.root, relativeRun)

  try {
    input.faults?.snapshot?.()
    const snapshot = await takeSnapshot(input)

    await fs.mkdir(absoluteRun, { recursive: true })
    await fs.writeFile(path.join(absoluteRun, 'manifest.json'), stableJson({
      runId: input.runId,
      command: input.command,
      mode: input.mode,
      scope: input.scope,
      authorization: {
        source: input.authorization.source,
        ...(input.authorization.dryRun === undefined ? {} : { dryRun: input.authorization.dryRun }),
      },
      snapshot: {
        targets: [...snapshot.keys()].sort(compareCodeUnits).map(target => ({
          target,
          ...(snapshot.get(target) === undefined ? {} : { fingerprint: snapshot.get(target) as string }),
        })),
      },
    }))

    input.faults?.stage?.()
    const candidateRoot = await stageCandidate(input, absoluteRun)
    if (input.prepareLedger !== undefined) {
      const ledger = await input.prepareLedger(candidateRoot)
      await fs.writeFile(path.join(candidateRoot, META_PATH), stableJson(ledgerToJson(ledger)))
    }

    input.faults?.validate?.()
    const validationIssues = await input.validate(candidateRoot)
    if (validationIssues.length > 0)
      return terminal(input, 'validate', 'incomplete', 'The candidate failed deterministic validation.', validationIssues, entries)

    input.faults?.review?.()
    const verdict = await input.review(candidateRoot)
    if (!verdict.approved) {
      return terminal(input, 'review', 'incomplete', 'The candidate did not pass semantic review.', [
        verdict.reason ?? 'The reviewer did not approve the candidate.',
      ], entries)
    }

    input.faults?.['concurrency-check']?.()
    const conflicts: string[] = []
    for (const [target, recorded] of snapshot) {
      if (await fingerprintOf(input.root, target) !== recorded)
        conflicts.push(`"${target}" changed after the snapshot was taken.`)
    }
    if (conflicts.length > 0)
      return terminal(input, 'concurrency-check', 'incomplete', 'Concurrent modification detected; nothing was committed.', conflicts, entries)

    if (input.authorization.dryRun === true)
      return terminal(input, 'concurrency-check', 'success', 'Dry run completed; formal knowledge was not modified.', [], entries)

    const committed = await applyCommit(input, absoluteRun, candidateRoot, entries)

    input.faults?.verify?.()
    const mismatches = await verify(input, candidateRoot, committed)
    if (mismatches.length > 0)
      return terminal(input, 'verify', 'failed', 'Committed files do not match the reviewed candidate.', mismatches, entries, undefined, committed)

    return terminal(input, 'verify', 'success', `Committed ${committed.length} file(s).`, [], entries, undefined, committed)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : 'The transaction failed.'
    if (!entries.some(entry => entry.state === 'applied'))
      return terminal(input, 'stage', 'failed', 'The transaction failed before any formal file was modified.', [message], entries)

    const recovery = await recover(input, entries)
    return terminal(
      input,
      'commit',
      'failed',
      recovery.outcome === 'recovered'
        ? 'The commit failed and formal knowledge was fully restored.'
        : 'The commit failed and formal knowledge could not be fully restored.',
      [message, ...(recovery.detail === undefined ? [] : [recovery.detail])],
      recovery.entries,
      { outcome: recovery.outcome, ...(recovery.detail === undefined ? {} : { detail: recovery.detail }) },
    )
  }
}
