---
schema: plugydown.context.document/v1
id: package-context.roles-and-briefs
description: The three internal roles, their write boundaries, the fixed seven-heading Role Brief, and the separation-of-duties rules governing review and approval.
kind: architecture
domain: package-context
relations:
  requires:
    - package-context
  supersedes:
    - authority-workflow.roles-and-briefs
code:
  paths:
    - packages/context/src/internal-roles/investigator.md
    - packages/context/src/internal-roles/recorder.md
    - packages/context/src/internal-roles/reflector.md
    - packages/context/src/commands/update.md
    - packages/context/src/skills/context/SKILL.md
    - packages/context/src/skills/context/references/runtime.md
    - packages/context/src/commands/repair.md
    - packages/context/src/commands/prune.md
    - packages/context/src/commands/init.md
---

# Roles and Briefs

The operating Skill coordinates the reading ladder, authorization, scratch lifecycle and reporting. Its Runtime
reference owns invocation syntax; command documents own Init, Update, Prune and Repair sequencing. The three internal
roles supply semantic authorship and review while Runtime enforces the mechanical transaction.

## The closed role set

Exactly three roles, and the set is build-enforced (see `package-context.packaging`):

| Role | Purpose | May write |
|---|---|---|
| Investigator | establish verifiable facts from code, config, history; review candidates | only an explicitly allowed `.scratch/investigations/<slug>-<hash>.md` |
| Recorder | author formal knowledge | only the one transaction candidate named in its Brief |
| Reflector | evaluate recurring feedback for reusability | only an explicitly allowed `.scratch/feedback/<slug>-<hash>.md` |

Each role's default is to return Markdown inline. Writing a file is the exception, and only to the one path the Brief
names.

The boundaries are stated negatively in each role file, and the negations are the load-bearing part:

- Investigator does not edit source, formal `context/`, or a candidate. It reviews candidates but **does not approve
  them**.
- Recorder does not edit source, live `context/`, or anything outside its candidate. It does not review or approve its own
  work, and any post-validation edit requires validation and independent review again.
- Reflector does not edit source, formal knowledge, or candidates. It does not assign maturity, score, or automatic
  promotion.

## The Role Brief

Every role receives a short Markdown Brief with exactly these headings, in this order:

```markdown
## Goal
## Questions
## Scope
## Evidence
## Allowed writes
## Budget
## Expected result
```

`Allowed writes` is the authorization. Anything not listed is forbidden — the default is deny, not permit. No role may
silently widen Goal, Questions, Scope, or Evidence.

The Brief is also the unit of resumability: Investigation identity is derived from the Brief's goal, questions, and scope,
which is why appending Evidence to an Investigation file never forces a rename.

Note that `Evidence` in a Brief is prose context supplied to the role. It is a fourth distinct use of the word, alongside
the three catalogued in `package-context.wire-contract`.

## Recorder modes

The Recorder Brief selects one of four modes, which correspond to what kind of authorship is being asked for:

| Mode | Responsibility | Used by |
|---|---|---|
| `bootstrap` | establish the minimum complete Domain/Document system | Init |
| `synchronize` | align authorized persistent facts | Update |
| `promote` | make an authorized, evidence-backed Reflection self-contained | Update |
| `converge` | merge, compress, split, move, or delete knowledge | Prune |

The Recorder chooses Domain boundaries, Document kind, relations, `code.paths`, body granularity, and whether evidence
supports a durable statement at all. It is instructed to record invariants, causality, contracts, decisions, repeatable
procedures, and easy-to-misuse boundaries — and explicitly *not* source listings, task narration, per-change history, raw
Feedback, or generic explanation.

Three further Recorder rules keep the ledger honest:

- `code.paths` is declared as the sources a Document's statements rest on, not as coverage, and source directories
  (`packages/foo/src/**`) are preferred to package roots: generated output is usually Git-ignored and exists only where
  it was built, so another clone either lacks it (broken evidence) or holds different bytes (the Document stays pending
  review there).
