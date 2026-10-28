---
schema: plugydown.context.document/v1
id: package-context.meta-ledger
description: Meta v1/v2 in a single Schema, content integrity versus source review, explicit reviewRequired obligations, readiness axes and the independent source/size baselines.
kind: architecture
domain: package-context
relations:
  requires:
    - package-context.document-grammar
    - package-context
  related:
    - package-context.determinism
    - package-context.content-fingerprint-repair
  supersedes:
    - knowledge-model.meta-ledger
code:
  paths:
    - packages/context/public/schemas/meta.schema.json
    - packages/context/src/runtime/delta.ts
    - packages/context/src/runtime/document.ts
    - packages/context/src/runtime/graph.ts
    - packages/context/src/runtime/queries.ts
    - packages/context/src/runtime/repair.ts
    - packages/context/src/runtime/transaction.ts
---

# Meta ledger and review obligations

`context/meta.json` is machine-managed. Ordinary transactions derive it in transaction.ts; Repair uses the restricted
repairMeta derivation. Validation serializes and strictly reloads the candidate before approval. Neither roles nor users
hand-edit live Meta.

## Formats and fields

Runtime reads `plugydown.context.meta/v1` and `plugydown.context.meta/v2`. A single public meta.schema.json validates
both through the `$schema` discriminator. Required top-level fields are `$schema`, toolVersion, runtimeProtocol,
fingerprintVersion and documents; repository and convergence are optional. Unknown fields and incomplete shapes fail.

Each v1 document record contains exactly frontMatterFingerprint, bodyFingerprint and sourceFingerprint, all 64-character
lowercase SHA-256 values. V2 additionally permits `reviewRequired: true`; false or another value is invalid. Absence of
the flag is not a standalone claim of freshness: the existing source comparison still applies.

New Init writes v2. Normal Update preserves the current ledger version. Repair upgrades v1 to v2 only when it actually
repairs content fingerprints; a consistent ledger returns no_change without migration. Older Runtimes reject v2, so
collaborators must upgrade before committing the migrated ledger. Protocol and fingerprint algorithms remain v1.

The fingerprint algorithm version must change if its computation changes. Read FINGERPRINT_VERSION and TOOL_VERSION
in document.ts for current values; toolVersion is a ledger constant, not the package release version.

## Separate integrity from review

| Field | Meaning |
|---|---|
| frontMatterFingerprint | canonical projection of the current document metadata |
| bodyFingerprint | normalized current document body |
| sourceFingerprint | declarations and source bytes recorded as the last review basis |
| reviewRequired | explicit obligation to review content reconciled without source reaffirmation |

Body/front-matter equality proves agreement with the current document bytes under normalization. It does not prove
that those statements match the source. Repair recalculates the first two and sets reviewRequired, retaining the old
sourceFingerprint. Even with unchanged source bytes or no code.paths, the repaired document remains pending.

`reviewPendingIds` unifies explicit content obligations, differences between recorded and current source fingerprints,
and source expansion issues. Delta's directImpact uses that queue; graph.validate reports DOCUMENT_REVIEW_PENDING;
inspect exposes explicit review flags and a contentReviewRequiredCount. A source-unavailable document is not silently
settled. Only a normally reviewed Update edit or explicit reaffirmedDocumentIds can clear the content obligation.

## Two baselines

repository.baseline records the Git revision and aggregate cited-source fingerprint at the last whole-repository
settlement. Init establishes it. Update may advance it only with repository scope, no Git mid-operation, every source
fingerprint equal to its current value and no reviewRequired flag remaining. A scoped Update preserves it. Git history
availability is not a condition: a squash-orphaned baseline may be replaced when all review is actually settled.
Unreferenced path changes do not themselves pin the baseline because no document claims them as evidence.

The review queue is independent of baseline history. Missing diff.bin limits historical changed/unreferenced paths,
not directImpact. Source expansion does not consult .gitignore; a cited ignored file can still change a fingerprint,
which is why declarations should name stable tracked sources.

convergence is a size baseline established only by Init or Prune, with per-Domain metrics. Update preserves it so
routine edits or Domain reorganization do not disguise growth. Repair preserves both baselines unconditionally.

## Three independent readiness axes

- formalState: absent, ready or invalid. Covers Markdown structure, placement, graph relations, Meta shape, exact ID set
  and equality of both content fingerprints.
- sourceState: unchecked, ready or degraded. Describes requested source expansion only; ready means readable evidence,
  not semantic approval. An invalid formal tree leaves ordinary source loading unchecked.
- metaState: absent, valid or invalid. Describes the ledger's own format independently of its agreement with documents.

Source policies are formal-only, selected, all-strict and all-tolerant. Strict graph validation requires formal and
source readiness. Review debt remains a warning while unreadable source evidence can fail that strict check.

## Content mismatches and recovery

META_DOCUMENT_SET_MISMATCH means the ledger IDs differ from the Markdown tree. META_DOCUMENT_FINGERPRINT_MISMATCH means
one or both current content fingerprints disagree. These remain strict formal errors; ordinary reads and Update do
not bypass them. Only the qualified Repair transaction may start from content-only mismatch and must produce a complete
valid candidate. Schema damage, duplicate IDs, relation failures and unsafe paths remain blocked.

Exact paths and controlled globs are valid code.paths. Empty declarations produce a deterministic source fingerprint
over an empty set and do not erase content review obligations. See `package-context.content-fingerprint-repair` for the
merge/rebase SOP and `package-context.path-and-glob-safety` for source constraints.
