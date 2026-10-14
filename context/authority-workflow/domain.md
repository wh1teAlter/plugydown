---
schema: plugydown.context.document/v1
id: authority-workflow
description: The prose authority model shipped as skills, commands, and internal roles — separation of duties, the Role Brief, the scratch lifecycle, and which of these rules the Runtime actually enforces.
kind: domain
domain: authority-workflow
relations:
  related:
    - write-plane.scope-authorization
    - read-plane
code:
  paths:
    - packages/context/src/skills/context/SKILL.md
    - packages/context/src/commands/update.md
---

# Authority workflow

Half of this product is Markdown. The Runtime enforces mechanical safety; the prose decides who may do what, in which
order, and on whose authority. Both halves ship together and neither works alone.

The prose lives in:

- `packages/context/src/skills/context/SKILL.md` — the operating skill: routing, reading ladder, statuses, the write
  contract, scratch lifecycle, compact state, reporting
- `packages/context/src/skills/context/references/runtime.md` — the sole invocation reference: locating the executable,
  collecting Git evidence, forming requests, interpreting outcomes
- `packages/context/src/commands/{init,update,prune}.md` — the three authorized write workflows
- `packages/context/src/internal-roles/{investigator,recorder,reflector}.md` — the three role definitions

## What lives here

- `authority-workflow.roles-and-briefs` — separation of duties, the Role Brief, and the write contract.
- `authority-workflow.scratch-lifecycle` — the five scratch collections, naming, and ownership.
- `authority-workflow.enforcement-boundary` — the explicit list of what the Runtime enforces versus what is convention.
- `authority-workflow.describe-mechanisms-not-rewritten-values` — why Documents describe a mechanism and name where its
  current value lives, rather than quote a value an automated step rewrites.

## The central claim

**The Runtime is role-blind.** It authorizes Documents, not actors (see `write-plane.scope-authorization`). Every
statement about who may write, who may review, and who may approve is a convention executed by the host assistant. This
is not a defect — a prose model is the only kind available when the actors are language models — but it must never be
described as if the Runtime guaranteed it. `authority-workflow.enforcement-boundary` exists to keep that line visible.

## The one shared write contract

All three commands use the same sequence, from `SKILL.md`:

```
resolve authorization and scope
→ collect Git evidence and deterministic signals
→ Update only: review impacted Documents; keep the IDs found still accurate
→ transaction.begin (Update passes those IDs as reaffirmedDocumentIds)
→ one Recorder edits the complete candidate
→ transaction.validate
→ semantic review of the validated candidate
→ Main Assistant approval bound to candidateFingerprint and sourceEvidenceFingerprint
→ transaction.commit
→ clean workflow-owned Investigation and promoted/discarded Feedback
→ concise user report
```

Of that sequence the Runtime enforces the ordering of `begin` → `validate` → `commit`, the fingerprint binding, and the
scope check. It does not enforce that exactly one Recorder edited the candidate, that a review happened, or that the
approver was not the author. The Update-only review is likewise convention: the Runtime checks that each reaffirmed id
names a Document inside the authorized scope, not that anyone read it.
