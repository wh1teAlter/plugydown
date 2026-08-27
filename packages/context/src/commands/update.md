---
description: Synchronize persistent knowledge with repository changes.
requires:
  skills:
    - context
---

# Update Plugydown Context

Bring `context/` back in line with what the repository actually is now.

## Start from the delta, not from intuition

Ask the Runtime for the delta first. It merges four inputs:

1. historical fingerprints from `meta.json`
2. the current document graph and source fingerprints
3. Git committed range, staged, unstaged, and untracked changes
4. the scope you declare and the evidence from the task just completed

It returns changed candidates, direct impact, an expanded closure **with a reason for each
expansion**, unmapped paths, broken relations, Light/Deep signals, and whether the repository
baseline is eligible to advance.

## Light or Deep

Light is available only when **all** of these hold:

- meta, schema, and baseline are usable
- changes map to a bounded set of existing documents
- the impact closure is unambiguous
- no Domain split or merge, and no unknown new capability
- no cross-Domain contract uncertainty
- no unresolved paths, factual conflicts, or scope gaps
- the current task context or delta explains the intent

Any one failing → **Deep**. Discovering unknown impact mid-edit → escalate to Deep.

Deep may run one or more Investigators. There is still exactly **one** Recorder.

Escalation does not require a second confirmation. Only leaving the authorized scope does.

Commit and file counts are soft signals. They never decide the mode on their own.

## Workflow

```text
delta + scope
→ Light or Deep
→ evidence
→ Recorder synchronize candidate
→ optional authorized promotion
→ validation → semantic review → concurrency check → commit
```

## Feedback promotion

Only when the user authorizes it as part of this update's scope. The Recorder verifies that
the evidence is sufficient, picks the owning Domain, checks for duplication, and states the
limits of reuse before writing a formal Reflection.

Insufficient evidence does not block the rest of the authorized scope — but the report must
say plainly that the candidate was **not** promoted.

## Baseline

- Full-repository scope, complete success, persistable revision, Git not mid-operation, and no
  missed committed change → advance the repository baseline.
- Partial success → update the per-document ledger only. **Do not** advance the baseline.
- Working-tree state may inform the knowledge, but it can never fabricate a committed baseline.

## After committing

Ask the Runtime for the growth report. If it crossed the threshold against the last
convergence baseline, suggest `prune` — once for that baseline.
