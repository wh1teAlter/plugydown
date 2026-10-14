---
schema: plugydown.context.document/v1
id: write-plane.scope-authorization
description: How a scope authorizes Documents rather than actors, why the Runtime is role-blind, and the refreshedDocumentIds rule that keeps unchanged siblings visible to the next delta.
kind: architecture
domain: write-plane
relations:
  requires:
    - write-plane
    - write-plane.transaction-lifecycle
code:
  paths:
    - packages/context/src/runtime/transaction.ts
---

# Scope authorization

## Scope authorizes Documents, never identities

The Runtime has no concept of who is calling. There is no actor field, no role, no credential anywhere in the request
grammar. What a transaction carries instead is a **scope**, and validation converts that scope into a set of Document ids
that may differ between live and candidate. Anything outside that set must be byte-identical on both sides.

This is why the Runtime is described as role-blind. The Investigator/Recorder/Reflector separation in
`authority-workflow` is a prose contract executed by the host. The Runtime cannot tell a Recorder from a user with a text
editor — it only checks *which Documents changed*, which is a property of the candidate tree, not of who wrote it.

The practical upshot: scope is a safety net against accidental over-reach, not an access control mechanism. A caller that
declares `{kind: 'repository'}` has authorized everything.

## The four scope kinds

`authorizedDocumentIds` computes the set from the union of live and candidate Document ids:

| Scope | Authorized set |
|---|---|
| `{kind: 'repository'}` | every Document in either tree |
| `{kind: 'documents', ids}` | exactly those ids, verbatim |
| `{kind: 'domains', ids}` | every Document whose live **or** candidate `domain` is listed |
| `{kind: 'paths', paths}` | Documents whose actual source paths intersect the patterns |

`documents` scope is taken verbatim — an id not present in either tree is still "authorized", which costs nothing since a
nonexistent Document cannot differ.

`domains` scope checks both sides, which is what allows a Document to be *moved* between Domains: authorizing both the old
and new Domain covers the move.

`paths` scope is the most involved. For each Document it builds the union of:

- source files currently matched by the live Document's declarations
- source files matched by the candidate Document's declarations
- changed paths from the Git evidence that match either side's declarations

then authorizes the Document if any of those paths matches any scope pattern. Including Git-changed paths matters for
deletions: a file that no longer exists cannot be matched by expansion, but it does appear in the Git evidence, so the
Document that used to own it is still authorizable.

`authorizedDocumentIds` takes only the candidate-side path map it actually reads, not a whole source-facts record, which
is what lets `begin` call it with an empty map: at that point no candidate exists yet, so the live tree is passed as both
sides. `begin` uses it to prove every `reaffirmedDocumentIds` entry is inside the grant — reaffirming outside scope would
settle a ledger the authorization never covered.

## Detecting out-of-scope mutation

`scopeMutationIssues` walks every id in either tree and flags those that are unauthorized **and** not `sameDocument` on
both sides. `sameDocument` compares physical path, front-matter fingerprint, and body fingerprint. So:

- creating, deleting, or editing an unauthorized Document is a violation
- *moving* an unauthorized Document is also a violation, because the path differs
- reformatting an unauthorized Document in a way that normalizes away is **not** a violation, since the body fingerprint
  is computed on the normalized body

The first offending id, sorted, is reported as `CANDIDATE_SCOPE_VIOLATION` with its path, and the outcome is
`candidate_edit_required` — repairable in place.

## Prune coverage

`prune` adds one more check. `pruneCoverageIssues` collects every source path the live tree currently covers and every
path the candidate covers, and reports any path present before and absent after as `PRUNE_COVERAGE_LOST`. Convergence may
merge, split, or rewrite knowledge, but it may not quietly stop covering a file that was covered. That is the mechanical
half of the accountability rule stated in `packages/context/src/commands/prune.md`; the semantic half — that every removed
fact has a named survival location — is prose only.

## The `refreshedDocumentIds` rule

`deriveMeta` needs a ledger entry for every Document in the candidate. It has two sources: freshly computed entries from
the candidate expansion, and the live Meta's existing entries. The choice is made by `refreshedDocumentIds`, which returns
Documents that are **both** authorized by scope **and** actually rewritten in the candidate (not `sameDocument`).

Everything else keeps its live entry verbatim.

This is deliberate and easy to get wrong. Consider an authorized Document whose declared source files changed but whose
prose was not touched. If the transaction refreshed its ledger anyway, the new ledger would record the current source
fingerprint — and the Document would then look synchronized when in fact nobody had reconciled the prose with the new
source. The pending impact would vanish from the next `delta.compute`, silently.

By refreshing only Documents that were actually rewritten, an authorized-but-unchanged sibling keeps its stale ledger
entry, and the next delta still reports it as impacted. Staleness is preserved rather than laundered.

If a required ledger entry cannot be found from either source, `deriveMeta` raises `CANDIDATE_LEDGER_INCOMPLETE` — it
refuses rather than inventing an entry. This is a **defensive guard, not a reachable outcome** on the obvious route: the
scope check runs before `deriveMeta`, so a scoped update that introduces a Document outside its authorized set surfaces as
`CANDIDATE_SCOPE_VIOLATION` first. No test reaches the ledger fault.

Validation then re-checks the derived result: for every refreshed id, the Meta entry written into the candidate must match
the freshly recomputed source fingerprint, or the outcome is `candidate_edit_required` with `CANDIDATE_SOURCE_STALE`.
