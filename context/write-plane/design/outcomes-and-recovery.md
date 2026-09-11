---
schema: plugydown.context.document/v1
id: write-plane.outcomes-and-recovery
description: Every transaction outcome, its status and next action, what the caller must do, and which artifacts are preserved versus cleaned.
kind: architecture
domain: write-plane
relations:
  requires:
    - write-plane
    - write-plane.transaction-lifecycle
---

# Transaction outcomes and recovery

Outcomes are distinct results, never one generic retry. Each maps to exactly one status and at most one `nextAction`, via
`TRANSACTION_SHAPES` in `protocol.ts`. A caller that collapses them will either lose work or wedge the repository.

## The complete table

| Outcome | Status | nextAction | Meaning | Do this |
|---|---|---|---|---|
| `staged` | success | `edit_candidate` | candidate tree exists and is yours | write the complete candidate |
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
is fine. Reporting it as success would hide that no knowledge change landed.

## Artifacts: preserved versus cleaned

`cleanupTerminalArtifacts` removes three things together — the Git evidence leaf, the lock, and the whole run directory.
It runs *after* the response value is built, so the response always describes the state the caller can act on.

**Cleaned** on: `committed`, `candidate_completed`, `abandoned`, `no_change`, `validated` (dry run), `backup_restored`,
`snapshot_stale`, and `mechanical_failure`.

**Preserved** on: `staged`, `ready_for_review`, `candidate_edit_required`, `candidate_stale`, `approval_mismatch`,
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

`no_trusted_copy` is reserved for the case where *no* directory holds a valid tree. It is the one outcome that says the
Runtime cannot tell you where your knowledge is.

## Resume

`transaction.resume` re-acquires the lock only if it is absent; a foreign lock yields `active_run` or `manual_recovery`.
Then it dispatches on phase: `staged` re-stages a missing candidate, `validated` re-proves and returns
`ready_for_review` (or `candidate_stale`), `committing` and `recovery_required` enter `recoverCommitting`, and terminal
phases re-prove their recorded outcome against current directory facts before cleaning up.

`disposition: 'abandon'` works only from `staged` or `validated` (`TRANSACTION_ABANDON_INVALID`), and refuses if a backup
leaf already exists — that would mean the switch had begun.

Note the schema drift here: `public/schemas/runtime.schema.json` documents `disposition` for resume, but that schema is
not validated anywhere. See `delivery.verification-and-gaps`.
