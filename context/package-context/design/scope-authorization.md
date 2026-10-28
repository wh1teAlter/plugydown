---
schema: plugydown.context.document/v1
id: package-context.scope-authorization
description: "Document-scoped authorization, role-blind enforcement, immutable record ownership and explicit confirmation targets without automatic sibling review."
kind: architecture
domain: package-context
relations:
  requires:
    - package-context.transaction-lifecycle
    - package-context
  supersedes:
    - write-plane.scope-authorization
code:
  paths:
    - packages/context/src/runtime/transaction.ts
---

# Scope authorization

## Scope authorizes Documents, never identities

The Runtime has no concept of who is calling. There is no actor field, no role, no credential anywhere in the request
grammar. What a transaction carries instead is a **scope**, and validation converts that scope into a set of Document ids
that may differ between live and candidate. Outside that set, document paths and normalized content must agree; the exact comparison is described below.

This is why the Runtime is described as role-blind. The Investigator/Recorder/Reflector separation in
`package-context.roles-and-briefs` is a prose contract executed by the host. The Runtime cannot tell a Recorder from a user with a text
editor — it only checks *which Documents changed*, which is a property of the candidate tree, not of who wrote it.

The practical upshot: scope is a safety net against accidental over-reach, not an access control mechanism. A caller that
declares `{kind: 'repository'}` has authorized all Documents, not arbitrary changes to Runtime-owned metadata.

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

- exact declarations from either side, including paths currently missing
- source files currently matched by the live Document's declarations
- source files matched by the candidate Document's declarations
- changed paths from the Git evidence that match either side's declarations

then authorizes the Document if any of those paths matches any scope pattern. Including Git-changed paths matters for
deletions: a file that no longer exists cannot be matched by expansion, but it does appear in the Git evidence, so the
Document that used to own it is still authorizable.

`authorizedDocumentIds` takes only the candidate-side path map it actually reads, not a whole source-facts record, which
is what lets `begin` call it with an empty map: at that point no candidate exists yet, so the live tree is passed as both
sides. `begin` uses it to prove every `confirmedDocumentIds` entry is inside the grant — confirming outside scope would
confirm inputs the authorization never covered.

## Detecting out-of-scope mutation

`scopeMutationIssues` walks every id in either tree and flags those that are unauthorized **and** not `sameDocument` on
both sides. `sameDocument` compares physical path, front-matter fingerprint, and body fingerprint. So:

- creating, deleting, or editing an unauthorized Document is a violation
- *moving* an unauthorized Document is also a violation, because the path differs
- reformatting an unauthorized Document in a way that normalizes away is **not** a violation, since the body fingerprint
  is computed on the normalized body

Out-of-scope mutation is reported as `CANDIDATE_SCOPE_VIOLATION`, and the outcome is
`candidate_edit_required` — repairable in place.

## Prune coverage

`prune` adds one more check. `pruneCoverageIssues` collects every source path the live tree currently covers and every
path the candidate covers, and reports any path present before and absent after as `PRUNE_COVERAGE_LOST`. Convergence may
merge, split, or rewrite knowledge, but it may not quietly stop covering a file that was covered. That is the mechanical
half of the accountability rule stated in `packages/context/src/commands/prune.md`; the semantic half — that every removed
fact has a named survival location — is prose only.

## Confirmation targets

refreshedDocumentIds selects authorized surviving Documents that are new, whose canonical front matter/body changed,
or whose ID is explicitly listed in confirmedDocumentIds. deriveRecords constructs their complete current tuples from
fully readable source facts. A legal physical move alone does not change a key or trigger a new confirmation. ID changes
create a new identity and must be authorized together with removal of the old Document.

Every original confirmation remains immutable, including records for deleted Documents. A source-changed but unedited,
unlisted Document receives no new record merely because it shares the scope. Its mismatch remains visible when selected
again. The caller's explicit confirmation list is a claim of review; Runtime cannot prove that the review occurred.
Unknown or out-of-scope confirmation IDs are rejected at begin before taking the lock.

assertManagedCandidate protects original record bytes and permissions and rejects role-authored metadata or unowned
records. Derived file identities are registered in the run manifest before writing. Revalidation can remove obsolete
records generated by that run, but cannot remove historical evidence. Final validation rechecks scope, sources, expected
records and metadata. Commit/resume revalidate the approved inputs.

## Baselines and migration

Update never advances repository or convergence baselines, even with repository scope and all inputs matched. Init and
Prune establish convergence under their own rules; the repository baseline is preserved historical data.

Migrate requires Deep repository scope and an explicit import-trusted or reconfirm strategy. It preserves every Markdown
byte, path and permission and both baselines; only the metadata layout and historical record representation change.
Missing current sources do not prevent that conversion. The migration approval does not certify current source semantics,
and confirmedDocumentIds is not a Migrate input.
