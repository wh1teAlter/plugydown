---
schema: plugydown.context.document/v1
id: package-context.delta-and-light
description: "Scoped confirmation mismatches, explicit Git source impact, requires-only reading context and host-owned Light/Deep decisions."
kind: architecture
domain: package-context
relations:
  requires:
    - package-context.git-evidence
    - package-context.meta-ledger
    - package-context
  supersedes:
    - read-plane.delta-and-light
code:
  paths:
    - packages/context/src/runtime/delta.ts
    - packages/context/src/runtime/confirmation.ts
    - packages/context/src/runtime/graph.ts
    - packages/context/src/commands/update.md
---

# Scoped Delta and semantic review depth

`delta.compute` combines current confirmation facts in an explicit scope with host-collected Git evidence. Its input is
exactly `gitEvidencePath` and `scope`. It does not accept taskEvidence booleans or derive Light eligibility, a global
pending queue, unreferenced-path coverage or permission to advance a baseline.

## Separate result streams

| Field | Meaning |
|---|---|
| `confirmationMismatches` | selected Documents whose current confirmation state is unmatched or unavailable |
| `changedPaths` | deduplicated Git change records from the evidence leaf |
| `sourceAffected` | selected Documents whose declarations match changed source paths |
| `requiredContext` | selected mismatch/impact seeds and their transitive `requires` reading prerequisites |
| `outOfScopeAffected` | Documents outside scope whose declarations match the supplied Git changes |

The streams share one budget and cursor. A page can contain only part of a stream, so consumers must not interpret an
empty per-page array as an empty complete result. The response binds `snapshotFingerprint`, a scope kind and request
fingerprint. Changes in Context, selected source evidence or Git evidence reject continued use of the old snapshot.

A source-affected Document can still be matched: supplied Git history may include a change already confirmed. Conversely,
a mismatch can have no corresponding Git change record when historical evidence was not supplied. Source impact is an
explanation, not confirmation or a command to rewrite prose.

## Scope and path ownership

`selectDocumentIds` validates Document/Domain IDs and uses the requested scope. Path scope combines exact declarations,
current resolved paths and matching Git paths; deleted exact declarations retain ownership. Path-scope queries use
source expansion to select Documents and re-sample that selection to reject files appearing/disappearing during the
query. Other scopes avoid sampling unrelated sources for freshness.

`code.paths` states the source basis of a Document, not a demand to cover every repository file. Delta scans declaration
matches to report outside-scope Git impact but does not expand the authorized set. Unrelated historical source drift is
not automatically added to a local task. `requiredContext` is a reading dependency: there is no Domain-sibling or reverse-
dependent update expansion. A prerequisite may remain outside the write scope.

## Explicit historical coverage

`historyCoverage` is `provided` only when the leaf includes both diff.bin and a valid comparison.json; otherwise it is
`not_provided`. The latter means changedPaths covers the supplied working-tree/index state, not that history contains no
changes. The fixed comparison uses two explicit object IDs, independently of the retained repository baseline.

Confirmation matching itself uses no Git commit identity. Rebase, squash or unavailable old commits do not invalidate
unchanged inputs. Git evidence is checked again before returning Delta; Runtime never collects or authenticates Git facts
itself. `gitMidOperation` reports the supplied operation state for the host to interpret.

## Light and Deep are host decisions

The Update command assigns Light only to a small understood change with known intent, complete mapping and no uncertain
cross-Domain contract. Otherwise choose Deep and Investigator review. Runtime parses and freezes the mode, but does not
prove semantic scope or decide whether prose is accurate.

Before begin, review the selected mismatches against their actual sources. Record `accurate`, `needs edit` or `not
verified`; only actually reviewed accurate IDs enter `confirmedDocumentIds`. Edit only what needs a semantic correction.
A third merged body can therefore be checked and confirmed without rewriting it. Never pass every mismatch as confirmed
merely because its hash was computed.
