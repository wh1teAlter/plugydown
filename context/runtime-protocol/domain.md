---
schema: plugydown.context.document/v1
id: runtime-protocol
description: The single-shot stdin/stdout wire contract of the private Plugydown Context Runtime, its closed capability set, and its determinism guarantees.
kind: domain
domain: runtime-protocol
---

# Runtime protocol

Every capability of this product is reached through exactly one channel: a private Node ESM executable that reads one
JSON value from stdin and writes one JSON value to stdout. There is no HTTP surface, no long-lived daemon, no
subcommand grammar, and no second entry point. Implemented in `packages/context/src/runtime/cli.ts` with the request
grammar in `protocol.ts` and dispatch in `handler.ts`.

## Why this Domain exists

The Runtime is the trust boundary between an AI host that reasons in prose and a repository that must not be corrupted.
Everything the host can ask for is enumerated in one closed set; anything not enumerated is rejected by name before any
filesystem work happens. That is what makes the rest of the product analyzable: `read-plane` and `write-plane` can only
be entered through a request that already parsed.

## What lives here

- `runtime-protocol.wire-contract` — the two envelopes, the closed capability and status sets, request parsing, and the
  fact that illegal status/field combinations cannot be constructed.
- `runtime-protocol.budgets-and-cursors` — output ceilings, the never-truncate rule, and the sealed cursor.
- `runtime-protocol.determinism` — byte-level output stability, what is normalized, and the one deliberate
  non-determinism.

## Invariants that hold across the whole Domain

- The protocol string is `plugydown.context.runtime/v1`, and a mismatch is `PROTOCOL_UNSUPPORTED`. It is not the first
  check: `parseRequest` confirms the request is an object and runs the top-level exact-key check first, so a request with
  both an unknown field and a bad protocol reports `REQUEST_FIELD_UNKNOWN`. `handleRequest` also reads the capability
  before parsing at all, so that a failure response can name it.
- Request size is capped at 1 MiB in `cli.ts` before parsing; overflow is `REQUEST_SIZE_EXCEEDED`.
- stdin must decode as strict UTF-8 (`TextDecoder` with `fatal: true`). Anything else becomes `TRANSPORT_INVALID`.
- A transport failure is *not* a Runtime response. It uses a different envelope keyed `transport` and sets exit code 1.
  Callers must therefore check both exit status and stdout shape; a caller that only inspects `status` will misread a
  transport failure.
- The Runtime never receives the repository root in JSON. It uses `process.cwd()`. The host must start the process with
  the business repository root as cwd.
- Unknown request fields are rejected rather than ignored (`REQUEST_FIELD_UNKNOWN`), for every nested object as well.
  There is no forward-compatible "extra keys are fine" behaviour anywhere in the request grammar.

## Vocabulary warning

Three unrelated things in this repository are called "evidence", and any Document in any Domain that uses the word must
say which one it means:

1. Git bytes collected by the host into `.scratch/evidence/<leaf>/`.
2. Declared source globs (`code.paths`, `evidencePaths`) that tie knowledge to files.
3. The four caller-asserted booleans in `delta.compute` input (`taskEvidence`).

"Candidate" is overloaded twice: a transaction candidate tree under `.scratch/runs/<run-id>/candidate/context/`, and a
convergence candidate reported by `growth.measure`.
