---
schema: plugydown.context.document/v1
id: authority-workflow.describe-mechanisms-not-rewritten-values
description: Prose that quotes a value an automated step rewrites goes false at every rewrite while the mechanism stays true, so a Document should describe the mechanism and name where the current value lives.
kind: reflection
domain: authority-workflow
relations:
  requires:
    - authority-workflow
  related:
    - authority-workflow.roles-and-briefs
    - knowledge-model.meta-ledger
    - delivery.packaging
code:
  paths:
    - packages/context/src/internal-roles/recorder.md
---

# Describe mechanisms, not the values an automated step rewrites

## Pattern

Prose that quotes a value an automated step rewrites — a release version, a hash, a generated id, a count that drifts
with routine work — goes false at every such step. The mechanism the prose was written to explain stays true throughout.
Each rewrite therefore turns a correct Document into an incorrect one, and each repair is knowledge-maintenance work
that told the reader nothing new.

## Trigger signal

Either of these means the pattern is present:

- A Document's `code.paths` include a file that releases rewrite, such as a `package.json`, and its body quotes a value
  taken from that file.
- A reaffirm review finds that the only drift in a stale Document is that quoted value.

## The common failure

"Repairing" the Document by updating the value to the new one. This forces an edit where a reaffirm would have settled
the ledger, and it sets up the same failure at the next rewrite, because the new value is exactly as perishable as the
old. Between the rewrite and the repair the Document also asserts something false.

## Correction

Describe the mechanism, name the file that holds the current value, and quote nothing the step rewrites. For example:
state which fields a build configuration forwards from `package.json`, which of them a platform block reuses, and which
exist only in the configuration because npm has no equivalent, then tell the reader to read `package.json` for current
values. That states everything the reader needs and stays true across every release.

## Ledger nuance

`code.paths` hashes file content, so a Document that cites a release-rewritten file still goes stale at each release.
What changes is the outcome: the Document is still true, a review finds it accurate, and it is settled through
`reaffirmedDocumentIds` without an edit. Drop the path from `code.paths` only if nothing else in the Document depends on
that file; otherwise the Document loses the signal that would catch a real change to the mechanism.

## Boundary test

If the claim stays true when only the value changes, do not recite the value.

## Counter-examples

The pattern does not apply when the value is the knowledge:

- A `reference` that lists capability names, required fields, or error codes quotes them exactly, because the reader needs
  the literal. A renamed protocol field making such a Document stale is the correct signal, since the claim itself
  changed.
- A count the build enforces, and a constant that is bumped deliberately, such as `fingerprintVersion`, are knowledge.
  Changing either is a decision someone made, not a side effect of routine work.

## Evidence

`delivery.packaging` quoted the package version and was updated in place as releases moved it. The 0.2.0 and 0.3.0
releases (68ace94, d0a4a14) each made the recital false again, and bb91892 replaced it with a mechanism description. The
Recorder role definition (`packages/context/src/internal-roles/recorder.md`) now carries the rule.
