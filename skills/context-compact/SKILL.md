---
description: Retain bounded Context confirmations through the repository's single mainline maintenance workflow.
name: context-compact
---
# Compact Context confirmations

Use this command only with explicit repository maintenance authorization and its single mainline coordinator. It is
not part of ordinary Update, and must not run independently on development or release branches. A branch name alone
does not establish coordination. Load the Context Operating Skill and Runtime reference.

1. Inspect Context and resume an existing run before starting another. Require valid format=1 data, readable sources,
   a clean isolated checkout and no active Git operation. Freeze the mainline commit in the host.
2. Call `confirmation.retention`. `triggered` recommends batching when an identity exceeds 20 records; an explicitly
   requested compact may run below that threshold.
3. Begin `compact`, Deep, repository scope, without `confirmedDocumentIds`. Runtime alone selects and deletes records.
   Do not ask Recorder to edit the candidate. Active identities retain up to ten records, preserving current exact/content
   matches before covering other content versions. Retired identities retain one real record to prevent directory renames.
4. Validate. `retention_review` requires mechanical review: no new confirmations, identical surviving bytes/modes,
   unchanged Markdown/metadata/baselines and unchanged current confirmation facts. A repository-authorized CI policy may
   approve this result without a model; it does not approve document semantics.
5. Approve the returned candidate and source-evidence fingerprints and commit. Changed sources or permissions require
   abandoning this frozen run and starting from a fresh mainline snapshot. Never reuse the old approval.
6. The host verifies the Git write set and submits the deletion-only change through required PR and merge-queue checks.
   Follow the shipped `integrations/retention.md` guide. A local transaction does not authorize a push or prove remote freshness.

Dry-run, no-change, abandon and recovery use the existing lifecycle. Report retained/deleted counts and preserved current
facts. Historical branch matches may be lost after eviction; do not call this lossless history compaction. Never delete
a whole confirmation identity directory or lower a CI policy. Format=1 remains compatible with 0.8, whose clients may
read and append but cannot execute this command or take over its active transaction. Installation does not enable CI.
