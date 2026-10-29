# Context Runtime Reference

This is the only shared invocation reference for the private Plugydown Context Runtime. Use it from the business
repository where the plugin is installed; never assume access to the Plugydown source repository.

## Locate and call

Resolve `../../runtime/context/main.mjs` from the directory containing the loaded Context `SKILL.md`. Confirm that the
resolved target is a regular non-symlink file inside the installed plugin. Start it with the business repository root as
`cwd`. Do not pass a repository root in JSON. Node.js 24 or later must be available as `node` on PATH.

Use the loaded Skill's source path on Claude Code, Codex, Cursor, and Pi. For Cursor local installs, the complete
Plugin is also at `~/.cursor/plugins/local/context/`. For Antigravity CLI, if the Skill source path is absent, run
`agy plugin list --json` and locate the installed `context` Plugin; its Runtime is `runtime/context/main.mjs`.
On OpenCode, resolve `.opencode/runtime/context/main.mjs` from the actual business repository root. Never assume
Hook configuration variables are expanded inside Skill text or arbitrary shell commands. Keep the whole installed
delivery unit, including Skills, Runtime, role resources, and licenses.

One process accepts exactly one JSON value on stdin and emits exactly one JSON response on stdout:

```sh
node "<resolved-runtime-path>" <<'JSON'
{"protocol":"plugydown.context.runtime","format":1,"capability":"repository.inspect","input":{}}
JSON
```

Require Node 24+, a regular non-symlink installed Runtime, and the business repository root as cwd. Do not pass a root
in JSON. Nonzero exit, invalid JSON or multiple responses are transport failures. A product response always contains
`protocol`, `format`, `capability`, `status`; optional `data`, `cursor`, `diagnostics` depend on status. Format is one
compatibility generation shared by wire, metadata and temporary state; compatible plugin upgrades do not change hashes.
Old `/v1` wire requests and unknown format fail. Do not retry them by deleting format or pretending migration occurred.

## Read capabilities

| Capability | Input / meaning |
|---|---|
| `repository.inspect` | optional `selectedDocumentIds` OR `migration: true`; missing, legacy, invalid, ready and active run discovery |
| `frontier.query` | `depth: 1|2|3`, optional `selectors`, `requiresClosure`; current Markdown is the content authority |
| `graph.validate` | `{}`; checks structure, record integrity and all declared sources; success is not semantic confirmation |
| `confirmation.check` | optional `scope` (repository default), `explain` (false default); derived match facts |
| `confirmation.retention` | `{}`; unpaged counts and retention plan fingerprint; complete sources required |
| `delta.compute` | `gitEvidencePath`, `scope`; scoped mismatches, changed paths, source impact and reading prerequisites |
| `growth.measure` | `{}`; current metrics and optional convergence baseline |
| `feedback.match` | `context`, `observedBehavior`, `outcomeOrCorrection`, `reuseBoundary` |

A scope is exactly one of `{"kind":"repository"}`, `{"kind":"domains","ids":["domain"]}`,
`{"kind":"documents","ids":["domain.guide"]}`, or `{"kind":"paths","paths":["src/file.ts"]}`.
IDs are unique and nonempty. Source patterns use the restricted grammar in `schemas/document.schema.json`.
Frontier selectors accept unique `domainIds`, `documentIds`, `kinds`, `codePaths`, or a relation selector with
`type: requires|related` and `documentId`. Depth 2/3 requires a selector.

Paged reads accept `budget` and `cursor`. Default: 100 items, 262144 bytes, 32000 estimated tokens. Hard maximum:
1000 items, 1048576 bytes, 128000 estimated tokens. Follow an unchanged query's cursor; a page is not the complete result.
Changed Context, selected sources, input or capability invalidates continuation. Never treat incomplete data as CI success.

## Confirmation facts and CI

Current data is in `context/.meta/manifest.json` and `.meta/confirmations/<document-id>/<key>.json`. Each immutable record
has exactly `documentId`, `frontMatterFingerprint`, `bodyFingerprint`, `sourceFingerprint`. Its key binds the whole tuple
and format; fields from different records cannot be combined into an approval. Current state is computed, never stored.

`confirmation.check` reports scope `{kind, requestFingerprint}`, structureState, recordStore state/coverage, sourceState,
snapshotFingerprint, summary and paged items. Summary covers all repository Documents: checked is the selected count,
matched/unmatched/unavailable partition checked; unchecked is outside scope. Counts describe the complete snapshot,
not the current page. Record integrity is currently checked repository-wide even when sources are selected locally.

