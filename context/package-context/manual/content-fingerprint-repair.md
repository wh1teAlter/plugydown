---
schema: plugydown.context.document/v1
id: package-context.content-fingerprint-repair
description: Controlled recovery after merge/rebase content fingerprint mismatches — paged preview, scoped Repair transaction, preserved Markdown/source baselines and subsequent semantic Update.
kind: guide
domain: package-context
relations:
  requires:
    - package-context.meta-ledger
    - package-context.transaction-lifecycle
  related:
    - package-context.outcomes-and-recovery
    - package-context.git-evidence
    - package-context.roles-and-briefs
code:
  paths:
    - packages/context/src/runtime/repair.ts
    - packages/context/src/runtime/transaction.ts
    - packages/context/src/runtime/graph.ts
    - packages/context/src/runtime/queries.ts
    - packages/context/src/commands/repair.md
    - packages/context/src/commands/update.md
    - packages/context/src/skills/context/references/runtime.md
    - packages/context/tests/runtime/repair.test.ts
---

# Content fingerprint repair

A Git merge may combine valid prose from two branches into bytes matching neither branch's ledger. Ordinary Update
still requires ready formal Context. Repair is the restricted path back to structural consistency; it does not certify
that merged statements match source.

## Qualification and scope

Meta must parse, document IDs must exactly match the tree, and all structure, relation and path checks must pass.
The complete internal issue set may contain only content fingerprint mismatches; conflict markers are refused.
Finish Git operations and resolve unmerged status entries first. Resume an active Runtime transaction rather than
deleting its lock. A consistent tree is also accepted and ends as `no_change` without forcing schema migration.

Repair requires `command: repair`, `mode: deep`, explicit Document scope and no `reaffirmedDocumentIds`. All mismatched
Documents must lie within the grant; otherwise `REPAIR_SCOPE_INCOMPLETE` rejects begin. It never adds missing scope
implicitly. All declared source evidence must remain safely readable for the approval binding.

## Official flow

1. Call `repository.inspect` with `repair: true` and `selectedDocumentIds`. The paged `data.repair.items` names each
   affected Document, whether selected, and each changed field's before/after value. Read the complete needed plan;
   `remainingDocumentCount` exposes omitted scope and `planFingerprint` identifies the deterministic plan.
2. Collect fresh Git evidence and begin a dry-run Repair. `evidencePaths: []` is allowed only for Repair; Runtime still
   reads all document-declared sources. `repair_staged` says to validate, not to edit the candidate.
3. Validate. Runtime derives the restricted ledger, verifies the complete candidate and returns both approval
   fingerprints plus a bounded plan summary. A dry run cleans its artifacts and cannot later become a real commit.
4. With write authorization, collect fresh evidence, begin with `dryRun: false`, validate and review the candidate.
   Investigator checks faithful preservation, scope and honest pending status; Main Assistant approves the returned
   candidate/source fingerprints and commits. No role writes the repair candidate.
5. Inspect the affected IDs and run `graph.validate`. Content errors disappear; `reviewRequired` and
   `DOCUMENT_REVIEW_PENDING` remain. Follow with authorized Update to compare each Document with current evidence,
   edit if needed or explicitly reaffirm it, validate, review and commit.

## What may change

Runtime recalculates only selected mismatched `bodyFingerprint` / `frontMatterFingerprint` values and sets their
`reviewRequired: true`. If needed, it upgrades the ledger discriminator to Meta v2. Every Markdown byte, path and
permission is preserved. Original `sourceFingerprint` values, repository baseline, convergence baseline and other
document records remain unchanged.

The explicit obligation survives even when source bytes are unchanged or `code.paths` is absent. It enters
`directImpact`, prevents repository baseline advancement and must be settled before Prune. Update clears it only for
Documents actually edited or explicitly reaffirmed under candidate review and approval.

## Freshness and recovery

Candidate or source changes invalidate the old approval. A changed formal tree requires a fresh transaction.
If commit fails and the original snapshot is restored, `backup_restored` remains a failed transaction and
`REPAIR_ROLLED_BACK` states that its old mismatch remains. That original snapshot is trusted by exact fingerprint for
rollback even though it is not structurally ready. Conflicting or missing trusted copies preserve the recovery scene.

Never hand-edit live Meta or fabricate source fingerprints to clear a warning. Runtime owns the algorithms and the
transaction; only semantic review can discharge the content review obligation.
