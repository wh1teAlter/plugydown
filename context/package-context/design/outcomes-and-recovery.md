---
schema: plugydown.context.document/v1
id: package-context.outcomes-and-recovery
description: Every transaction outcome, its status and next action, what the caller must do, and which artifacts are preserved versus cleaned.
kind: architecture
domain: package-context
relations:
  requires:
    - package-context.transaction-lifecycle
    - package-context
  supersedes:
    - write-plane.outcomes-and-recovery
code:
  paths:
    - packages/context/src/runtime/protocol.ts
    - packages/context/src/runtime/transaction.ts
---

# Transaction outcomes and recovery

Outcomes are distinct results, never one generic retry. Each maps to exactly one status and at most one `nextAction`, via
`TRANSACTION_SHAPES` in `protocol.ts`. A caller that collapses them will either lose work or wedge the repository.

## The complete table

| Outcome | Status | nextAction | Meaning | Do this |
|---|---|---|---|---|
| `staged` | success | `edit_candidate` | candidate tree exists and is yours | write the complete candidate |
| `repair_staged` | success | `validate` | Runtime derives the repair ledger | validate without editing the candidate |
| `ready_for_review` | success | `semantic_review` | candidate validated, fingerprints returned | review, then approve and commit |
| `validated` | dry_run | — | dry run proved the candidate | report; run is already cleaned, cannot resume |
| `no_change` | no_change | — | candidate bytes equal live bytes | report; run is already cleaned |
| `committed` | success | — | live Context replaced and re-verified | report the returned fingerprints |
| `candidate_completed` | success | — | recovery found the switch had already succeeded | same as committed |
| `abandoned` | success | — | staged or validated run discarded on request | report |
| `candidate_edit_required` | incomplete | `edit_candidate` | candidate is repairable in place | fix the candidate, validate again |
| `candidate_stale` | incomplete | `validate` | candidate or source changed after validation | validate again, then get a fresh review |
| `approval_mismatch` | incomplete | `semantic_review` | approval not bound to current bytes | review again, approve current fingerprints |
| `active_run` | incomplete | `resume` | another run owns the lock | resume that run; never delete its lock |
| `manual_recovery` | incomplete | — (`manualRecoveryRequired: true`) | copies conflict | stop, preserve everything, ask a human |
| `snapshot_stale` | failed | `restart_transaction` | formal, Git, or declared evidence moved | collect evidence, begin anew |
| `backup_restored` | failed | — | live Context was restored from the trusted backup | report the failure; the tree is intact |
| `no_trusted_copy` | failed | — (`manualRecoveryRequired: true`) | no trustworthy copy exists | stop, preserve everything, human recovery |
| `mechanical_failure` | failed | — | a filesystem operation failed | inspect diagnostics, retry from the start |

Note that `backup_restored` carries status `failed` even though recovery worked. The *transaction* failed; the repository
has returned to its original snapshot. For Repair, that snapshot can still contain content fingerprint mismatches;
REPAIR_ROLLED_BACK makes the outstanding failure explicit. Reporting it as success would hide that no repair landed.

## Artifacts: preserved versus cleaned

`cleanupTerminalArtifacts` removes three things together — the Git evidence leaf, the lock, and the whole run directory.
It runs *after* the response value is built, so the response always describes the state the caller can act on.

**Cleaned** on: `committed`, `candidate_completed`, `abandoned`, `no_change`, `validated` (dry run), `backup_restored`,
`snapshot_stale`, and `mechanical_failure` — with one qualification for `begin`. How much a failed `begin` removes depends
on how far it got. If acquiring the lock fails, the Runtime removes the lock leaf and the evidence leaf. If it fails after
the lock is held but before the run's manifest value exists, only the lock is released: it references no recoverable run,
and releasing it avoids wedging the repository behind an owner whose manifest can never be read. The Runtime does not
remove the evidence leaf in that case. Once the manifest exists, an expected fault takes the full cleanup above.

**Preserved** on: `staged`, `repair_staged`, `ready_for_review`, `candidate_edit_required`, `candidate_stale`, `approval_mismatch`,
`active_run`, `manual_recovery`, `no_trusted_copy`.

The two that most often surprise people:

- `candidate_edit_required` **preserves** the candidate. That is the whole point — you are meant to edit it and validate
  again. Nothing is lost.
- `snapshot_stale` **cleans** everything, including your candidate. The world moved under the run, so the candidate was
  authored against facts that no longer hold. Collect fresh evidence and begin a new transaction; there is nothing to
  salvage.

`manual_recovery` and `no_trusted_copy` set `manualRecoveryRequired: true` and keep the run, evidence, lock, and every
directory copy. They block all new writes until a human intervenes. Do not delete anything to "unstick" them; the
preserved copies are the only remaining evidence of what happened.

## Crash safety

The ordering that makes recovery decidable:

1. Restore intent (`recovery: {intent: 'restore_backup'}`, phase `committing`) is written to disk **before** the
   destructive rename. A crash in between resumes into `restoreBackup` rather than being read as a completed switch.
2. `manualRecovery` never overwrites a pending restore intent — a later resume still needs it to finish the idempotent
   restore.
3. Restoration is idempotent: if live already matches the snapshot and the backup is gone, it reports `backup_restored`
   without touching anything.

`recoverCommitting` decides from three tree facts (live, candidate, backup):

- restore intent present → `restoreBackup`
- live already equals the approved candidate → `candidate_completed`
- live equals the snapshot, candidate is intact, backup absent → re-prove and retry the switch, or `candidate_stale`
- live absent or invalid and backup is trustworthy → `restoreBackup`
- otherwise → `manual_recovery` if any copy is valid, else `no_trusted_copy`

TreeFact valid means a safe, readable directory with a computed fingerprint, not graph.validate success. Snapshot and
candidate trust require exact fingerprint matches. If no readable directory copy remains, recovery reports
no_trusted_copy; conflicting readable copies instead require manual recovery. A mismatched-but-original Repair backup
is still trustworthy for rollback, without becoming structurally ready.

## Resume

`transaction.resume` re-acquires the lock only if it is absent; a foreign lock yields `active_run` or `manual_recovery`.
Then it dispatches on phase: `staged` re-stages a missing candidate, `validated` re-proves and returns
`ready_for_review` (or `candidate_stale`), `committing` and `recovery_required` enter `recoverCommitting`, and terminal
phases re-prove their recorded outcome against current directory facts before cleaning up.

`disposition: 'abandon'` works only from `staged` or `validated` (`TRANSACTION_ABANDON_INVALID`), and refuses if a backup
leaf already exists — that would mean the switch had begun.
