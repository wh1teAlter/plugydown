---
schema: plugydown.context.document/v1
id: write-plane.transaction-lifecycle
description: The four transaction actions, seven phases, the type-enforced manifest, the directory lock and its classification, candidate staging, and the two-rename atomic switch.
kind: architecture
domain: write-plane
relations:
  requires:
    - write-plane
  related:
    - runtime-protocol.determinism
code:
  paths:
    - packages/context/src/runtime/transaction.ts
---

# Transaction lifecycle

## Four actions

| Action | Input | Purpose |
|---|---|---|
| `begin` | `command`, `mode`, `dryRun`, `scope`, `gitEvidencePath`, `evidencePaths` | acquire the lock, snapshot reality, stage a candidate |
| `validate` | `runId` | prove the candidate, derive Meta, produce the two fingerprints |
| `commit` | `runId`, `approval` | re-prove, switch directories, verify |
| `resume` | `runId`, optional `disposition` | continue or abandon an existing run |

`validate` and `resume` take nothing but `runId` (plus `disposition`). The Runtime holds all other state in the manifest,
so a caller cannot change the terms of a run midway.

## Seven phases

```
staged → validated → committing → committed
                          ↓
              restored | recovery_required | failed
```

Phase lives in `.scratch/runs/<run-id>/manifest.json`. The manifest type is a **discriminated union on phase**, so which
of `candidateFingerprint`, `sourceEvidenceFingerprint`, `approval`, and `recovery` may appear is enforced by the type
system rather than by a parallel validation matrix. `parseManifest` re-proves every one of those combinations on read,
which is what makes a hand-edited or truncated manifest fail rather than mislead. Examples of what it rejects:

- a `staged` manifest carrying any fingerprint, approval, or recovery fact
- a `validated` manifest carrying an approval
- an approval whose fingerprints do not equal the manifest's own validated pair
- a `dryRun: true` manifest in any phase past `validated`
- `snapshot.contextState: 'present'` without `contextFingerprint`, or vice versa
- a `committing` restore intent when the snapshot recorded no live Context to restore

## The lock

`.scratch/locks/context-write/` — a directory created by plain `fs.mkdir`, which is atomic. `EEXIST` means the lock
belongs to someone else. Inside it, `owner.json` holds exactly `{schema: 'plugydown.context.lock/v1', runId}`.

`classifyLock` produces four facts:

| Fact | Meaning | Response |
|---|---|---|
| `absent` | free | proceed |
| `valid` | owner readable and its manifest loads with a matching id | `active_run` (or proceed if it is our own run) |
| `corrupt` | not a directory, or `owner.json` unreadable or wrong shape | `manual_recovery` |
| `orphan` | owner valid but its manifest is missing or unreadable | `manual_recovery`, carrying the runId |

A lock is never expired by time or PID. There is no timeout anywhere. The only ways it goes away are a terminal cleanup
by its own run, or a human deciding.

### Lock-owner validation

`readLockOwner` in `repository.ts` is the single implementation. Call sites: `queries.ts` `activeRun`; `transaction.ts`
`classifyLock` and `releaseLock`. `LOCK_SCHEMA` is `plugydown.context.lock/v1` and lives in `repository.ts`.

Valid: the lock path is a directory, `owner.json` is a record with **exactly two keys**, `schema === LOCK_SCHEMA`, and
`runId` is a UUID v4 (`[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}`). Absent: the path is
missing. Corrupt: not a directory, parse/IO/`RuntimeFault`, extra or missing keys, wrong schema, or a bad UUID.
`classifyLock` then maps a valid owner plus a missing, unreadable, or mismatched manifest to `orphan`. A lock owner
that is missing `schema` or carries an extra key is `WRITE_LOCK_INVALID` from `repository.inspect` and is not an
`activeRun`.

## Staging the candidate

The candidate lives at `.scratch/runs/<run-id>/candidate/context/`.

