---
description: Review changed Context inputs and update only the authorized knowledge that needs editing.
name: command-update
---
# Update Plugydown Context

Load the Context Operating Skill and its Runtime reference first.

1. Inspect the repository and resume an active run. Legacy data requires explicit Migrate first. A missing matching
   confirmation is not structural damage: proceed with Update without Repair. Invalid Markdown, relations or records
   require a concrete correction; never hide an error by recomputing a hash.
2. Call `confirmation.check` for the authorized scope. If Git history helps explain changes, collect fixed Git evidence
   and use `delta.compute`. `confirmationMismatches` are review candidates; `requiredContext` is reading context,
   not an instruction to rewrite it. `outOfScopeAffected` is informational and does not expand authorization.
3. Choose Light for known intent, complete mapping, a small understood change and no uncertain cross-Domain contracts.
   Otherwise use Deep and Investigator review. Runtime reports facts, not semantic mode eligibility.
4. Review the selected mismatches against their current sources. For each Document distinguish `accurate`, `needs edit`
   and `not verified`. Supply only actually reviewed, still-accurate IDs as `confirmedDocumentIds` at begin. This allows
   confirmation without changing Markdown. Missing sources can be corrected in the candidate; do not restore fake files.
5. Begin `update`. One Recorder edits only authorized candidate Markdown and source declarations. Runtime owns `.meta`;
   no role edits or deletes confirmation files. Explicitly confirmed Documents may still be edited if review finds a gap.
6. Promote Feedback only when its IDs are authorized and Reflector established reusable evidence. Keep failed or
   unpromoted Feedback; delete successfully promoted Feedback after commit.
7. Validate. Review the final candidate and every newly confirmed input tuple, including unchanged Documents listed at
   begin. Deep Update requires Investigator review; Main Assistant can review Light Update. Approve the two returned
   fingerprints and commit. Changes after review require fresh validation and approval.
8. Report edited and confirmed-without-edit IDs, unverified inputs, scope, fingerprints and actual transaction outcome.
   Do not call unmatched inputs structurally broken or claim all documents are accurate. Update never advances baselines.
