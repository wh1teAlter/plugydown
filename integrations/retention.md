# Central confirmation retention

Context 0.9 keeps the 0.8 on-disk format, canonical four-field JSON and key algorithms. Existing clients can read and
append records without a migration. Only the maintenance worker needs the new Runtime. Ordinary Update and Prune do
not delete historical records.

The repository must have one maintenance producer. Independent cleanup in development branches can create Git
rename/rename conflicts. Do not enable a second producer in a release branch or a developer checkout.

## Retention policy

- Retain up to ten records per active document, protecting current exact/content matches before other content versions.
- Retain one real record per retired document ID. Keeping that directory prevents Git directory-rename inference from
  relocating confirmations from older branches.
- Trigger automatic batching when any identity exceeds twenty records. These are cleanup targets, not read limits.
- Keep all surviving bytes, modes, Markdown, source declarations and baselines unchanged. No new confirmation is created.

After cleanup the record bound is ten times active identities plus retired identities. Unmerged development branches
may contain additional records. Earlier history may no longer match after eviction; that is a review signal, not
structural damage. No fixed total Git-history size is promised.

## Install the PR and merge-queue integration

The two supplied YAML files are repository workflow templates, not activated plugin hooks. Review and copy them to
the business repository's .github/workflows directory. They assume the primary branch is main; update both templates
together if the repository uses a different primary branch.

1. Keep .scratch/ ignored. No npm dependencies, models or personal plugin installation are needed by the worker.
2. Set CONTEXT_DISTRIBUTION_REVISION to a verified full commit SHA from the official release-codex distribution branch
   for Context 0.9 or newer. The context--vVERSION source tag is not a distribution. Both workflows load the same pinned
   official Runtime and adapter; they do not execute the incoming PR's maintenance implementation.
3. Configure CONTEXT_MAINTENANCE_TOKEN for a dedicated automation account with repository contents and pull-request
   write access, and CONTEXT_MAINTENANCE_ACTOR to its exact login. The template checks that identity. Use a token whose
   branch pushes and PR creation trigger the ordinary checks; the default GITHUB_TOKEN suppresses many such events.
   An installation-token flow requires an appropriately adapted identity check; do not silently substitute it for
   this account-token template.
4. Install retention-guard.yml first. Require its retention-guard job for PR and merge-group results, in addition to all
   existing Context, lint, typecheck and review requirements. The maintenance account must not bypass those requirements.
5. Install retention-proposal.yml and set CONTEXT_RETENTION_ENABLED=true only after validating the guard and permissions.
   It creates a deletion-only PR, retires older owned proposals, and requests normal automatic merging. It never pushes
   to main, force-pushes a proposal, approves human reviews or changes branch protection. If required reviews cannot be
   fulfilled by the repository's existing automation policy, the PR waits for them; do not claim fully unattended operation.

The producer runs serially on main changes or workflow_dispatch. With no threshold crossing it writes nothing. A
proposal branch is named from its fixed base commit and can be reused only after independent official verification.
No second live proposal is created intentionally. Closed proposal branches are not automatically deleted by this tool.

## Verification boundaries

For ordinary PRs, audit compares the fixed merge-base to the contributor's head with --no-renames. Only added canonical
confirmation paths are allowed. Comparing a stale topic tree directly to the latest main tree would produce false deletions.

Maintenance identity routing checks the dedicated account, same repository and reserved branch prefix, but these are
not sufficient authorization: verify reconstructs the full expected deletion-only tree through a fresh official compact
transaction at the current PR base. Extra edits, stale bases and different deletion sets fail.

The merge queue may combine the maintenance PR with ordinary source changes. verify-merge checks the actual queue tree:
in a private verification worktree, it compares complete Runtime confirmation facts before and after restoring only
the original deleted confirmation bytes from the queue base. It does not restore fake source files or modify business
Context. Current keys, match/content-known facts and readable-source state must be identical. All retired identity
directories must remain. A changed source basis that needs an evicted record therefore fails even when Git merges cleanly.

If main changes before proposal creation, discard and regenerate. If a queue candidate fails current-fact preservation,
regenerate the proposal after the interfering changes land; never refresh hashes or weaken the gate. Both PR checks and
merge-group checks are required: the merge-result check alone is not proof that an arbitrary PR was authorized to delete.

## Adapter commands

Pass the Runtime path explicitly; OpenCode places its Runtime under .opencode while public integrations remain at the
workspace root. The commands run in the business repository root. Arguments BASE and HEAD must be full fixed object IDs.

~~~sh
node integrations/retention.mjs preview --runtime "$CONTEXT_RUNTIME"
node integrations/retention.mjs prepare --runtime "$CONTEXT_RUNTIME" --base "$BASE"
node integrations/retention.mjs audit --base "$BASE" --head "$HEAD"
node integrations/retention.mjs verify --runtime "$CONTEXT_RUNTIME" --base "$BASE" --head "$HEAD"
node integrations/retention.mjs verify-merge --runtime "$CONTEXT_RUNTIME" --base "$BASE" --head "$HEAD"
~~~

prepare does not commit, push or open a PR. Its optional --force bypasses only the automatic threshold, never validation.
verify writes only its private verification worktree; uncertain Runtime runs are preserved for recovery. Routine reads
and ordinary developer updates never perform cleanup. The YAML producer owns Git publication separately from Runtime.

## Before enabling

Use a disposable repository to verify the real token, required checks, stale-proposal regeneration, queue batching and
automatic merge behavior. Offline tests cover Runtime and Git behavior but cannot prove the repository's external
permissions or GitHub configuration. A token failure or waiting review leaves a pending/failed maintenance operation;
it does not make ordinary Context reads invalid or authorize bypassing protection.
