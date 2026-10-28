---
schema: plugydown.context.document/v1
id: package-context.capabilities
description: "Current read projections, immutable confirmation checks, explicit legacy migration preview, bounded retrieval and non-mutating growth/feedback analysis."
kind: architecture
domain: package-context
relations:
  requires:
    - package-context.meta-ledger
    - package-context
  supersedes:
    - read-plane.capabilities
code:
  paths:
    - packages/context/src/runtime/delta.ts
    - packages/context/src/runtime/graph.ts
    - packages/context/src/runtime/queries.ts
    - packages/context/src/runtime/confirmation.ts
    - packages/context/src/runtime/migration.ts
---

# Read capabilities

The seven read capabilities compose queries.ts, delta.ts, confirmation.ts and migration.ts. All mutating Runtime filesystem calls remain
in transaction.ts; reading, including a migration preview, does not create, replace or remove repository files.
The Skill prescribes inspect → Domain metadata → selected domain.md → Document metadata and prerequisites → explicitly
selected bodies; Runtime supports but does not enforce that reading sequence.

## `repository.inspect`

Inspection discovers the current layout and reports context state (`absent`, `legacy`, `ready`, `invalid`), sourceState,
the available Context fingerprint, metadata state/layout, counts and an active-run hint. A successful call may still
report invalid knowledge with diagnostics. Bad records or unsafe resources can also produce a failed response; callers
must inspect both product status and the returned facts.

Default inspection is formal-only. Optional selectedDocumentIds runs real source/confirmation checks and returns
per-Document confirmation items; unknown IDs fail rather than being silently dropped. This is not a persisted freshness
field. A current layout also reports its validated confirmationCount, including historical records.

Alternatively, migration: true previews the unique legacy entry, reporting eligible, strategy, documentCount,
importCount, planFingerprint and paged import/skip items. Preview uses import-trusted; the write command must explicitly
choose a strategy. Migration preview and selectedDocumentIds cannot be combined. Structural eligibility does not establish
Git state, lock ownership or semantic correctness of current content.

## `confirmation.check`

Input has optional scope (default repository) and explain (default false). Current Markdown, canonical record storage
and actual selected sources determine each item: matched, unmatched or unavailable. Complete source facts are required
for a currentKey; matchedKey is returned only for an exact record. documentContentKnown means some historical record has
the same front matter and body, not that the current sources were confirmed.

With explain enabled, reasons use NO_CONFIRMATION, SOURCE_BASIS_CHANGED, DOCUMENT_CONTENT_UNKNOWN or SOURCE_UNAVAILABLE.
No mutable review flag is written. Without explain, reasons are empty but the state and content-known fact remain.

The response reports scope kind/requestFingerprint, structureState, recordStore state/coverage, sourceState,
snapshotFingerprint, summary and paged items. Summary covers the whole snapshot, not the page: documents is the repository
Document count, checked is the selected count, matched+unmatched+unavailable=checked, and checked+unchecked=documents.
An empty path selection is successful with no items and unchecked sources. Record integrity is currently checked across
the repository even when source matching is local; coverage does not imply all sources were read.

The implementation reads Context and selected source evidence twice and rejects changes. Path selection also rechecks
its source expansion. Cursors bind the request and snapshot. A success with unavailable or unmatched entries is not a
passing CI gate; the consumer must apply its explicit policy after reading the complete result.

## `frontier.query` — the depth projection

`depth` is required. Depths 2 and 3 require at least one selector; depth 1 does not. `requiresClosure` is rejected
outright at depth 1 (`REQUEST_FIELD_INVALID`) rather than ignored.

| Depth | Returns |
|---|---|
| 1 | one metadata item per matching Domain — specifically that Domain's `domain.md` |
| 2 | metadata for every matching Document |
| 3 | same as 2, plus bodies for a restricted subset |

**The depth 3 body rule is the sharpest edge in this Domain.** Bodies are returned only for ids that appear literally in
`selectors.documentIds`. A Document pulled in by `domainIds`, `kinds`, a relation selector, `codePaths`, or by
`requiresClosure` gets metadata only — even at depth 3, even though it is in the result. Asking for a Domain at depth 3
therefore yields no bodies at all. To read a body you must name it.

