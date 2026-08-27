---
description: Establish persistent repository knowledge in context/ for the first time.
requires:
  skills:
    - context
---

# Initialize Plugydown Context

Build the first Domain set and document body for this repository, then commit it through a
transaction.

## Preconditions

Check before doing anything else:

| Situation | Action |
|---|---|
| `context/` absent | Proceed |
| A recoverable init run exists | Offer to resume it |
| Valid `context/` already present | Stop; suggest `update` instead |
| `context/` present but unreadable | Stop and report the specific damage |
| `context/` severely stale | Report the rebuild risk; do **not** overwrite anything |

Severely stale means no reliable incremental correspondence can be established — most hard
`code.paths` are gone, the Domain topology no longer matches the repository, or `meta.json`
and the Markdown cannot be reconciled. Explain that the user may back up and delete
`context/` themselves and re-run init. Never delete it automatically.

Other tools' knowledge directories are not part of this check. Do not look for them.

## Workflow

```text
repository inventory
→ complementary investigations
→ coverage and conflict follow-up
→ Recorder bootstrap candidate
→ deterministic validation + semantic review
→ concurrency check + commit
```

### Investigations

Split by **complementary engineering questions**, not by directory. Useful axes:

- business capabilities
- runtime and data flow
- API and integration surfaces
- build, test, and release
- cross-cutting protocols specific to this repository

Slicing the tree into arbitrary folders produces overlapping, low-value reports.

Each investigation runs with an explicit task envelope. Investigators report confirmed facts
with evidence locations, separated from inference and unverified assumption. Follow up on
coverage gaps and conflicts before recording anything.

### Recording

One Recorder, in bootstrap mode. It decides Domain boundaries, document kinds, relations, and
granularity from the collected evidence.

Requirements:

- cover the repository's principal surfaces
- establish a **minimal** Domain set — a Domain must be independently understandable,
  maintainable, and convergeable
- every Domain gets a `domain.md`
- write bodies only where they carry real value: invariants, causality, cross-file relations,
  easily-misused boundaries, repeatable SOPs
- no empty `design/`, `manual/`, or `reflections/` directories
- no root index file

## Failure

If repository-wide evidence is insufficient, keep the temporary material and return
`incomplete`. A partial init committed as if complete is worse than no init — it makes the
knowledge look trustworthy when it is not.

## Result

On success the transaction commits the Markdown and `meta.json` together, and records a
convergence baseline. Report the Domains created, documents written, evidence used, and the
final state.
