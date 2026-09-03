---
description: Synchronize authorized persistent repository changes into Plugydown Context.
requires:
  skills:
    - context
---

# Update Plugydown Context

Load the Context Operating Skill first and follow its Runtime, status, Role Brief, approval, and reporting rules.

1. Call `repository.inspect`, collect Git evidence, and call `delta.compute` with the user-authorized scope and current
   task evidence. Stop or resume when Context/run state requires it.
2. Use Light only when Runtime blockers are empty and intent, mapping, impact closure, Domain shape, cross-Domain
   contracts, and scope are all known. Otherwise use Deep. Expanding beyond authorization requires user approval.
3. Deep may use complementary Investigators; Light may proceed from complete current evidence. Use exactly one
   Recorder with a `synchronize` Role Brief and allow writes only in the returned complete candidate.
4. Include temporary Feedback only when the user authorized those IDs in this Update. Reflector evaluates reuse
   evidence; Recorder may use `promote` within the same candidate. Evidence gaps do not block unrelated authorized
   changes. Delete only successfully committed promoted Feedback; keep unpromoted or failed-promotion items.
5. Validate, semantically review the entire candidate, bind Main Assistant approval to both returned fingerprints,
   then commit. Any candidate/source/formal change requires validation and review again.
6. Report status, mode, scope, knowledge changes, unpromoted Feedback, fingerprints, and transaction outcome. After a
   successful change, use `growth.measure` only to decide whether to suggest Prune.