- `init` stages an **empty** directory. There is nothing to copy.
- `update` and `prune` `fs.cp` the live `context/` tree with `errorOnExist: true`, `force: false`,
  `preserveTimestamps: false`.

`begin` preconditions, from `validateBeginMode`:

- `init` — must be `deep`, must be `repository` scope, requires `formalState: absent`
- `update` — requires `formalState: ready`
- `prune` — must be `deep`, requires `formalState: ready` **and** `sourceState: ready`

Prune's extra source requirement exists because it is the only command that can *remove* knowledge, and removing coverage
you cannot currently see would be unaccountable.

Note that `mode` is otherwise inert; see `read-plane.delta-and-light`.

## The snapshot

`begin` records: whether live Context was absent or present plus its fingerprint, the declared-evidence fingerprint (from
expanding `evidencePaths`), the Git evidence fingerprint, and the Git revision.

`assertPreSwitchSnapshotFresh` re-proves all three before every consequential step — during validate, before commit,
during resume, and inside recovery. Each has its own failure: `FORMAL_CONTEXT_CONFLICT`, `DECLARED_EVIDENCE_CONFLICT`,
`GIT_EVIDENCE_CONFLICT`. All three collapse to the `snapshot_stale` outcome.

## Validate

`transaction.validate` runs a long sequence, each step of which can only produce a legal outcome:

1. require phase `staged` or `validated`; require the lock to be ours
2. re-prove the snapshot
3. load the candidate with `ignoreMeta: true, requireMeta: false` — the candidate has no Meta yet, so demanding one would
   be circular
4. if the candidate is not `ready`, return `candidate_edit_required` with its diagnostics
5. expand candidate source; issues → `candidate_edit_required`
6. compute authorized Documents and reject out-of-scope mutations (`CANDIDATE_SCOPE_VIOLATION`)
7. for `prune`, require live `sourceState: ready` and no lost coverage (`PRUNE_COVERAGE_LOST`)
8. derive Meta and write it into the candidate
9. **reload the candidate with Meta required** and re-expand source. If the recomputed source evidence fingerprint
   differs from step 5's, the source moved mid-validation → `candidate_edit_required` with `CANDIDATE_SOURCE_STALE`
10. re-prove the snapshot once more, then record `phase: validated` with the two fingerprints

Step 9 is the subtle one: validation reads the world twice and refuses to certify a candidate whose source shifted
between the reads.

Two terminal shortcuts: if the candidate fingerprint equals the live snapshot fingerprint, the outcome is `no_change` and
artifacts are cleaned. If `dryRun`, the outcome is `validated` and artifacts are cleaned — a dry run can never become a
real commit.

Re-validating always rebuilds the manifest from base facts plus the two fresh fingerprints, discarding any prior approval
and recovery fact. There is no path by which an old approval survives a re-validation.

## Commit and the atomic switch

`transaction.commit` requires phase `validated`, so it loads the manifest first. It then checks the lock **before the
candidate or any source read**, so a foreign owner is never masked by a candidate error belonging to another run — the
source comment states exactly this. Then it re-proves the snapshot, recomputes the candidate
and source fingerprints, compares them to the manifest, checks the approval against those recomputed facts, re-checks the
lock, and only then writes `phase: committing`.

`directorySwitch` performs two renames:

1. live `context/` → `.scratch/runs/<run-id>/backup/context` (skipped when the snapshot said absent)
2. candidate → live `context/`

Then `finalizeCommitted` re-proves: the live tree fingerprint must equal the approved candidate fingerprint, and the tree
must load as `ready` with that same fingerprint. Failure is `FINAL_VERIFICATION_FAILED`, which routes into recovery.

The candidate tree fingerprint is computed with paths rewritten to a canonical `context/` prefix (see
`runtime-protocol.determinism`), which is why the fingerprint survives the rename unchanged.

If the switch or verification throws, `recoverCommitting` reads live, candidate, and backup tree facts and decides among
completing, restoring, and stopping. Those decisions are enumerated in `write-plane.outcomes-and-recovery`.
