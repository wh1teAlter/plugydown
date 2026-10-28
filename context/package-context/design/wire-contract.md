---
schema: plugydown.context.document/v1
id: package-context.wire-contract
description: The two response envelopes, the closed capability and status sets, and how illegal status/field combinations are made unconstructible rather than validated.
kind: architecture
domain: package-context
relations:
  requires:
    - package-context
  related:
    - package-context
  supersedes:
    - runtime-protocol.wire-contract
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
protocol, format, capability, status, data?, cursor?, diagnostics?
```

A process that could not safely transport the request emits a **transport envelope** instead:

```
transport: 'plugydown.context.runtime.transport', format: 1, status: 'failed', diagnostics
```

These are disjoint. The transport envelope has no `protocol` and no `capability`, and it accompanies exit code 1. Only
two codes reach it: `REQUEST_SIZE_EXCEEDED` and `TRANSPORT_INVALID` (`cli.ts`). `TRANSPORT_INVALID` covers stdin that is
not strict UTF-8 or JSON that never parsed, and also any unexpected non-`RuntimeFault` exception that escapes the
handler. A RuntimeFault reaching handleRequest becomes a legal failed response. Transaction code can instead handle a known
fault as a continuable or recovery outcome; its status follows that outcome.

The consequence is a boundary that is easy to get wrong: a caller that treats "process exited nonzero" and "status is
failed" as the same condition will report a malformed request as a knowledge failure. The prose contract in
`packages/context/src/skills/context/references/runtime.md` tells hosts to check both.

## The closed capability set

Seven read capabilities plus one write capability. The list in `protocol.ts` is the single source of truth:

| Capability | Action | Input |
|---|---|---|
| `repository.inspect` | — | optional `selectedDocumentIds` OR `migration: true` |
| `frontier.query` | — | `depth: 1\|2\|3`, optional `selectors`, optional `requiresClosure` |
| `graph.validate` | — | exactly `{}` |
| `confirmation.check` | — | optional `scope`, `explain` |
| `delta.compute` | — | `gitEvidencePath`, `scope` |
| `growth.measure` | — | exactly `{}` |
| `feedback.match` | — | four non-empty strings |
| `transaction` | required `begin`\|`validate`\|`commit`\|`resume` | action-owned |

Begin accepts Update-only confirmedDocumentIds and Migrate-only migrationStrategy. Resume accepts optional disposition,
continue or abandon. Validate and commit accept only their required fields. The frozen manifest prevents changing a
run's scope, mode or evidence between phases.

Every request and Runtime response requires protocol `plugydown.context.runtime` and format: 1. Transport errors use
the same format under their separate fixed transport label. Unknown format, missing format or old `/v1` requests fail;
there is no silent semantic fallback. The compatibility generation is shared with metadata, locks, runs and cursors,
while package release versions remain separate.

`frontier.query` `selectors.codePaths` uses the same `sourcePattern` language as `scope.paths`.

`action` is required for `transaction` and forbidden for everything else. `budget` and `cursor` are accepted only by the
six paged capabilities; `graph.validate` and `transaction` reject them with `REQUEST_FIELD_INVALID`. That rejection is
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
The full outcome table is documented in `package-context.outcomes-and-recovery`.

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

## Commands and evidence vocabulary

Transaction commands are init, update, prune and migrate. Init/Prune/Migrate require Deep; Init/Migrate require repository
scope. Migrate requires explicit migrationStrategy, forbids confirmedDocumentIds and returns migration_staged with
nextAction validate. The new layout has no Repair command.

All commands accept an empty evidencePaths array. Normal transactions still bind every candidate Document's declared
source evidence. Migration binds historical conversion and only any sources explicitly supplied as evidencePaths; it
does not certify current source semantics. See `package-context.migration-and-confirmation`.

Keep evidence meanings distinct: raw Git bytes collected in a workflow-owned leaf; source declarations in code.paths and
evidencePaths; and the prose Evidence section of a Role Brief. taskEvidence is no longer an API field. A transaction
candidate is a complete staged tree; a growth candidate is a suggestion with no write authority.

Request parsing checks the top-level closed field set before protocol/format, so an unknown or missing field can precede
a protocol mismatch. handleRequest extracts the capability before parsing to identify known requested capabilities on
failure. A successful read describes completed computation, not a semantic approval or a passing CI policy.
