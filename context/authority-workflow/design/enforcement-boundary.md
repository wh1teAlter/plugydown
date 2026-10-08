---
schema: plugydown.context.document/v1
id: authority-workflow.enforcement-boundary
description: The explicit division between rules the Runtime mechanically enforces and rules that exist only as prose convention, including the places where the shipped documentation implies enforcement that does not exist.
kind: decision
domain: authority-workflow
relations:
  requires:
    - authority-workflow
  related:
    - write-plane.scope-authorization
    - read-plane.delta-and-light
code:
  paths:
    - packages/context/src/commands/update.md
    - packages/context/README.md
    - packages/context/public/schemas/runtime.schema.json
---

# Enforcement boundary

This Document exists because the shipped Markdown reads, in several places, as though the Runtime guarantees things it
does not. Anyone reasoning about the safety of this product needs the line drawn explicitly.

## Mechanically enforced

The Runtime will refuse, or fail, if any of these is violated:

- protocol string, capability name, action name, and every request field shape, including rejection of unknown fields
- request size (1 MiB) and strict UTF-8 decoding
- Document front-matter grammar, the closed field set, size limits, and non-empty body
- canonical two-level placement, filename shape, `domain` matching its directory, and the `<domain-id>.` id prefix
- Domain completeness: every Domain has a valid `domain.md`; the tree has at least one Domain
- global Document id uniqueness
- relation validity: no self-reference, no dangling `requires`/`related`, no `requires` cycle
- Meta shape, and exact agreement between Meta ids/fingerprints and the Markdown tree
- symlink refusal, path safety, forbidden source segments, glob language, and every resource ceiling
- Git evidence directory shape and strict byte-level parsing
- transaction ordering: `begin` → `validate` → `commit`, with phase preconditions
- single-writer exclusion via atomic `mkdir`
- **approval bound to both fingerprints**, and invalidation of approval on any post-validation change
- scope authorization over Documents, including `CANDIDATE_SCOPE_VIOLATION`
- prune source-coverage preservation (`PRUNE_COVERAGE_LOST`)
- post-commit re-verification of the committed tree against the approved fingerprint
- `init` and `prune` must be `deep`; `init` requires absent Context and repository scope; `prune` requires ready source
- output budgets, the never-truncate rule, and cursor integrity

## Convention only

Nothing in the Runtime checks any of these:

- **Which actor did what.** The Runtime is role-blind. Investigator/Recorder/Reflector do not exist in the request
  grammar. Scope authorizes Documents, not identities.
- **That a review happened, or that the reviewer was not the author.** The Runtime proves only that committed bytes equal
  approved bytes.
- **That exactly one Recorder edited the candidate.** Any number of writers, or none, produces the same result.
- **Light versus Deep for Update.** `transaction.mode` is parsed, stored in the manifest, and read nowhere except
  `validateBeginMode`'s gate forcing `init`/`prune` to `deep`. `delta.compute` computes `light.eligible` and the
  transaction plane never consults it. Declaring `light` with nine active blockers is accepted.
- **The reading ladder.** L0 → L1 → L2 → L3 is prescribed by `SKILL.md`; nothing stops a caller opening at depth 3.
- **`.scratch/investigations/` in its entirety.** Zero Runtime representation: no constant, no validation, no cleanup.
- **Investigation identity-hash derivation.** Prose only. (The Feedback equivalent *is* enforced.)
- **The compact state block, the final report contents, and the no-timestamps rule.**
- **Feedback promotion authorization** — that the user authorized those specific Feedback ids in this Update.
- **Prune semantic accountability** — that every removed fact has a named survival location. Only mechanical source
  coverage is checked.

## Where the documentation overstates

Recorded honestly because each is a live source of false confidence:

1. `packages/context/src/commands/update.md` step 2 describes the Light/Deep decision as if it were a Runtime-enforced
   invariant. It is not; see above. (The READMEs do not mention modes at all.)
2. `packages/context/README.md` documents scratch Markdown filenames as `<short-content-hash>`. The actual rule, in
   `SKILL.md`, `references/runtime.md`, and the code, is an identity hash over four normalized fields — explicitly not the
   whole file. The README is simply wrong.
3. `packages/context/public/schemas/runtime.schema.json` presents itself as the wire contract and is **not validated
   anywhere**. No JSON-Schema validator is wired to it — `ajv` is present only as an `eslint` transitive dependency and
   nothing routes it at these files. It has drifted from the implementation in six confirmed ways, catalogued in
   `delivery.verification-and-gaps`. Code plus tests are the real contract.

## Why the split is acceptable

Recording this is not an argument that the prose half should be mechanized. The actors here are language models reading
Markdown; a prose contract is the only available mechanism for "who reviewed this". The Runtime's chosen job is narrower
and achievable: make it impossible to *lose* or *silently corrupt* knowledge, and make every committed byte traceable to an
explicit fingerprint binding. It does that job.

The failure mode to guard against is not the split itself but describing the split inaccurately — telling a reader that
Light mode is gated when it is advisory, or that a review is required when it is requested. That converts a known,
manageable limitation into an unknown one.

## Assumption

Whether the Light/Deep inertness is a deliberate staging decision or an incomplete implementation is **unverified**. The
mode is threaded all the way through parsing, the manifest type, and manifest re-validation, which is more plumbing than
an unused field usually gets — but nothing consumes it and no comment explains why.

## Review record

The `runtime.schema.json` rename of `unmappedPaths` to `unreferencedPaths` was reviewed against this document and
changes nothing here. The unvalidated-schema finding above does not name any payload field, and the rename did not add
a validator: no JSON-Schema validator is routed at the published schemas, and `ajv` remains only an `eslint` transitive
dependency. The three enforcement gaps stand as recorded.
