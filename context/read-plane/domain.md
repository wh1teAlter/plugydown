---
schema: plugydown.context.document/v1
id: read-plane
description: The six read capabilities, their preconditions, and the guarantee that reading and analysis perform zero writes.
kind: domain
domain: read-plane
relations:
  requires:
    - knowledge-model
  related:
    - runtime-protocol.budgets-and-cursors
code:
  paths:
    - packages/context/src/runtime/queries.ts
---

# Read plane

Six capabilities answer questions about the repository without changing anything. Implemented in
`packages/context/src/runtime/queries.ts` (five of them) and `delta.ts` (`delta.compute`).

## The zero-write guarantee

All 15 mutating filesystem calls in the Runtime live in `transaction.ts`. Neither `queries.ts` nor `delta.ts` nor
`graph.ts` nor `repository.ts` writes, creates, renames, or removes anything. A read capability cannot corrupt a
repository even when it fails partway through, and a caller never needs to consider recovery after a read.

## What lives here

- `read-plane.capabilities` — the six capabilities, their preconditions, and the depth 1/2/3 projection.
- `read-plane.delta-and-light` — how change impact is computed and why Light eligibility is advisory.

## Preconditions differ, deliberately

| Capability | Requires ready Context? |
|---|---|
| `repository.inspect` | no — reporting absence is its job |
| `feedback.match` | tolerates absent; fails only on invalid |
| `frontier.query` | yes |
| `growth.measure` | yes |
| `delta.compute` | yes |
| `graph.validate` | yes, plus ready source and no ledger drift |

The two permissive ones are the entry points. Everything that returns knowledge refuses to answer from a damaged tree
rather than returning a partial view, because a partial view of knowledge is indistinguishable from complete knowledge to
a reader who did not ask.

## The reading ladder

The prose workflow in `packages/context/src/skills/context/SKILL.md` prescribes a progressive ladder — inspect, then
depth 1 for Domain metadata, then the selected `domain.md`, then depth 2 for Document metadata and prerequisite closure,
then depth 3 for explicitly chosen bodies. Stop as soon as the task is answerable.

The Runtime supports that ladder but does not enforce it. Nothing prevents a caller from opening at depth 3. The ladder
is convention; see `authority-workflow.enforcement-boundary` for the full list of what is enforced and what is not.