Each item has documentId, path, sourceState and confirmationState:

- `matched`: currentKey equals a validated matchedKey. Inputs are unchanged from one recorded confirmation.
- `unmatched`: sources are readable, but the complete current tuple is absent. `documentContentKnown` says whether
  any record has the same front matter and body; source-only drift remains distinguishable from a new combination.
- `unavailable`: no currentKey can be computed from complete sources; diagnostics explain missing/unreadable/unsafe input.
- `unchecked`: reserved for inputs not sampled. Scope coverage must never be inferred from structure validation alone.

`explain: true` returns `NO_CONFIRMATION`, `SOURCE_BASIS_CHANGED`, `DOCUMENT_CONTENT_UNKNOWN` or `SOURCE_UNAVAILABLE`.
A missing source is not a sentinel hash. A successful check with unmatched/unavailable items is not a passing CI gate.
CI must parse format, status, full repository scope, counts and all pages. Its policy must be explicitly chosen:
`exact_basis` requires all matched; `content_guard` additionally allows source-only drift when documentContentKnown is
true and all sources/structures are valid. The latter must report drift. Runtime exposes facts and does not select or
weaken repository policy. Do not change an existing CI gate as part of ordinary Context maintenance.

## Git evidence

Runtime never invokes Git. The host collects fixed evidence into its unique `.scratch/evidence/<id>/` leaf:

```text
head.txt
mid-operation.json
status.bin
diff.bin?          # appears together with comparison.json
comparison.json?   # {"kind":"two-tree","base":"<full object ID>","head":"<full object ID>"}
```

Collect HEAD and `git status --porcelain=v2 --branch -z --untracked-files=all` as raw bytes. mid-operation is exactly
`{"active":false}` or `{"active":true,"kind":"rebase"}`; allowed kinds also include merge, cherry-pick, revert and bisect.
When historical comparison is useful, first fix base/head object IDs and collect `git diff --name-status -z <base> <head>`.
Resolve merge-base explicitly if desired. comparison.head must equal head.txt. Check HEAD/Git operation state again
before using collected evidence; discard and recollect your own leaf if it moved. Do not line-split or rewrite NUL data.
No comparison means `historyCoverage: not_provided`, not “no historical changes”. Confirmation checks do not require Git
history, branch names or a repository baseline; squash, shallow clones and inaccessible old revisions do not alter keys.

## Transactions

Semantic writes require explicit Init/Update/Prune/Migrate authorization. All use the existing candidate, lock, validation,
semantic review, two-fingerprint approval, whole-directory switch and recovery contract.

```json
{"protocol":"plugydown.context.runtime","format":1,"capability":"transaction","action":"begin","input":{
  "command":"update","mode":"deep","dryRun":false,"scope":{"kind":"documents","ids":["domain.guide"]},
  "gitEvidencePath":".scratch/evidence/context-update","evidencePaths":[],"confirmedDocumentIds":["domain.guide"]
}}
```

Commands: init/update/prune/migrate/compact. Init/Migrate/Compact require repository scope; Init/Prune/Migrate/Compact require Deep. evidencePaths
is required and may be empty: normal transactions still bind every candidate Document's actual declared sources.
Update may begin with missing sources or unmatched confirmations; the candidate must fix invalid declarations before
validation can succeed. Unsafe declarations, damaged records, conflicts and concurrent writers remain rejected.

confirmedDocumentIds is optional, Update-only, fixed at begin and within scope. List only Documents actually reviewed
against current sources and found accurate. Runtime also derives records for authorized new or content-changed surviving
Documents; path-only moves do not require new records. Deleted Documents leave historical confirmations intact. Scope
is permission, not evidence that every scoped Document was reviewed. The final candidate and every new record require
semantic review before Main Assistant approval. Recorder cannot modify `.meta`.

`validate` and `resume` take `{runId}`; resume optionally accepts `disposition: abandon` for fresh staged/validated runs.
`commit` takes `{runId, approval:{approved:true,candidateFingerprint,sourceEvidenceFingerprint,summary}}`.
Use the two exact returned fingerprints and a nonempty short review summary. Changes invalidate old approval.
Revalidation removes only obsolete records generated by this run. It never overwrites or deletes historical records.
Update preserves both baselines; Init/Prune create/update convergence only. Legacy repository baseline remains inert.

