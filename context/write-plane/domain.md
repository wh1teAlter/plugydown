---
schema: plugydown.context.document/v1
id: write-plane
description: The staged single-writer transaction that owns every mutating filesystem call — phases, locking, candidate staging, scope authorization, approval binding, and the atomic switch.
kind: domain
domain: write-plane
relations:
  requires:
    - knowledge-model
    - repository-access
  related:
    - read-plane.delta-and-light
---

# Write plane

Every write in this product happens inside one transaction implemented in
`packages/context/src/runtime/transaction.ts`. All 15 mutating filesystem calls in the Runtime live in that one file.
Live `context/` is never edited in place by anyone — not by a role, not by the Runtime. It is replaced by a rename.

## Why this Domain exists

Formal knowledge is the thing this product exists to protect. A partially written Context is worse than no Context,
because a reader cannot tell the difference. So the write path is built so that at every instant, some directory on disk
holds a complete valid tree, and a crash at any point leaves enough evidence to decide which one.

## What lives here

- `write-plane.transaction-lifecycle` — the four actions, seven phases, the lock, and the atomic switch.
- `write-plane.outcomes-and-recovery` — every outcome, what it means, what the caller must do, and which artifacts
  survive.
- `write-plane.scope-authorization` — how scope authorizes Documents rather than actors, and the ledger-refresh rule.

## Invariants

- **Single writer.** A directory lock at `.scratch/locks/context-write/` is created with `mkdir`, which is atomic. A
  second writer sees `EEXIST` and never proceeds.
- **The Runtime is role-blind.** Scope authorizes *Documents*, never identities. Nothing in the Runtime knows what an
  Investigator or a Recorder is.
- **Approval is bound to bytes.** A commit requires `approved: true` plus both 64-hex fingerprints, and they must still
  match recomputed reality. Re-validating discards any earlier approval unconditionally.
- **Intent is persisted before destruction.** The restore intent reaches disk before the destructive rename, so a crash
  between them resumes into the restore branch instead of being misread as a completed switch.
- **The switch is re-proved after the fact.** Post-rename, the committed tree is loaded again and its fingerprint
  compared to the approved one; a mismatch is `FINAL_VERIFICATION_FAILED`.
- **Nothing recovers by deleting someone else's lock.** A foreign lock always produces `active_run` or `manual_recovery`.

## Known limitation: concurrency is tested, not stress-tested

Correctness rests on `mkdir` atomicity. The test suite exercises it by hand-writing rival lock files; it never runs two
real concurrent processes. On a filesystem where directory creation is not atomic — notably some network filesystems —
the single-writer guarantee is unproven. Nothing in the code detects or warns about that.
