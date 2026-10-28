---
schema: plugydown.context.document/v1
id: package-context.meta-ledger
description: "Current metadata layout, immutable complete-input confirmations, derived match states, explicit legacy migration and non-advancing repository baselines."
kind: architecture
domain: package-context
relations:
  requires:
    - package-context.document-grammar
    - package-context
  related:
    - package-context.determinism
    - package-context.migration-and-confirmation
  supersedes:
    - knowledge-model.meta-ledger
code:
  paths:
    - packages/context/public/schemas/meta.schema.json
    - packages/context/public/schemas/confirmation.schema.json
    - packages/context/src/runtime/confirmation.ts
    - packages/context/src/runtime/document.ts
    - packages/context/src/runtime/graph.ts
    - packages/context/src/runtime/migration.ts
    - packages/context/src/runtime/transaction.ts
---

# Metadata and immutable confirmations

Current Markdown and front matter are the authority for current knowledge. The Runtime stores historical confirmation
of complete inputs separately; a missing match is an Update signal, not a damaged current-content ledger.

## One metadata area

```text
context/.meta/manifest.json
context/.meta/confirmations/<document-id>/<key>.json
```

The manifest requires `format: 1` and permits only optional `repository` and `convergence` baselines. There is no current
Document map. `parseMetadataManifest` checks the closed shape and canonical JSON; `inspectMetadataLayout` rejects mixed
legacy/current entries, incomplete metadata directories, unknown entries and unsafe paths. Legacy `context/meta.json`
is used only for discovery and explicit migration, never as an ordinary-read fallback.

One compatibility generation is shared by the manifest, wire protocol, transaction state, lock and cursor. The plugin
release version is separate and is not part of confirmation identity. The existing fixed Markdown grammar label remains
`plugydown.context.document/v1`; no mass rewriting of that label is required.

## Complete immutable records

Every confirmation contains exactly four fields:

| Field | Meaning |
|---|---|
| `documentId` | stable Document identity, matching the parent directory |
| `frontMatterFingerprint` | canonical business-metadata projection at confirmation |
| `bodyFingerprint` | normalized body at confirmation |
| `sourceFingerprint` | complete declared source patterns, resolved paths and source bytes at confirmation |

All fingerprints are full lowercase SHA-256 values. `confirmationKey` hashes UTF-8 `compactJson({format, record})`;
`stableJson(record)` supplies the canonical file bytes. The record does not repeat format, release version, commit ID,
reviewer, timestamp or a latest pointer. `readConfirmationStore` checks canonical bytes, record shape, directory identity
and filename key, including historical records for Documents no longer present. Unknown or malformed records are errors,
not records to silently discard or repair by hashing again.

Records represent one complete tuple. Fields from different branch records must never be combined to manufacture a
confirmation. Ordinary Git can retain independent keys from both branches. An exact previously confirmed tuple remains
matched after rebase; a third combination of prose or sources does not inherit semantic approval from either parent.

## Read-time facts

`checkConfirmations` reads the current graph and selected sources, validates the record store and samples Context and
sources again before returning a snapshot. Changing inputs causes `CHECK_SNAPSHOT_CHANGED` instead of a mixed result.

- `matched`: one valid record equals the complete current tuple.
- `unmatched`: complete sources are available, but no record matches. `documentContentKnown` distinguishes previously
  confirmed body/front matter with changed sources from content that has no matching historical content pair.
- `unavailable`: sources cannot be safely and completely read; no current key or fabricated source hash is returned.
- `unchecked`: inputs not sampled. The public summary separately counts Documents outside the requested scope.

No `reviewRequired`, replacement pending flag, per-Document latest pointer or persistent review queue exists in the
current layout. `LegacyDocumentLedger` retains the old flag only to reject its import as trusted completed review.
Hash equality proves unchanged inputs, not natural-language correctness or that a review actually occurred.

## Separate validation responsibilities

`loadKnowledge` checks Markdown placement, IDs, relations and the metadata entry. Its `formalState` is absent, ready or
invalid. `metaState` describes entry validity; `sourceState` describes only the requested source sample as unchecked,
ready or degraded. These states do not assert semantic confirmation.

`graph.validate` requires valid structure, valid confirmation storage and readable sources. `confirmation.check` reports
match facts independently, with explicit selection and coverage. Unmatched inputs do not block Update begin. Missing
sources can be fixed in its candidate; final validation still requires all candidate source declarations to be valid.
Unsafe declarations and truly broken structure remain errors.

## Baselines and ownership

Migration preserves `repository.baseline` and `convergence` values. Repository baseline is inert historical data: ordinary
Update never advances it and Delta never silently selects it as a comparison base. Init creates no repository baseline.
Convergence is established by Init and updated by Prune only; Update preserves it. Conflicting baseline objects require
an explicit decision, not per-field mixing or automatic selection by revision/date.

Only the transaction plane writes current metadata and new confirmations. It preserves existing confirmation bytes and
permissions, appends records for authorized new/changed or explicitly confirmed Documents and keeps historical records
when a Document is removed. There is no automatic history GC or cross-branch revocation mechanism. Deleting a record in
one branch is not a reliable global revocation.

See `package-context.migration-and-confirmation` for the operational workflow and `package-context.determinism` for the
normalization and permission boundaries.
