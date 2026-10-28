---
schema: plugydown.context.document/v1
id: package-context.capability-invocation
description: How each host locates the shared private Runtime and role index, per-capability inputs, the Git-evidence leaf, and transport versus Runtime status.
kind: reference
domain: package-context
relations:
  requires:
    - package-context
  related:
    - package-context.wire-contract
    - package-context.budgets-and-cursors
  supersedes:
    - runtime-protocol.capability-invocation
code:
  paths:
    - packages/context/src/runtime/cli.ts
    - packages/context/src/runtime/protocol.ts
    - packages/context/src/runtime/handler.ts
    - packages/context/src/runtime/queries.ts
    - packages/context/src/runtime/repository.ts
    - packages/context/src/skills/context/references/runtime.md
    - packages/context/aaplugin.config.ts
    - packages/context/README.md
    - packages/context/extension/internal-roles.ts
    - packages/context/src/skills/context/SKILL.md
---

# Capability invocation

The Runtime is a private Node ESM executable. One process, one JSON request on stdin, one JSON response on stdout.
Dispatch is `handleRequest` in `handler.ts`; the process adapter is `cli.ts`. Envelopes and legality-by-construction
are in `package-context.wire-contract`. Pagination rules are in `package-context.budgets-and-cursors`. Byte-stability
is in `package-context.determinism`. Transaction outcomes are in `package-context.outcomes-and-recovery`.

## Locate the executable

From the directory of the loaded Context `SKILL.md`, resolve `../../runtime/context/main.mjs`. The target must be a
regular, non-symlink file inside the complete installed delivery unit. Use Node.js 24 or later as `node` on PATH and
start it with the business repository root as `cwd`. **Do not pass the repository root in JSON** — `cli.ts` uses
`process.cwd()`.

| Host | Path source |
|---|---|
| Claude Code, Codex, Cursor, Pi | the loaded Skill's source directory |
| Antigravity CLI | the Skill source directory; if unavailable, locate the installed `context` Plugin with `agy plugin list --json` |
| OpenCode | the actual business repository root, then `.opencode/runtime/context/main.mjs` |

OpenCode places its Skills and Runtime together under `.opencode/`, so the same Skill-relative path still works.
Other hosts keep Runtime under the installation's `runtime/`. Do not assume Hook variables expand in Skill text or
an arbitrary shell. Keep the complete delivery unit, including Skills, Runtime, role resources, and licenses;
copying a Skill alone breaks these relative references.

`aaplugin.config.ts` explicitly declares only `runtime.entries.context`, targeting `cli.ts`. Other top-level Runtime
files are helpers, not executable entries. The key must never be `agents`: that sibling directory is reserved for
the role index and private resources.

Before invoking an Internal Role, read `../../runtime/agents/index.md` relative to the Skill. Claude Code, Cursor,
and OpenCode use its native Agent links; Codex, Antigravity CLI, and Pi read the linked private Markdown and execute the
Brief inline. Inline authorship and review are distinct roles but not independently executed Agents. Follow the
index's model/tool guidance and the Brief's write scope; native tool configuration does not enforce candidate-only
filesystem access or general network isolation. The Main Assistant retains final approval.

Every request carries `protocol: 'plugydown.context.runtime'`, `format: 1`, a `capability`, and `input`. Confirm both exit status
and stdout shape. Shipped `runtime.schema.json` describes the wire shape, and the test suite holds every Runtime response
and every accepted request to it; the code remains the final contract.

## Transport versus Runtime

These envelopes are disjoint. A caller that inspects only `status` will misread a malformed request as a knowledge
failure.

| Kind | Shape | Exit |
|---|---|---|
| Runtime response | `{protocol, format, capability, status, data?, cursor?, diagnostics?}` | 0 |
| Transport failure | `{transport:'plugydown.context.runtime.transport', format:1, status:'failed', diagnostics}` | 1 |

Only two codes reach the transport envelope: `REQUEST_SIZE_EXCEEDED` (stdin over 1 MiB) and `TRANSPORT_INVALID` (stdin
is not strict UTF-8, JSON that never parsed, or an unexpected non-`RuntimeFault` exception while handling the request).
Expected product failures use the Runtime envelope, with the status required by their failed, continuable or recovery
outcome. Transport failure is **not** a Runtime status.

