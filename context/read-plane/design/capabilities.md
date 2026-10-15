---
schema: plugydown.context.document/v1
id: read-plane.capabilities
description: What each of the five query capabilities returns, the depth 1/2/3 projection and its body rule, requires closure, and the growth convergence heuristics.
kind: architecture
domain: read-plane
relations:
  requires:
    - read-plane
    - knowledge-model.meta-ledger
code:
  paths:
    - packages/context/src/runtime/queries.ts
    - packages/context/src/runtime/graph.ts
---

# Read capabilities

## `repository.inspect`

The one capability with no precondition. It reports `context.state` (`absent` | `ready` | `invalid`),
`context.sourceState`, `context.fingerprint` when the tree exists, `meta.state`, per-category `counts` (omitted when
absent), and `activeRun` when a write lock is present. Formal issues come back as diagnostics even on `success`, which
is how a caller learns *why* a tree is invalid without a second call.

With `selectedDocumentIds` it also returns per-id freshness. Four states:

- `missing` — no such Document
- `source_unavailable` — expansion failed for it, or no ledger could be built
- `fresh` — recomputed ledger equals the recorded Meta entry, compared by canonical JSON
- `stale` — otherwise

Selecting ids switches the source policy from `formal-only` to `selected`, so freshness costs a real filesystem
expansion. Omit the field when you only need the tree state.

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

The strictest capability and the only one with just two possible statuses: `success` or `failed`. No `budget`, no
`cursor`, no partial answer. It demands `formalState: ready` and `sourceState: ready` — nothing else — then returns
`contextFingerprint`, `domainCount`, `documentCount`, `relationCount`, `sourceDeclarationCount`.

It reports every Document whose recorded `sourceFingerprint` differs from the recomputed one, through `reviewPendingIds`
in `graph.ts`. `delta.compute` builds `directImpact` from the same helper (plus Documents whose sources cannot be read),
and `repository.inspect` freshness compares the Documents it selects. Ordinary loading skips the comparison because it
needs filesystem expansion. A difference is **not a failure**: the Document is reported as the warning
`DOCUMENT_REVIEW_PENDING`, with `path` set to that Document's path, on a response whose status is still `success`. Code
changing ahead of knowledge is the normal state of an active repository, so the warning means the next Update has
Documents to settle, never damage. A tree that every other capability calls ready can therefore fail here only through
source evidence: a cited path that cannot be expanded (`sourceState: degraded`), or an expansion that exceeds the source
resource limits (`SOURCE_FILE_LIMIT_EXCEEDED`, `SOURCE_BYTE_LIMIT_EXCEEDED`), which fails the whole request rather than
being attributed to one Document. That is the intended division of labour, not an inconsistency.

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