- Values an automated step rewrites — release versions, hashes, counts, generated identifiers — are not recited. The
  Document describes the mechanism and names where the current value lives. A `reference` whose purpose is exact current
  facts, such as capability names, required fields, or error codes, still quotes them exactly. See
  `development-standards.describe-mechanisms-not-rewritten-values`.
- A Document is never edited only to refresh its ledger. A reviewed, still-accurate Document is settled through
  `reaffirmedDocumentIds`; an edit made for the bookkeeping is the per-change history excluded above.

For `converge`, every affected fact must be accounted for: origin, survival location, uniqueness, relation changes, source
coverage, verification. The rule against hiding growth by moving knowledge outside the retrieval path is why convergence
cannot be satisfied by relocating prose into files the reading ladder never reaches.

## Separation of duties

| Rule | Enforced by |
|---|---|
| The Main Assistant owns authorization scope and final semantic approval | prose |
| Recorder cannot review itself | prose |
| Reflector cannot approve a formal Reflection | prose |
| Init, Deep Update, Prune, Repair, and Feedback promotion require Investigator candidate review | prose |
| Light Update may be reviewed directly by the Main Assistant unless uncertainty appears | prose |
| Approval must be bound to `candidateFingerprint` and `sourceEvidenceFingerprint` | **Runtime** |
| Any post-validation change invalidates the approval | **Runtime** |

Only the last two rows are mechanical. The Runtime cannot tell whether a review happened or who performed it; it can only
prove that the bytes being committed are the bytes that were fingerprinted. That check is genuinely strong — it makes
"approved something, committed something else" impossible — but it says nothing about the quality or independence of the
review.

## Per-command sequencing

- **Init** is always Deep, requires absent formal Context, and uses complementary Investigators to probe capability
  boundaries, runtime and data flow, integrations, build/test/release, and cross-cutting contracts. Insufficient
  repository-wide evidence is reported as `incomplete`, never as a partial initialization.
- **Update** chooses Light or Deep from the `delta.compute` blockers plus whether intent, mapping, impact closure, Domain
  shape, cross-Domain contracts, and scope are all known. Before `begin`, every `directImpact` Document gets exactly one
  verdict with evidence — from complementary Investigators in Deep, from the Main Assistant in Light: `accurate` or
  `needs edit`. `accurate` requires re-reading the Document's cited sources as they are now; a reviewer who could not
  check says so rather than guessing, because the verdict settles the ledger as reviewed. Only the `accurate` ids are
  passed as `reaffirmedDocumentIds`, never `directImpact` wholesale, and the Recorder's `synchronize` Brief names the
  `needs edit` Documents. Feedback promotion happens only here, only for ids the user authorized in this Update.
- **Repair** is always Deep and requires explicit Document IDs. Runtime alone derives content fingerprint and review-obligation changes; no Recorder edits the candidate. Investigator reviews faithful preservation and honest pending status, and Main Assistant approves the current fingerprints. Follow with authorized Update for source semantics.
- **Prune** is always Deep, treats `growth.measure` results only as review candidates, and requires an explicit survival
  location for every merge, move, rewrite, split, or deletion. It must not create an archive, remove content by age, or
  promote Feedback. Explicit content review obligations must be settled through Update first.

The Light/Deep distinction for Update is convention only — the Runtime accepts either mode and behaves identically. See
`package-context.enforcement-boundary`.

## Shared write sequence

Resolve authorization and collect Git evidence, then begin a complete candidate. Update reviews impacted Documents
before begin and passes only verified accurate IDs as reaffirmedDocumentIds. Recorder authors semantic changes; Repair
uses Runtime derivation instead. Validate, perform the required candidate review, bind Main Assistant approval to both
fingerprints, commit and clean only workflow-owned terminal artifacts. The Runtime is role-blind: it cannot prove who
reviewed the candidate or whether the review was independent.
