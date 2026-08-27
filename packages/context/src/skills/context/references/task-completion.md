# Ending a task

Two independent judgements. Neither is automatic, and neither is a hook's job.

## 1. Is there feedback worth keeping?

Record temporary feedback when:

- the user corrected a **stable tendency**, not a one-off detail
- a consequential failure or omission **repeated**
- a strategy **proved itself again**
- an existing Reflection was hit again and may need calibration
- the user explicitly asked to record something

Do **not** record: one-time choices, incidental preferences, or attempts without consequence.

Feedback is temporary evidence. It lives outside formal knowledge and can be deleted without
damaging anything. It becomes a formal Reflection only through an authorized `update` with
sufficient reviewed evidence — there is no case count and no maturity score that promotes it
automatically.

Keep each entry to what is reusable: context, observed behavior, the feedback or outcome, the
attempted correction, and the limits of reuse. Not a transcript.

## 2. Should knowledge be updated?

Suggest `update` only when something **persistent** changed:

- architecture, contracts, SOPs, or conventions
- Domain capabilities
- formal knowledge became wrong
- relations or `code.paths` changed
- a promotable feedback candidate exists

Do **not** suggest it for implementation detail that leaves the knowledge accurate. A refactor
that preserves every documented invariant is not an `update` trigger.

Manual invocation of a write command authorizes that run's declared scope. A suggestion you
raise needs one confirmation before it proceeds.

## 3. After an update

The Runtime measures knowledge growth against the last convergence baseline (set by the last
successful `init` or `prune`).

If growth crossed the threshold, suggest `prune` — **once** per baseline. Do not repeat the
suggestion on every subsequent update against the same baseline.

Duplicate-looking documents reported by the Runtime are candidates for review, not evidence of
bloat on their own. A genuinely new Domain legitimately increases size.
