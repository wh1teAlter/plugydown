---
description: Restore content fingerprint consistency after Git merges while retaining pending source review.
---
# Repair Plugydown Context

Load the Context Operating Skill and its Runtime reference, including the content repair procedure. Repair is Deep
and requires authorization for explicit Document IDs. It preserves merged content; it does not certify its accuracy.

1. Call `repository.inspect` with `repair: true` and the selected IDs. Read the paged plan to establish exact scope.
   Report structural blockers; finish Git operations first. Resume an active Runtime transaction before another write.
   Missing authorization for other mismatched Documents is a scope decision, never permission to repair them silently.
2. Collect Git evidence and begin `repair/deep` with Document scope and `dryRun: true`. Do not pass
   `reaffirmedDocumentIds`. No Recorder edits are needed: Runtime generates the ledger during validate.
3. Validate and report the preview's field changes, schema migration, retained source/baseline records and pending
   review obligations, together with the returned plan and candidate fingerprints. Dry-run artifacts are now cleaned.
4. Within the existing write authorization, collect fresh evidence and start a new run with `dryRun: false`. Validate
   without editing the candidate. Any changed plan needs fresh review; a dry-run approval never authorizes new bytes.
5. Give an Investigator a read-only Brief to review the candidate, checking that merged Markdown survives unchanged,
   only authorized ledger fields change, and affected Documents remain pending review. Approval here is for structural
   consistency, not an assertion that the Documents match their sources. The Main Assistant binds its approval to the
   validated candidate/source fingerprints and commits through Runtime.
6. Inspect the affected IDs and run `graph.validate`. Report restored consistency and all outstanding semantic review.
   Follow with Update when authorized; source-unchanged and source-free Documents still require that review.
7. On failure follow the Runtime outcome. `REPAIR_ROLLED_BACK` means the old mismatched snapshot was restored, not that
   repair succeeded. Preserve conflicting copies, run and lock for manual recovery. Never hand-edit live Meta.
