---
schema: plugydown.context.document/v1
id: authority-workflow.scratch-lifecycle
description: The five .scratch collections, their naming rules, the identity-hash convention, and who owns cleanup of each leaf at which terminal point.
kind: guide
domain: authority-workflow
relations:
  requires:
    - authority-workflow
  related:
    - write-plane.outcomes-and-recovery
code:
  paths:
    - packages/context/src/runtime/repository.ts
    - packages/context/README.md
---

# Scratch lifecycle

Temporary work lives in the business repository's own `.scratch/`. There is no plugin-side workspace — an installed plugin
writes into the repository it is operating on, using these five shapes and no others:

```text
.scratch/evidence/<evidence-id>/
.scratch/feedback/<slug>-<short-identity-hash>.md
.scratch/investigations/<slug>-<short-identity-hash>.md
.scratch/runs/<runtime-uuid>/
.scratch/locks/context-write/
```

The constants are in `packages/context/src/runtime/repository.ts`: `EVIDENCE_ROOT`, `FEEDBACK_ROOT`, `RUNS_ROOT`,
`LOCK_ROOT`.

## Naming rules

- Collections are lowercase and plural. The singleton lock is kebab-case.
- Run ids are Runtime-generated UUIDs. A caller never invents one; `parseRunId` rejects anything that is not a v4 UUID.
- Human Markdown names are an ASCII slug plus an 8-hex **stable identity hash**.
- **Never put a timestamp in a name or in contents.** Timestamps would break the determinism the rest of the product
  depends on.

### Identity hashes are not file hashes

This is the detail most often gotten wrong. The 8-hex suffix is a hash of a small set of normalized identifying fields,
not of the whole file:

- **Feedback** identity = its four matching fields (`Context`, `Observed behavior`, `Outcome or correction`,
  `Reuse boundary`), each NFKC-normalized, lowercased, and whitespace-collapsed. The `Evidence` section is deliberately
  excluded.
- **Investigation** identity = the Role Brief's goal, questions, and scope.

The point is that appending evidence to an existing file never forces a rename. The Feedback half of this is
machine-enforced: `feedbackMatch` recomputes the identity and fails with `FEEDBACK_IDENTITY_INVALID` if the filename does
not match. The Investigation half is prose only.

The shipped prose agrees: `packages/context/README.md`, `SKILL.md`, and `references/runtime.md` all write
`<short-identity-hash>` for both Feedback and Investigation filenames. A description that calls it a content hash is
wrong; follow the code.

## Runtime representation

| Collection | Runtime awareness |
|---|---|
| `evidence/` | full — path shape, exact file set, strict parsing, fingerprinting, cleanup |
| `runs/` | full — created, written, and removed by the transaction plane |
| `locks/` | full — created, classified, and removed by the transaction plane |
| `feedback/` | read and strictly validated by `feedback.match`; never written or deleted by the Runtime |
| `investigations/` | **none whatsoever** |

`.scratch/investigations/` is specified in `SKILL.md`, `references/runtime.md`, and `investigator.md`, and has zero
representation in the Runtime. No constant, no validation, no cleanup. Its naming rule, its identity derivation, and its
deletion are entirely a host responsibility with nothing checking any of it.

## Ownership of cleanup

The Runtime removes the evidence leaf, the run directory, and the lock together, on: `success`-bearing terminal outcomes,
`no_change`, `dry_run`, trusted-backup restoration, and safe pre-write failures. The full preserve-versus-clean table is
in `write-plane.outcomes-and-recovery`.

The host removes workflow-owned Investigation files at the same safe terminal point, and removes Feedback only after its
Reflection candidate has committed successfully, or when the user explicitly discards it. Unpromoted and
failed-promotion Feedback is kept for later use.

Three prohibitions, from `SKILL.md`:

- Never delete `.scratch/` itself.
- Never delete a collection root.
- Never delete unknown siblings.

The Runtime's own deletion helper enforces the spirit of this: `removeOwnedLeaf` refuses any leaf name that is not a
single fixed path segment, and validates that the parent is a real non-symlink directory before touching anything.

## Locks never expire

There is no timeout, no PID check, no archive, and no persistent report anywhere in this product. A lock goes away when
its own run reaches a terminal outcome, or when a human decides. On `manualRecoveryRequired` or `no_trusted_copy`, the
run, evidence, investigation files, and lock are all preserved and new writes are blocked until a human intervenes.

Deleting a foreign lock to unblock yourself destroys the only remaining evidence of what the other run was doing. Resume
it instead.

## Transport failure

A transport failure is not a status (see `runtime-protocol.wire-contract`). If a run was established, preserve it exactly
as found and stop. If no run was established, remove only this workflow's now-unused evidence or Investigation leaf. Never
present a transport failure as absent knowledge, no change, or success.
