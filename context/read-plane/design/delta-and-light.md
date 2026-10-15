---
schema: plugydown.context.document/v1
id: read-plane.delta-and-light
description: How delta.compute takes the review queue from source fingerprints and explains it with Git changes, expands impact along three graph edges, and reports eight Light blockers; unreferenced paths and an incomplete changed-path list block neither Light nor the repository baseline, and the baseline-eligibility flag is caller guidance while the commit applies its own conditions.
kind: architecture
domain: read-plane
relations:
  requires:
    - read-plane
    - repository-access.git-evidence
    - knowledge-model.meta-ledger
code:
  paths:
    - packages/context/src/runtime/delta.ts
    - packages/context/src/runtime/graph.ts
    - packages/context/src/runtime/transaction.ts
    - packages/context/src/commands/update.md
---

# Delta and Light eligibility

Implemented in `packages/context/src/runtime/delta.ts`. Requires `formalState: ready` and uses the `all-tolerant` source
policy, so partial source problems become reported broken evidence rather than a hard failure.

## Mapping changed paths to Documents

`code.paths` is a forensic evidence claim, not coverage. A Document cites the files its conclusions rest on. A
repository is not expected to declare every file.

`directImpact` is the review queue, and fingerprints alone decide it: every Document whose recorded `sourceFingerprint`
differs from the recomputed one (`reviewPendingIds` in `graph.ts`, the helper `graph.validate` also uses), plus every
Document with a source expansion issue. It needs no Git history. Changed paths only supply the reasons.

For every changed path from the Git evidence:

1. Paths under `context/` or `.scratch/` are skipped entirely. Formal knowledge and scratch are not source, so editing
   them is neither impact nor an unreferenced path.
2. Otherwise every Document's `code.paths` declarations are tested with `declarationMatches`. A match makes the path
   *mapped*.
3. A mapped Document that is in the queue gets the reason `code.paths <declaration> matches <path>`; a mapped Document
   that is not gets nothing.

A queued Document that no changed path matched gets the reason `cited sources differ from those recorded at the last
review` and `changedPaths: []`. That is the normal answer when the evidence does not list the change, for example
because the history was unavailable or the cited file is ignored by Git.

Step 3 is easy to misread. A Document can be mapped and still absent from `directImpact` — that means its recorded
fingerprint already equals the current one, so there is nothing to synchronize. Absence from `directImpact` is not
evidence that a path was unreferenced; `unreferencedPaths` is the separate list for that.

A path matching no declaration lands in `unreferencedPaths`. That is a forensic signal for a Recorder, not a coverage
gap. The Runtime cannot tell whether the change is genuinely outside documented territory or whether some Document's
declarations are incomplete; it reports the path so a Recorder can judge. Unreferenced paths block **neither** Light
**nor** `repositoryBaselineEligible`: no Document cites them, so no recorded fingerprint covers them and no recorded
knowledge can have gone stale because of them. Only broken evidence and Documents left unreviewed hold things back. A
cited file that cannot be expanded is broken evidence, which does block Light (`evidence is incomplete`).

## Impact closure

`impactClosure` in `graph.ts` expands the direct set along three edges, each contributing its own reason string:

- **prerequisites**: `required by impacted <id>`
- **reverse dependents**: `depends on impacted <id>`
- **Domain siblings**: `shares Domain <domain> with impacted <id>`

The third edge is aggressive by design — any change inside a Domain marks the entire Domain as worth reviewing. It also
means closure grows fast: one impacted Document in a large Domain pulls in every sibling, and each sibling then pulls in
its own prerequisites and dependents. Expect closure to dwarf direct impact.

Closure is used for a scope check: any closure member that the requested scope does not contain becomes the blocker
`impact closure extends outside authorized scope`.

## Broken evidence

`brokenEvidence` has one source: source expansion issues, reported as objects `{documentId, code, sourcePattern}`. Each
such Document is also in `directImpact`, because a Document whose sources cannot be read owes review.

## Changed-path completeness

The response always carries the boolean `changedPathsComplete`. It is false when the recorded repository baseline
differs from HEAD and no `diff.bin` was supplied, for example because a squash merge orphaned the baseline commit:
`changedPaths` and `unreferencedPaths` then cover only the working tree. That limits what the result can explain, never
who owes review, so it blocks neither Light nor `repositoryBaselineEligible`.

## The eight Light blockers

`light.eligible` is true only when this list is empty. Blockers are deduplicated and sorted.

| Blocker | Source |
|---|---|
| repository baseline is absent | Meta |
| task intent is not known | caller assertion |
| task scope is incomplete | caller assertion |
| a new capability is suspected | caller assertion |
| a cross-Domain contract is uncertain | caller assertion |
| Git is in a mid-operation state | Git evidence |
| evidence is incomplete | computed |
| impact closure extends outside authorized scope | computed |

**Four of the eight are the caller's own booleans.** `taskEvidence.intentKnown`, `scopeComplete`,
`newCapabilitySuspected`, and `crossDomainContractUncertain` are required inputs. The Runtime records the caller's claim;
it does not and cannot infer task intent. A caller that asserts `intentKnown: true` without knowing the intent gets a
Light-eligible answer that means nothing. This is the third and narrowest sense of "evidence" in this codebase — see
`runtime-protocol` for all three.

`repositoryBaselineEligible` is a separate flag, and like `light.eligible` it is guidance to the caller, not a Runtime
precondition: `deriveMeta` in `transaction.ts` never reads it, or `scopeComplete`. A caller that heeds it treats a
repository-scope Update as able to advance the baseline only while the flag is true — repository scope, no mid-operation,
no broken evidence, and `scopeComplete`. Note it does *not* require `intentKnown`. The commit applies its own conditions
whatever the flag said: repository scope, no mid-operation, and no Document left pending review — every `directImpact`
Document edited or reaffirmed, so that each ledger's `sourceFingerprint` equals its current one. Git history is not a
condition. The read cannot see whether the Update will settle every Document, and the commit never sees `scopeComplete`.

## Light eligibility is advisory only

`delta.compute` computes `light.eligible`. **The transaction plane never reads it.** `transaction.mode` is parsed,
stored in the manifest, and consulted in exactly one place — `validateBeginInput`, which forces `init` and `prune` to
`deep`. For `update`, both `light` and `deep` are accepted and behave identically; nothing compares the declared mode
against the computed eligibility.

So Light-vs-Deep for Update is a workflow convention enforced by whoever follows the prose in
`packages/context/src/commands/update.md` and `SKILL.md`, not a Runtime invariant. `update.md` step 2 says so: the choice
is the caller's, and the Runtime reports blockers but does not enforce the mode. The package and root READMEs do not
mention modes at all.
`authority-workflow.enforcement-boundary` lists this alongside the other convention-only rules.
