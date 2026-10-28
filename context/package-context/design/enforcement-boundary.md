---
schema: plugydown.context.document/v1
id: package-context.enforcement-boundary
description: The explicit division between rules the Runtime mechanically enforces and rules that exist only as prose convention, and the shipped prose and tests that must keep that line visible.
kind: decision
domain: package-context
relations:
  requires:
    - package-context
  related:
    - package-context.scope-authorization
    - package-context.delta-and-light
  supersedes:
    - authority-workflow.enforcement-boundary
code:
  paths:
    - packages/context/src/commands/update.md
    - packages/context/README.md
    - packages/context/public/schemas/runtime.schema.json
    - packages/context/tests/runtime/fixture.ts
    - packages/context/src/runtime/transaction.ts
    - packages/context/src/runtime/repair.ts
    - packages/context/src/commands/repair.md
---

# Enforcement boundary

Runtime safety and host workflow authority are separate. Read the enforced checks together with the prose obligations;
neither a source fingerprint nor a successful request proves that a semantic review actually happened.

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
- `init`, `prune` and `repair` must be `deep`; Init requires absent Context and repository scope; Prune requires ready source and no explicit content review obligations
- Repair qualification, complete explicit Document scope, exact Markdown preservation and retained source/baseline records
- output budgets, the never-truncate rule, and cursor integrity

## Convention only

Nothing in the Runtime checks any of these:

- **Which actor did what.** The Runtime is role-blind. Investigator/Recorder/Reflector do not exist in the request
  grammar. Scope authorizes Documents, not identities.
- **That a review happened, or that the reviewer was not the author.** The Runtime proves only that committed bytes equal
  approved bytes.
- **That exactly one Recorder edited the candidate.** Any number of writers, or none, produces the same result.
- **That a reaffirmed Document was actually reviewed.** `reaffirmedDocumentIds` is the caller's statement. The Runtime
  proves only that each id names a Document inside the authorized scope, and it never infers the list.
- **Light versus Deep for Update.** Runtime parses and freezes the mode, but does not compare an Update mode with
  delta.compute Light eligibility. Deep gates for Init, Prune and Repair do not add such an Update check; declaring
  Light while Update blockers are active is accepted.
- **The reading ladder.** L0 → L1 → L2 → L3 is prescribed by `SKILL.md`; nothing stops a caller opening at depth 3.
- **`.scratch/investigations/` in its entirety.** Zero Runtime representation: no constant, no validation, no cleanup.
- **Investigation identity-hash derivation.** Prose only. (The Feedback equivalent *is* enforced.)
- **The compact state block, the final report contents, and the no-timestamps rule.**
- **Feedback promotion authorization** — that the user authorized those specific Feedback ids in this Update.
- **Prune semantic accountability** — that every removed fact has a named survival location. Only mechanical source
  coverage is checked.

## Where the shipped prose and tests hold the line

Three places could give false confidence if they stopped saying what is true:

1. `packages/context/src/commands/update.md` step 2 says the Light/Deep choice is the caller's: the Runtime reports
   blockers but does not enforce Update mode. Repair has its own enforced Deep gate.
2. `packages/context/README.md` documents scratch Markdown filenames as `<short-identity-hash>`, matching `SKILL.md`,
   `references/runtime.md`, and the code: an identity hash over a few normalized fields, explicitly not the whole file.
3. The three published schemas, including `packages/context/public/schemas/runtime.schema.json`, are a validated
   contract. `packages/context/tests/runtime/fixture.ts` compiles all of them with ajv 2020 in strict mode and holds
   every Runtime response, every request the Runtime accepted, and — after each successful commit — the committed
   `meta.json` and every Document's front matter to them. A schema that drifts from the implementation fails the test
   that exposed it; `ajv` is a pinned catalog devDependency. The check is as wide as the suite: a response shape no test
   produces is not compared. See `package-context.verification-and-gaps`.

## Why the split is acceptable

Recording this is not an argument that the prose half should be mechanized. The actors here are language models reading
Markdown, and role identity and actual review are established by the host workflow. Runtime instead validates complete
candidates, binds committed content to explicit approval and preserves evidence for its supported recovery paths.
Failures without a trusted copy and unexecuted host sessions remain explicit limits; no blanket guarantee can replace
those outcomes.

The failure mode to guard against is not the split itself but describing the split inaccurately — telling a reader that
Light mode is gated when it is advisory, or that a review is required when it is requested. That converts a known,
manageable limitation into an unknown one.

## Update mode

Update accepts either mode; the shipped command explicitly assigns the choice to the host. Do not infer an additional
Runtime gate from the presence of the mode field in its manifest.
