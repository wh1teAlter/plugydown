---
schema: plugydown.context.document/v1
id: runtime-protocol.capability-invocation
description: How to locate and call the private Runtime, per-capability inputs, the Git-evidence leaf, and how to tell a transport failure from a Runtime status.
kind: reference
domain: runtime-protocol
relations:
  requires:
    - runtime-protocol
  related:
    - runtime-protocol.wire-contract
    - runtime-protocol.budgets-and-cursors
code:
  paths:
    - packages/context/src/runtime/cli.ts
    - packages/context/src/runtime/protocol.ts
    - packages/context/src/runtime/handler.ts
    - packages/context/src/runtime/queries.ts
    - packages/context/src/runtime/repository.ts
    - packages/context/src/skills/context/references/runtime.md
    - packages/context/aaplugin.config.ts
---

# Capability invocation

The Runtime is a private Node ESM executable. One process, one JSON request on stdin, one JSON response on stdout.
Dispatch is `handleRequest` in `handler.ts`; the process adapter is `cli.ts`. Envelopes and legality-by-construction
are in `runtime-protocol.wire-contract`. Pagination rules are in `runtime-protocol.budgets-and-cursors`. Byte-stability
is in `runtime-protocol.determinism`. Transaction outcomes are in `write-plane`.

## Locate the executable

From the directory of the loaded Context `SKILL.md`, resolve `../../runtime/context/main.mjs`. The target must be a
regular, non-symlink file inside the installed plugin. Start it with the business repository root as `cwd`. **Do not
pass the repository root in JSON** — `cli.ts` uses `process.cwd()`. The `aaplugin.config.ts` runtime entry key `context`
produces `runtime/context/main.mjs`; that key must never be `agents` (Codex roles live at `runtime/agents/`).

Every request carries `protocol: 'plugydown.context.runtime/v1'`, a `capability`, and `input`. Confirm both exit status
and stdout shape. Shipped `runtime.schema.json` describes the wire shape, and the test suite holds every Runtime response
and every accepted request to it; the code remains the final contract.

## Transport versus Runtime

These envelopes are disjoint. A caller that inspects only `status` will misread a malformed request as a knowledge
failure.

| Kind | Shape | Exit |
|---|---|---|
| Runtime response | `{protocol, capability, status, data?, cursor?, diagnostics?}` | 0 |
| Transport failure | `{transport:'plugydown.context.runtime.transport/v1', status:'failed', diagnostics}` | 1 |

Only two codes reach the transport envelope: `REQUEST_SIZE_EXCEEDED` (stdin over 1 MiB) and `TRANSPORT_INVALID` (stdin
is not strict UTF-8, JSON that never parsed, or an unexpected non-`RuntimeFault` exception while handling the request).
Everything else, including every product-level failure, is a Runtime response with `status: 'failed'`. Transport
failure is **not** a Runtime status.

## Closed capability set

`READ_CAPABILITIES` plus `transaction` in `protocol.ts`:

| Capability | Input |
|---|---|
| `repository.inspect` | optional `selectedDocumentIds` |
| `frontier.query` | required `depth` `1\|2\|3`; optional `selectors`, `requiresClosure` |
| `graph.validate` | `{}` — no `budget`, no `cursor` |
| `delta.compute` | `gitEvidencePath`, `scope`, `taskEvidence` (four booleans) |
| `growth.measure` | `{}` |
| `feedback.match` | `context`, `observedBehavior`, `outcomeOrCorrection`, `reuseBoundary` |
| `transaction` | required `action` `begin\|validate\|commit\|resume` |

`requiresClosure` is forbidden at depth 1. Depth 2 and 3 require a selector. `action` is required for `transaction` and
forbidden for everything else.

## Paging

`repository.inspect`, `frontier.query`, `delta.compute`, `growth.measure`, and `feedback.match` accept `budget` and
`cursor`. `graph.validate` and `transaction` reject them. Defaults: 100 items / 262144 bytes / 32000 estimated tokens.
Maxima: 1000 / 1048576 / 128000.

## Scope

Exactly one of:

| Kind | Shape |
|---|---|
| `repository` | `{kind:'repository'}` |
| `domains` | `{kind:'domains', ids:[…]}` |
| `documents` | `{kind:'documents', ids:[…]}` |
| `paths` | `{kind:'paths', paths:[…]}` |

## Git evidence leaf

The host collects Git bytes. The Runtime does not run Git.

```
.scratch/evidence/<id>/head.txt, mid-operation.json, status.bin, diff.bin?
```

From the business repository root:

```sh
git rev-parse HEAD > "$evidence_dir/head.txt"
git status --porcelain=v2 --branch -z --untracked-files=all > "$evidence_dir/status.bin"
git diff --name-status -z "$baseline"...HEAD > "$evidence_dir/diff.bin"
```

`--untracked-files=all` is required. Git's default collapses a new untracked directory to a `? dir/` record, hiding which
files are new, and the Runtime refuses it with `GIT_STATUS_UNTRACKED_COLLAPSED`.

`mid-operation.json` is exactly `{"active":false}` or
`{"active":true,"kind":"merge|rebase|cherry-pick|revert|bisect"}`. Supply `diff.bin` only when the ledger baseline
differs from HEAD **and** `git cat-file -e "$baseline^{commit}"` succeeds; a baseline commit orphaned by a squash merge
may never have been fetched into this clone. Otherwise omit it: `delta.compute` then reports
`changedPathsComplete: false` (changed and unreferenced paths cover only the working tree) while `directImpact` stays
complete, and the missing history blocks neither Light nor the baseline. The two `.bin` files are NUL-delimited and must
not be decoded, line-split, trimmed, or rewritten.

## Transaction actions

| Action | Input |
|---|---|
| `begin` | `command`, `mode`, `dryRun`, `scope`, `gitEvidencePath`, `evidencePaths`; may add `reaffirmedDocumentIds` |
| `validate` | `runId` |
| `resume` | `runId`; may add `disposition: continue\|abandon` |
| `commit` | `runId` plus `approval: {approved:true, candidateFingerprint, sourceEvidenceFingerprint, summary}` |

Pass `reaffirmedDocumentIds` when a declared source moved but you re-read the Document and it is still correct. Without
it there is no way to settle that ledger: no Markdown edit means no refresh, so with nothing else edited `validate`
answers `no_change` while `graph.validate` keeps succeeding with a `DOCUMENT_REVIEW_PENDING` warning for it. An accurate
Document you do not pass stays pending: it remains in later `directImpact` results and holds the repository baseline
where it is. Pass only Documents you actually reviewed. `update` only, and every id must exist and sit inside the
authorized scope. Listing a Document does not commit you to leaving it alone — edit it if review says so, and it
refreshes anyway.

## Statuses

`success | no_change | dry_run | incomplete | failed`. Transport failure is not one of these.

| Status | Host action |
|---|---|
| `success` | use the complete result |
| `no_change` | formal bytes unchanged; run already cleaned |
| `dry_run` | validation without a formal write; cleaned; cannot resume |
| `incomplete` | follow only the returned cursor, `nextAction`, active run, evidence, authorization, review, or recovery need |
| `failed` | stop; if `manualRecoveryRequired`, preserve named leaves and lock |

Outcomes such as `candidate_edit_required`, `candidate_stale`, `approval_mismatch`, `active_run`, `snapshot_stale`,
`manual_recovery` / `no_trusted_copy` are distinct — see `write-plane`. Never collapse them into a generic retry.