Selectors compose differently per depth. At depth 1 they *filter* the Domain list, so multiple selectors intersect. At
depth 2 and 3 they *seed*, so multiple selectors union, and each seed carries human-readable `reasons` explaining why it
is present. Domain Documents sort first, then by id.

`selectors.codePaths` entries are `sourcePattern` values — globs allowed, same language as `code.paths` and
`scope.paths` (`assertSourcePattern`). Matching is two-way via `pathSelects`: a Document is selected when
`declarationMatches(pattern, selector)` or `declarationMatches(selector, pattern)`. That approximates set overlap; a
mid-segment wildcard on both sides (`packages/*/a.ts` selected by `packages/foo/**`) is missed.

`requiresClosure: true` walks `requires` transitively via `requiresClosure` in `graph.ts`, recording each id's reasons —
`selected`, or `required by <id>`. Each id is expanded once, so the walk terminates even on a cycle; cycles are rejected
by validation (`DOCUMENT_REQUIRES_CYCLE`) as a prerequisite-ordering rule, not because the walk depends on them being
absent.

## `graph.validate`

This capability returns success or failed, accepts no budget/cursor and never gives a partial page. It requires a valid
current-format graph, complete readable sources and a valid confirmation store. It returns contextFingerprint,
domainCount, documentCount, relationCount and sourceDeclarationCount.

It does not require every current tuple to be matched and does not return the old DOCUMENT_REVIEW_PENDING warning.
Use confirmation.check for that separate question. Unavailable sources, malformed records, unsafe paths and hard resource
limits still fail strict validation. Ordinary structure-only reads can remain usable when a source is unavailable.

## `growth.measure`

Reports current size metrics, the `convergence` baseline from Meta if present, the delta, per-Domain breakdowns, and
convergence candidates. Metrics are `documentCount`, `frontMatterBytes`, `bodyBytes`, and `estimatedTokens` (again
`bytes/3`).

Four candidate heuristics, all in `growthCandidates`:

| Kind | Trigger |
|---|---|
| `duplicate` | two or more Documents share both kind and normalized body fingerprint |
| `fragmented` | a Domain holds three or more bodies under 256 bytes |
| `concentrated` | a Domain holds ≥4 Documents and more than half of all Documents |
| `orphaned` | a non-Domain Document with no incoming `requires`/`related`, no outgoing ones, and no `code.paths` |

These are review prompts, nothing more. `growth.measure` never triggers a write and the transaction plane never consults
it. The 256-byte threshold is worth knowing when authoring: a body below it counts toward fragmentation.

## `feedback.match`

Takes four non-empty strings (`context`, `observedBehavior`, `outcomeOrCorrection`, `reuseBoundary`) and returns a
`suggestedId` plus term-overlap matches against existing `.scratch/feedback/*.md` files and every formal Document of kind
`reflection`.

Matching is bag-of-words: NFKC normalize, lowercase, collapse whitespace, extract letter/number runs, intersect. Each
match reports up to 12 shared terms as reasons. It is a retrieval hint, not a similarity judgment — there is no scoring
and no threshold.

`suggestedId` is `<ascii-slug>-<8 hex>`, where the slug comes from the first four word-runs of context plus observed
behaviour (capped at 48 characters) and the hash is the first 8 hex of SHA-256 over the four *normalized* fields. The
identity deliberately excludes the `Evidence` section, so appending evidence to a Feedback file never forces a rename.

Feedback storage is strictly validated: filenames must match `^[a-z0-9]+(-[a-z0-9]+)*-[a-f0-9]{8}\.md$`, the body must
carry exactly the five headings `Context`, `Observed behavior`, `Outcome or correction`, `Evidence`, `Reuse boundary` in
that order with every section non-empty, and the filename must equal the recomputed identity. Violations fail the whole
call with `FEEDBACK_FILE_INVALID`, `FEEDBACK_FORMAT_INVALID`, or `FEEDBACK_IDENTITY_INVALID` — one malformed Feedback
file breaks the capability for everyone, so hand-editing these files is risky.

Note that `Evidence` here is a Feedback heading, unrelated to Git evidence and to declared source evidence.
