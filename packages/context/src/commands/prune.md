---
description: Converge duplicated, fragmented, or bloated knowledge without losing coverage.
requires:
  skills:
    - context
---

# Prune Plugydown Context

Reduce the size of formal knowledge **while preserving everything that is uniquely locatable
there**. Shrinking the numbers is not the goal; shrinking them without losing knowledge is.

Run this after knowledge is up to date, or when the user asks directly.

## Workflow

```text
growth candidates
→ Investigator verifies unique knowledge and code coverage
→ Recorder converge plan and candidate
→ before/after validation
→ semantic review
→ commit
```

The Runtime produces the growth report against the last convergence baseline: document count,
front-matter and body bytes, conservative tokens, per-Domain size and hotspots, deterministic
duplicate candidates, and fragmentation signals.

These are **candidates**. Nothing is merged or deleted because a metric said so.

## Every operation is accountable

For each merge, rewrite, delete, or split, record:

- where the content came from
- where it survives
- what makes it unique
- which relations are affected
- the expected size change
- how it will be verified

An Investigator confirms unique knowledge and code coverage before the Recorder converges.

## Success requires all of these

- uniquely locatable knowledge is still locatable
- hard `code.paths` coverage did **not** decrease
- the graph has no dangling edges
- Domain routing is still clear
- document count, bytes, and conservative tokens actually decreased

If size dropped but coverage dropped with it, the prune failed.

## Never

- create a formal archive
- move content out of the retrieval path to manufacture a decrease
- promote feedback
- delete by age
- delete human-authored knowledge you cannot account for

The first two are the tempting ones. Both turn a real convergence problem into a hidden one,
and the before/after validation exists specifically to reject them.

## Result

On success the transaction commits Markdown and `meta.json` together and records a new
convergence baseline. Report every operation, the before/after metrics, and the verification
that coverage held.