## Closed capability set

`READ_CAPABILITIES` plus `transaction` in `protocol.ts`:

| Capability | Input |
|---|---|
| `repository.inspect` | optional `selectedDocumentIds` OR `migration: true` |
| `frontier.query` | required `depth` `1\|2\|3`; optional `selectors`, `requiresClosure` |
| `graph.validate` | `{}` — no `budget`, no `cursor` |
| `confirmation.check` | optional `scope` (repository default), `explain` (false default) |
| `delta.compute` | `gitEvidencePath`, `scope` |
| `growth.measure` | `{}` |
| `feedback.match` | `context`, `observedBehavior`, `outcomeOrCorrection`, `reuseBoundary` |
| `transaction` | required `action` `begin\|validate\|commit\|resume` |

`requiresClosure` is forbidden at depth 1. Depth 2 and 3 require a selector. `action` is required for `transaction` and
forbidden for everything else.

## Paging

`repository.inspect`, `frontier.query`, `confirmation.check`, `delta.compute`, `growth.measure`, and `feedback.match` accept `budget` and
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

Runtime never executes Git. Collect fixed HEAD and porcelain bytes in a uniquely owned `.scratch/evidence/<id>/` leaf:

```text
head.txt, mid-operation.json, status.bin, diff.bin?, comparison.json?
```

Use git rev-parse HEAD and git status --porcelain=v2 --branch -z --untracked-files=all. The untracked flag prevents a
collapsed `? dir/` result, which Runtime rejects. Check the actual Git operation state, writing exactly {"active":false}
or {"active":true,"kind":"merge|rebase|cherry-pick|revert|bisect"}, with one valid kind rather than the displayed alternatives.

Historical comparison is optional. Fix full base/head IDs, then collect git diff --name-status -z <base> <head>. Pair the
raw diff.bin with comparison.json containing exactly kind: two-tree, base and head; head must equal head.txt. Resolve
merge-base explicitly if it is the desired base. Recheck HEAD and operation state after collection; recollect if moved.

The two .bin files must not be line-split, trimmed or rewritten. Without diff/comparison, Delta reports
historyCoverage: not_provided, not "no changes". Confirmation matching needs no historical baseline or Git object access.

## Transaction actions

| Action | Input |
|---|---|
| `begin` | `command`, `mode`, `dryRun`, `scope`, `gitEvidencePath`, `evidencePaths`; may add `confirmedDocumentIds` or command-required `migrationStrategy` |
| `validate` | `runId` |
| `resume` | `runId`; may add `disposition: continue\|abandon` |
| `commit` | `runId` plus `approval: {approved:true, candidateFingerprint, sourceEvidenceFingerprint, summary}` |

Pass confirmedDocumentIds only for existing authorized Documents actually reviewed and still accurate. Update can
create their new confirmations without changing Markdown. Unlisted, unedited Documents receive no automatic new record;
being in scope is not semantic approval. A listed Document may still be edited if review uncovers a mistake.

Init, Prune and Migrate require Deep. Migrate requires repository scope and explicit import-trusted or reconfirm strategy;
no Recorder edits its candidate. evidencePaths is required but may be empty. Normal validation still reads all candidate
source declarations; a source-degraded Update can begin and correct those declarations in its candidate.

Validation returns candidateFingerprint and sourceEvidenceFingerprint, with a bounded confirmation summary containing
documentCount, newRecordCount and planFingerprint. Final semantic approval binds both fingerprints. Current metadata and
confirmation files are Runtime-owned, and Update never advances either baseline.

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
`manual_recovery` / `no_trusted_copy` are distinct — see `package-context.outcomes-and-recovery`. Never collapse them into a generic retry.

## Confirmation and migration consumers

Use confirmation.check for matched/unmatched/unavailable states and complete-snapshot summary counts. A successful
computation can still identify unconfirmed or unavailable inputs. Full-repository CI consumes every page and verifies
format, scope, counts and its explicit policy; graph.validate success alone does not establish confirmation matching.

Migrate is a one-time conversion, not a step after every rebase. It preserves old Markdown and baselines, imports only
eligible historical tuples under import-trusted, or imports none under reconfirm. Legacy unfinished reviews do not become
valid confirmations. Follow `package-context.migration-and-confirmation` and the installed Runtime reference.