## Central retention (0.9+, format remains 1)

`confirmation.retention` takes `{}` and returns a complete unpaged summary with beforeCount, afterCount, removedCount,
activeIdentityCount, retiredIdentityCount, triggered and planFingerprint, plus contextFingerprint/snapshotFingerprint.
It accepts neither budget nor cursor. Invalid records or unavailable sources fail; no partial plan is returned.

Only the repository's authorized single maintenance coordinator may begin `compact`, Deep, repository scope, without
confirmedDocumentIds. It requires a clean checkout, readable sources and no Git operation. The begin freezes the plan,
source evidence and permissions. Any change requires abandoning and beginning again. Ordinary commands remain append-only.

Compact validation returns `ready_for_review` with `nextAction: retention_review` and a retention summary. This is
mechanical review, not semantic document approval; repository-authorized CI can approve its exact fingerprint pair.
No Recorder edits are permitted. The same validate/commit/resume and recovery actions apply. A dry run still ends at validate.

Active IDs retain up to ten records, protecting current matches and content evidence; retired IDs retain one actual
record to prevent directory-rename inference. An identity above twenty records triggers automatic batching, not a
schema error. Never perform this deletion independently in topic/release branches. The host must enforce one mainline
producer, ordinary PR append-only checks and actual merge-queue fact preservation; see the delivered integrations guide.

Stored files, keys and format remain readable/writable by 0.8. The older client cannot execute compact or recover a
compact run. Installation alone does not enable automatic maintenance, and an unmerged topic may retain extra records.

## Migration

Old root `context/meta.json` is read only for discovery/explicit migration; both old and new entries together are invalid.
Use inspect `migration: true` for a complete paged `import-trusted` preview. Migrate begin requires
`migrationStrategy: import-trusted|reconfirm` with no default. Import copies exact old tuples except reviewRequired=true;
reconfirm imports none. Neither rehashes current content into a historical confirmation. Existing Markdown paths, bytes,
permissions and baselines survive unchanged. The old entry is removed only in the candidate directory switch.

Migration binds the original Context tree and derived candidate; it does not claim current sources were reviewed, and
missing sources do not prevent historical conversion. Explicit evidencePaths, if supplied, still bind current files.
Follow the Migrate command for Investigator conversion review and final approval. A dry run terminates at validate.
Upgrade paired clients and CI before merging new layout. Resolve old active transactions with the compatible old Runtime;
never change lock/run version labels or create fake source files to bypass a migration check.

## Outcomes and ownership

| Outcome | Required next action |
|---|---|
| staged | Edit authorized candidate Markdown, then validate |
| migration_staged | Validate; no role edits |
| ready_for_review | Review candidate and sources, then approve the bound fingerprints |
| candidate_edit_required | Correct candidate/inputs and validate, or abandon safely |
| candidate_stale | Validate and obtain fresh approval |
| approval_mismatch | Review and approve the current pair |
| active_run | Resume that run; do not delete its lock |
| snapshot_stale | Old run is cleaned; recollect evidence and begin again |
| no_change | Formal bytes unchanged; run cleaned |
| validated with dry_run | Validated only; cleaned run cannot be committed |
| committed / candidate_completed | Verified candidate is live; cleanup completed |
| backup_restored | Original tree restored; operation failed, migration remains legacy |
| manual_recovery / no_trusted_copy | Keep all copies and lock for human recovery |

success/no_change/dry_run, safe pre-write failure and trusted-backup restoration clean only workflow-owned evidence/run/
lock leaves. Preserve continuable and manual-recovery scenes. Host cleans its own Investigation at a safe terminal point.
Transport failure preserves any established transaction; report failure instead of treating it as absent Context.

Temporary paths are exactly `.scratch/evidence/<id>/`, `.scratch/runs/<runtime-uuid>/`, `.scratch/locks/context-write/`,
`.scratch/investigations/<slug>-<8-hex-identity>.md`, `.scratch/feedback/<slug>-<8-hex-identity>.md`. Use lowercase names,
no timestamps, and never delete collections or unknown siblings. No lock expiry by PID/time. Promoted Feedback is removed
only after successful commit; otherwise retain it. Formal confirmation files are collaboration evidence, not cache.
