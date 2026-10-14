---
description: Synchronize authorized persistent repository changes into Plugydown Context.
requires:
  skills:
    - context
---

# Update Plugydown Context

Load the Context Operating Skill first and follow its Runtime, status, Role Brief, approval, and reporting rules.

1. Call `repository.inspect`, collect Git evidence, and call `delta.compute` with the user-authorized scope and current
   task evidence. Stop or resume when Context/run state requires it. `directImpact` is the complete queue of Documents
   whose cited sources changed since they were last reviewed.
2. Use Light only when Runtime blockers are empty and intent, mapping, impact closure, Domain shape, cross-Domain
   contracts, and scope are all known. Otherwise use Deep. The choice is yours: Runtime reports blockers but does not
   enforce the mode. Expanding beyond authorization requires user approval.
3. Before `begin`, review every `directImpact` Document against its current cited sources — complementary
   Investigators in Deep, the Main Assistant in Light — and give each one verdict with evidence: `accurate` or
   `needs edit`. Pass exactly the `accurate` IDs as `reaffirmedDocumentIds`. Never pass `directImpact` wholesale: a
   listed Document's ledger is settled as reviewed, so listing one nobody read records a review that did not happen.
4. Use repository scope for a full synchronization. Only it can advance the repository baseline, and only when the
   commit leaves no impacted Document unreviewed; a narrower authorized scope is fine but leaves the baseline in place.
5. Use exactly one Recorder with a `synchronize` Role Brief naming the `needs edit` Documents, and allow writes only in
   the returned complete candidate. If review during editing finds a reaffirmed Document wrong after all, edit it:
   reaffirming permits settlement without an edit, it does not forbid one.
6. Include temporary Feedback only when the user authorized those IDs in this Update. Reflector evaluates reuse
   evidence; Recorder may use `promote` within the same candidate. Evidence gaps do not block unrelated authorized
   changes. Delete only successfully committed promoted Feedback; keep unpromoted or failed-promotion items.
7. Validate, semantically review the entire candidate, bind Main Assistant approval to both returned fingerprints,
   then commit. Any candidate/source/formal change requires validation and review again.
8. Report status, mode, scope, which Documents were edited and which reaffirmed, unpromoted Feedback, fingerprints, and
   transaction outcome. After a successful change, use `growth.measure` only to decide whether to suggest Prune.
