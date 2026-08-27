---
description: Route, read, and maintain persistent repository knowledge with bounded context.
invocation:
  user: true
  model: true
---

# Plugydown Context

Persistent repository knowledge lives in `context/`. Read only what the current task needs,
and keep the knowledge honest when the repository changes.

## When this applies

Any task in a repository that has a `context/` directory. If `context/` is absent, mention
that `init` can establish it — do not create knowledge files by hand.

## Reading: progressive, never wholesale

There is no startup pack and no mandatory read set. Work the four levels and stop at the
first one that answers the task:

```text
L0  repository tree            → what Domains exist
L1  candidate Domain metadata  → which Domain is relevant
L2  document metadata          → which documents matter
L3  selected body / source     → the actual facts
```

Rules:

- After selecting a Domain, read its `domain.md` first. It carries purpose, boundary,
  invariants, vocabulary, and navigation.
- Load deeper prerequisites only by following `relations.requires`. Do not read a whole Domain.
- Every read is budgeted. When the Runtime returns a continuation cursor, the result was
  paginated, not truncated — continue only if the task still needs more.
- Stop reading as soon as you can act. Unused context is cost, not safety.

See `references/frontier.md` for selector and budget details.

## Session state

Maintain `PLUGYDOWN_CONTEXT_STATE` across the task: active goal, next action, selected
Domain/document IDs, key facts already loaded, relevant fingerprints, user decisions and
scope, changed files, and unresolved risks.

After a context compaction, if that state survived and fingerprints have not changed,
continue the task directly — do not re-read this Skill, `domain.md`, or bodies you already
loaded. See `references/context-continuation.md`.

## Ending a task

Judge two things before you finish. See `references/task-completion.md`.

1. **Feedback** — did the user correct a stable tendency, did a consequential failure repeat,
   or did a strategy prove itself again? Record it as temporary feedback. One-off preferences
   and inconsequential choices are not worth recording.
2. **Update** — did anything *persistent* change: architecture, contracts, SOPs, conventions,
   Domain capabilities, relations, or code paths? Suggest `update`. Pure implementation detail
   that leaves the knowledge accurate is not a reason to suggest it.

After an `update`, the Runtime reports knowledge growth. If it crossed the growth threshold,
suggest `prune` once.

## Boundaries

- This Skill routes and reads. It does not edit `context/` — only the `init`, `update`, and
  `prune` workflows write, and every write goes through a transaction.
- It does not perform Git, hashing, graph, or transaction logic itself. That is the Runtime's
  job, and the Runtime is authoritative for those facts.
- It does not read, detect, or convert knowledge directories belonging to other tools.
