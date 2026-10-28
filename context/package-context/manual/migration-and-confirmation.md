---
schema: plugydown.context.document/v1
id: package-context.migration-and-confirmation
description: "Ordinary Git confirmation workflow, targeted Update without unnecessary prose edits, and explicit migration of legacy ledgers."
kind: guide
domain: package-context
relations:
  requires:
    - package-context.meta-ledger
    - package-context.transaction-lifecycle
  supersedes:
    - package-context.content-fingerprint-repair
  related:
    - package-context.outcomes-and-recovery
    - package-context.git-evidence
    - package-context.roles-and-briefs
code:
  paths:
    - packages/context/src/commands/migrate.md
    - packages/context/src/commands/update.md
    - packages/context/src/runtime/confirmation.ts
    - packages/context/src/runtime/migration.ts
    - packages/context/src/runtime/transaction.ts
    - packages/context/src/skills/context/references/runtime.md
    - packages/context/tests/runtime/confirmation.test.ts
    - packages/context/tests/runtime/migration.test.ts
---

# Migration and confirmation after Git changes

Ordinary rebase and merge do not require a ledger repair. Resolve actual Markdown conflicts, then use confirmation.check
to determine whether the resulting complete inputs match a historical confirmation. Do not treat conflict resolution
or hash computation as semantic review.

## Current-layout workflow

1. Call repository.inspect and resume any active transaction. Correct invalid structure or damaged records explicitly.
2. Check the task's Document/Domain/path scope with confirmation.check and explain enabled. Follow its cursor when needed.
3. A matched tuple needs no bookkeeping update. An unmatched tuple needs targeted review, not automatic rewriting.
   documentContentKnown distinguishes source-only drift from a body/front-matter combination not previously confirmed.
4. Review the actual changed claims and their sources. If still accurate, use an authorized Update with those IDs in
   confirmedDocumentIds; leave the Markdown alone. Otherwise edit the authorized candidate's prose or source declaration.
   Missing old paths may be corrected directly in this checkout; never restore fake source files to pass validation.
5. Validate the complete candidate, review every newly confirmed input, approve both returned fingerprints and commit.
   The final candidate must have valid declared sources. Recheck confirmations after commit.

Different keys from independent branches coexist under `.meta/confirmations/`. A final body equal to one branch is
matched only if front matter and current sources also match that same complete record. A third body gets no inherited
approval. Delete/modify, ID changes, actual Markdown conflicts and conflicting global baseline objects still require a
concrete resolution. No local merge driver, hook or AI-specific rebase wrapper is required for matching correctness.

## One-time legacy migration

A legacy root meta.json cannot be used by ordinary current-format maintenance. Upgrade the paired clients and CI before
merging converted data. Finish Git operations and use the compatible old Runtime to resolve old active runs; never relabel
old lock or transaction files with a new format.

1. Inspect with migration: true. Read the complete paged plan, including eligibility, import count, per-Document decisions
   and planFingerprint. Only valid old metadata and Markdown with at most content-fingerprint mismatches qualify.
2. Select an explicit migrationStrategy. `import-trusted` copies original complete tuples except reviewRequired=true.
   `reconfirm` copies none. Neither strategy recalculates current content into a supposed historical approval.
3. Begin command migrate, mode deep, repository scope and the explicit strategy. evidencePaths may be empty. Runtime
   binds the original Context and resulting candidate; it does not require deleted current sources for historical import.
   Any evidencePaths explicitly supplied must remain readable and unchanged.
4. migration_staged directs validate without role edits. An optional dry run ends at validation and is cleaned; it cannot
   later become a real commit. Investigator reviews exact Markdown paths, bytes, permissions, preserved baselines and
   faithful imported/skipped records. Main Assistant approves the bound candidate and source-evidence fingerprints.
5. Commit switches the entire tree: the old root entry disappears and the new metadata area becomes live together.
   Inspect and check confirmations, then perform an authorized Update for actual content/source changes.

Migration copies the old repository/convergence baseline values. It does not advance either or create a semantic claim
about current sources. Source changes during migration approval do not invalidate a historical import unless those files
were explicitly declared as evidence; current confirmation matching still detects the resulting mismatch.

## Failure and consumer boundaries

Candidate/source changes in ordinary Update invalidate approval; formal Context changes require a fresh transaction.
Migration rollback reports backup_restored with MIGRATION_ROLLED_BACK and restores the old layout. Conflicting copies or
no trusted copy retain the existing manual recovery rules. Never hand-edit machine records or replace source hashes with
sentinels to obtain a passing check.

A successful check is not a CI policy verdict. A consumer must validate format, repository scope, summary and all pages.
An exact-basis policy requires all Documents matched; a content-guard policy may allow source-only drift but must still
reject invalid sources and previously unconfirmed content. The business repository explicitly chooses its policy.
