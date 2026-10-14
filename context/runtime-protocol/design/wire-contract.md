---
schema: plugydown.context.document/v1
id: runtime-protocol.wire-contract
description: The two response envelopes, the closed capability and status sets, and how illegal status/field combinations are made unconstructible rather than validated.
kind: architecture
domain: runtime-protocol
relations:
  requires:
    - runtime-protocol
  related:
    - write-plane
code:
  paths:
    - packages/context/src/runtime/protocol.ts
    - packages/context/src/runtime/cli.ts
    - packages/context/src/runtime/handler.ts
    - packages/context/public/schemas/runtime.schema.json
---

# Wire contract

## Two envelopes, not one

A successful process emits a **Runtime response**:

```
protocol, capability, status, data?, cursor?, diagnostics?
```

A process that could not safely transport the request emits a **transport envelope** instead:

```
transport: 'plugydown.context.runtime.transport/v1', status: 'failed', diagnostics
```

These are disjoint. The transport envelope has no `protocol` and no `capability`, and it accompanies exit code 1. Only
two codes reach it: `REQUEST_SIZE_EXCEEDED` and `TRANSPORT_INVALID` (`cli.ts`). `TRANSPORT_INVALID` covers stdin that is
not strict UTF-8 or JSON that never parsed, and also any unexpected non-`RuntimeFault` exception that escapes the
handler. Every `RuntimeFault` — every product-level failure — comes back inside a legal Runtime response with
`status: 'failed'`.

The consequence is a boundary that is easy to get wrong: a caller that treats "process exited nonzero" and "status is
failed" as the same condition will report a malformed request as a knowledge failure. The prose contract in
`packages/context/src/skills/context/references/runtime.md` tells hosts to check both.

## The closed capability set

Six read capabilities plus one write capability. The list in `protocol.ts` is the single source of truth:

| Capability | Action | Input |
|---|---|---|
| `repository.inspect` | — | optional `selectedDocumentIds` |
| `frontier.query` | — | `depth: 1\|2\|3`, optional `selectors`, optional `requiresClosure` |
| `graph.validate` | — | exactly `{}` |
| `delta.compute` | — | `gitEvidencePath`, `scope`, `taskEvidence` |
| `growth.measure` | — | exactly `{}` |
| `feedback.match` | — | four non-empty strings |
| `transaction` | required `begin`\|`validate`\|`commit`\|`resume` | action-owned |

Two `transaction` actions have an optional input field. `begin` takes `reaffirmedDocumentIds`, a unique list of Document
ids; `resume` takes `disposition`, `continue` or `abandon`. The inputs of `validate` and `commit` are exactly their
required set, which together with the frozen manifest is what keeps a run's terms unchangeable once `begin` has recorded
them.

`frontier.query` `selectors.codePaths` uses the same `sourcePattern` language as `scope.paths`.

`action` is required for `transaction` and forbidden for everything else. `budget` and `cursor` are accepted only by the
five paged capabilities; `graph.validate` and `transaction` reject them with `REQUEST_FIELD_INVALID`. That rejection is
deliberate: those two produce a whole-or-nothing answer, so a partial page would be a lie.

## Statuses and legality by construction

`RuntimeStatus` is `success | no_change | dry_run | incomplete | failed`. `no_change` and `dry_run` are transaction-only;
reads use the other three.
`runtimeResponse()` throws a `TypeError` — not a diagnostic — when a read capability tries to build an illegal
combination:

- `failed` requires diagnostics and forbids `data` and `cursor`
- `success` requires `data` and forbids `cursor`
- `incomplete` requires both `data` and `cursor`
- `no_change` and `dry_run` are unreachable for reads

For transactions the same discipline is applied by types instead of runtime checks. `TransactionOutcome` is a
discriminated union in which each variant carries exactly the fields its outcome permits, and `TRANSACTION_SHAPES` maps
each outcome name to its one legal status plus derived fields such as `nextAction` and `manualRecoveryRequired`. A
caller therefore cannot receive, say, `committed` without `contextFingerprint`, because there is no way to construct it.
The full outcome table is documented in `write-plane`.

## Failures are values

`RuntimeFault` (in `protocol.ts`) is the product-level failure carrier: a code, a message, and an optional repository
path. `handleRequest` catches it and converts it to a `failed` response; anything that is *not* a `RuntimeFault` is
rethrown, and `cli.ts` reports it as the transport failure `TRANSPORT_INVALID` with a non-zero exit and no detail
leaked. (`failureResponse` in `protocol.ts` still has an `INTERNAL_ERROR` branch for such errors, but `handleRequest` never
routes one to it.) This split is the reason an unexpected bug cannot masquerade as a well-understood domain failure.

## Diagnostics are sanitized, bounded, and ordered

`sortDiagnostics` is not cosmetic. It:

- replaces control characters and DEL with spaces, trims, and truncates code (128) and message (512) to a character limit
- drops a `path` entirely unless it is a safe repository-relative path — a path over 1024 characters or changed by that
  cleaning, and any absolute, backslashed, drive-lettered, variable-bearing (`$`, `%VAR%`), `~`-bearing, or dot-segment
  path, becomes absent rather than truncated or disclosed
- sorts by `code\0path\0message` under code-unit comparison
- caps the list at 100, replacing the tail with one `DIAGNOSTICS_OMITTED` warning

The path filter is intentionally duplicated from `repository.ts` rather than shared, because `repository.ts` imports
`protocol.ts` and sharing would create an import cycle. The comment in the source states the rule: this final wire
filter must never be the weaker of the two. Anyone editing one must edit the other.

## Identifier grammar on the wire

Domain ids match `^[a-z0-9]+(-[a-z0-9]+)*$`; Document ids are dot-separated runs of that same shape. Fingerprints must
be 64 lowercase hex characters. `runId` must be a v4 UUID — the Runtime rejects any id it did not generate the shape of.
These are checked at parse time, so downstream code never handles a malformed identifier.
