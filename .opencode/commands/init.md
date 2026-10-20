---
description: Establish Plugydown Context for a repository that has no formal Context.
---
# Initialize Plugydown Context

Load the Context Operating Skill first and follow its Runtime, status, Role Brief, approval, and reporting rules.

1. Call `repository.inspect`. Resume a recoverable run; proceed only when formal Context is absent. Stop on ready or
   invalid Context rather than overwriting it.
2. Treat this command as authorized only for the scope the user requested. Init is always Deep.
3. Collect repository inventory and Git evidence, then ask complementary Investigators about capability boundaries,
   runtime/data flow, integrations, build/test/release, and cross-cutting contracts. Reconcile gaps and conflicts.
4. Call `transaction.begin` for `init/deep`. Give one Recorder a `bootstrap` Role Brief whose only allowed writes are
   the returned complete candidate.
5. Call `transaction.validate`. An Investigator reviews the validated candidate for factual accuracy, Domain
   boundaries, repository-wide coverage, and unresolved assumptions.
6. If the candidate and full source fingerprints are unchanged after review, provide Main Assistant approval and call
   `transaction.commit`. Otherwise re-edit, validate, and review.
7. Report status, scope, created Domains/Documents, evidence gaps, fingerprints, validation, review, commit, and any
   recovery outcome. Insufficient repository-wide evidence is `incomplete`, not a partial initialization.
