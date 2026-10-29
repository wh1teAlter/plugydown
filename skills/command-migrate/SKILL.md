---
description: Explicitly migrate legacy Context ledgers into immutable confirmation records.
name: command-migrate
---
# Migrate Plugydown Context

Load the Context Operating Skill and Runtime reference. Migrate is a one-time format conversion, not a recurring step
following rebase. Finish any Git operation and use the compatible old Runtime to resolve old active transactions first.

The 0.8 to 0.9 plugin upgrade keeps format=1 and does not use Migrate.

1. Call `repository.inspect` with `migration: true`; follow the complete paged plan. Only structurally valid legacy
   Context qualifies. Content fingerprint mismatch is allowed; duplicate IDs, unsafe paths, broken relations, conflict
   markers, malformed ledgers and simultaneous old/new entries are not.
2. Confirm the intended trust strategy from existing authorization. `import-trusted` imports the exact old tuples except
   records marked `reviewRequired: true`. `reconfirm` imports none. There is no implicit write default. Neither strategy
   reviews current content or clears an outstanding legacy review by recalculating its hashes.
3. Begin `migrate`, Deep, repository scope, with the explicit `migrationStrategy`. An empty `evidencePaths` array is valid:
   historical conversion binds the original Context snapshot and resulting candidate, not current deleted source files.
   Any explicitly supplied evidence must remain readable and unchanged. No Recorder edits the candidate.
4. Validate a dry-run when a preview is needed. It terminates and cleans the run; a real conversion requires fresh Git
   evidence and a new non-dry run. Investigator reviews exact Markdown paths, bytes and permissions, imported/skipped
   evidence, baseline preservation and removal of the old root meta.json only in the candidate.
5. Main Assistant approves candidate/source-evidence fingerprints and commits. Runtime switches the whole directory
   using the same recovery mechanism as Update. `MIGRATION_ROLLED_BACK` means the original legacy snapshot was restored.
6. Check confirmations and source validity after conversion. Unmatched or unavailable inputs remain visible and can be
   addressed by a separately authorized, targeted Update in this checkout. Coordinate client/CI upgrades before merging
   the converted data; the new format is not writable by old clients.
