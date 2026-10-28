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

One process accepts exactly one JSON value on stdin and emits exactly one JSON value on stdout. For example:

```sh
node "<resolved-runtime-path>" <<'JSON'
{"protocol":"plugydown.context.runtime/v1","capability":"repository.inspect","input":{}}
JSON
```

Check both the exit status and stdout. A valid Runtime response has only `protocol`, `capability`, `status`, and optional
`data`, `cursor`, or `diagnostics`. A nonzero exit, empty/multiple output, or invalid JSON is a transport failure.

## Requests

Every request requires:

```json
{
  "protocol": "plugydown.context.runtime/v1",
  "capability": "<capability>",
  "input": {}
}
```

The only capabilities and owned inputs are:

| Capability | Input |
|---|---|
| `repository.inspect` | optional `selectedDocumentIds`; optional `repair: true` for a paged repair plan |
| `frontier.query` | `depth: 1|2|3`; optional `selectors`, `requiresClosure` |
| `graph.validate` | empty object |
| `delta.compute` | `gitEvidencePath`, `scope`, four `taskEvidence` booleans |
| `growth.measure` | empty object |
| `feedback.match` | `context`, `observedBehavior`, `outcomeOrCorrection`, `reuseBoundary` |
| `transaction` | required `action: begin|validate|commit|resume` plus the action-owned input |

Selectors may contain unique `domainIds`, `documentIds`, `kinds`, `codePaths`, or one relation selector with
`type: requires|related` and `documentId`. Depth 2 or 3 requires a selector. A scope is exactly one of:

```json
{"kind":"repository"}
{"kind":"domains","ids":["domain-id"]}
{"kind":"documents","ids":["domain.document-id"]}
{"kind":"paths","paths":["src/file.ts"]}
```

Paged capabilities accept optional `budget` and `cursor`. The default budget is 100 items, 262144 bytes, and 32000
estimated tokens; the maximum is 1000 items, 1048576 bytes, and 128000 estimated tokens. Continue only an unchanged
query with its returned cursor. Never treat a cursor page as a complete result.

## Git evidence

The host shell, not Runtime, collects Git bytes. Create one uniquely owned leaf named with lowercase kebab-case or a
UUID:

```text
.scratch/evidence/<evidence-id>/
├── head.txt
├── mid-operation.json
├── status.bin
└── diff.bin?
```

Collect from the business repository root:

```sh
git rev-parse HEAD > "$evidence_dir/head.txt"
git status --porcelain=v2 --branch -z --untracked-files=all > "$evidence_dir/status.bin"
git diff --name-status -z "$baseline"...HEAD > "$evidence_dir/diff.bin"
```

Write `mid-operation.json` as exactly `{"active":false}` or, for example,
`{"active":true,"kind":"merge"}` after checking Git state. An active `kind` must be one of `merge`, `rebase`,
`cherry-pick`, `revert`, or `bisect`. Create `diff.bin`
only when the ledger baseline differs from HEAD and `git cat-file -e "$baseline^{commit}"` succeeds. After a squash
merge, other clones may never have fetched the baseline commit; when the check fails, omit `diff.bin`. `delta.compute`
then reports `changedPathsComplete: false`: changed and unreferenced paths cover only the working tree, `directImpact`
stays complete, and the missing history blocks neither Light nor the baseline.
Do not decode, line-split, trim, or rewrite the two NUL-delimited files. `delta.compute` and a following transaction
may share the same evidence leaf.

## Transaction inputs

`begin` owns the complete candidate and lock:

```json
{
  "protocol": "plugydown.context.runtime/v1",
  "capability": "transaction",
  "action": "begin",
  "input": {
    "command": "update",
    "mode": "deep",
    "dryRun": false,
    "scope": {"kind":"repository"},
    "gitEvidencePath": ".scratch/evidence/<evidence-id>",
    "evidencePaths": ["src/**/*.ts"],
    "reaffirmedDocumentIds": ["domain.document-id"]
  }
}
```

`reaffirmedDocumentIds` is optional and Update-only. List the Documents that review before `begin` confirmed are still
accurate against their current sources, including Documents pending after Repair; their ledgers are then settled
without an edit. Every ID must exist and sit
inside the authorized scope, or `begin` fails with `TRANSACTION_SCOPE_INVALID` before taking the lock. It is fixed at
`begin` like every other input, and it permits rather than forbids: a listed Document may still be edited. Without it,
an accurate Document whose sources moved cannot be settled at all — no edit means no ledger refresh.

`command` is `init`, `update`, `prune`, or `repair`. `evidencePaths` may be empty only for Repair: Runtime still
collects and binds all Documents' declared source evidence. Repair requires `mode: deep`, Document scope, and no
`reaffirmedDocumentIds`. Prune refuses outstanding content review obligations; settle them through Update first.

Call `validate` or `resume` with only `runId`. Call `commit` with `runId` and an approval containing exactly
`approved: true`, the returned `candidateFingerprint`, the returned `sourceEvidenceFingerprint`, and a short nonempty
`summary`. Any candidate or source change requires validate and semantic review again.

`dry_run` ends at validate: Runtime returns fingerprints, removes candidate/run/evidence and the write lock, and never
turns that run into a real commit. `no_change` is also terminal. Normal commit returns the final Context fingerprint and
approved fingerprint bindings; it does not return or retain a report file.

## Content fingerprint repair after merge/rebase

Repair is available in Context 0.7.0 and later. All collaborators must upgrade before writing Meta v2. Runtime reads
both Meta v1 and v2; the single `schemas/meta.schema.json` validates each according to its `$schema` discriminator.
Only v2 permits `reviewRequired`. Repair migrates only when it actually changes fingerprints. New Init writes v2;
normal Update preserves the existing schema. Runtime protocol and fingerprint algorithms remain v1.

Start with a read-only preview, using the authorized Document IDs:

```json
{
  "protocol": "plugydown.context.runtime/v1",
  "capability": "repository.inspect",
  "input": {"repair": true, "selectedDocumentIds": ["domain.document-id"]}
}
```

`data.repair` contains `eligible`, Document counts, `schemaMigrationRequired`, `planFingerprint`, and paged `items`.
Each item names a Document, whether it is selected, and exact field changes (`field`, `before`, `after`). A `null`
`before` means the review obligation was absent. The stream includes unselected mismatches so the host can discover
the complete required scope. Continue every page needed to establish scope; a cursor is invalidated by Context changes.
Eligibility covers formal structure only: source availability, Git state and write locks are checked by the transaction.

Only valid Meta and Documents with content fingerprint mismatches qualify. Missing records, duplicate IDs, invalid
relations, unsafe paths and conflict markers are not repaired. Finish Git operations first. If other mismatched
Documents remain outside scope, `REPAIR_SCOPE_INCOMPLETE` blocks begin; do not silently expand authorization.

After collecting fresh Git evidence, call `transaction.begin`:

```json
{
  "protocol": "plugydown.context.runtime/v1",
  "capability": "transaction",
  "action": "begin",
  "input": {
    "command": "repair", "mode": "deep", "dryRun": true,
    "scope": {"kind": "documents", "ids": ["domain.document-id"]},
    "gitEvidencePath": ".scratch/evidence/context-repair",
    "evidencePaths": []
  }
}
```

`repair_staged` returns `nextAction: validate`: no role edits the candidate. Runtime preserves every Markdown byte,
path and permission, derives only mismatched body/front-matter fingerprints, and sets `reviewRequired: true` on the
affected records. The old source fingerprints, repository baseline, convergence baseline and other records remain.
All declared sources must be safely readable; inability to gather evidence blocks validation rather than fabricating
source review. For candidate/source problems, restore the untouched candidate or abandon the staged/validated run
with `transaction.resume` and `disposition: abandon`, resolve the cause, and begin again.

Validation returns the candidate/source fingerprints and a bounded `repair` summary with `documentCount` and
`planFingerprint`; correlate it with the paged preview. A dry run then cleans its artifacts without changing formal
files. For a real write collect fresh evidence, begin with `dryRun: false`, validate, and have an Investigator review
the candidate for faithful preservation, exact scope and honest pending-review state. The Main Assistant approves the
returned fingerprints and commits. This approval authorizes consistency restoration, not source reaffirmation.

After commit, inspect the repaired IDs and run `graph.validate`: content mismatch errors should disappear, while
`reviewRequired` / `DOCUMENT_REVIEW_PENDING` remain. Run a separately authorized Update to review each affected
Document against its current sources. Even when source bytes did not change or `code.paths` is absent, the review
obligation remains until Update edits or explicitly reaffirms the Document under candidate review and approval.
It also prevents repository baseline advancement. Repairing an already consistent ledger is `no_change` and does
not clear review obligations.

Candidate or source changes invalidate approval. Formal Context changes require a fresh transaction. If failure
recovery reports `backup_restored` with `REPAIR_ROLLED_BACK`, the original mismatched snapshot is back: the repair
failed and the mismatch still needs attention. Conflicting or missing trusted copies retain the existing manual
recovery rules. Never manually edit live Meta or replace source fingerprints with sentinel values.

## Scratch ownership and cleanup

Context uses the business repository paths directly:

```text
.scratch/evidence/<evidence-id>/
.scratch/feedback/<slug>-<short-identity-hash>.md
.scratch/investigations/<slug>-<short-identity-hash>.md
.scratch/runs/<runtime-uuid>/
.scratch/locks/context-write/
```

Use lowercase plural collection names, kebab-case singleton names, UUID run IDs, and Markdown names built from an ASCII
slug plus an 8-hex stable identity hash. Feedback identity derives from its four matching fields and Investigation
identity from the Role Brief goal/questions/scope, not from the whole file, so appended Evidence never forces a rename.
Never use timestamps. Never delete `.scratch/`, a collection root, or unknown siblings.

On `success`, `no_change`, `dry_run`, trusted-backup restoration, or a safe pre-write failure, remove every leaf owned
by the completed workflow. Runtime removes transaction evidence/run/lock; the Main Assistant removes workflow-owned
Investigation files. Delete Feedback after its Reflection is successfully committed or when the user explicitly
discards it; keep unpromoted Feedback. Preserve run/evidence/Investigation/lock only while an `incomplete` result can
continue or when `manualRecoveryRequired`/`no_trusted_copy` needs human recovery. Never expire a lock by time or PID.

## Status handling

- `success`: use the complete result.
- `no_change`: report that formal bytes were unchanged; the run is already cleaned. If review found Documents still
  accurate but they were not passed as `reaffirmedDocumentIds`, they remain pending; begin again listing them.
- `dry_run`: report validation without a formal write; the run is already cleaned and cannot resume.
- `incomplete`: follow only the returned cursor, `nextAction`, active run, evidence, authorization, review, or recovery need.
- `failed`: stop the affected workflow and report diagnostics. If `manualRecoveryRequired` is true, preserve the named
  recovery leaves and lock; otherwise clean any host-owned leaf that Runtime could not own.

A `success` may carry warnings. `DOCUMENT_REVIEW_PENDING` from `graph.validate` names a Document with changed or
unavailable sources, or an explicit content review obligation after Repair: an Update signal, never damage.
Errors such as `META_DOCUMENT_*` do mean damage.

Transaction outcomes are distinct results, never one generic retry:

| Outcome | Meaning | Do this |
|---|---|---|
| `repair_staged` | Runtime owns the ledger candidate | Validate without editing the candidate |
| `candidate_edit_required` | The candidate is repairable in place | Fix the candidate, then validate again |
| `candidate_stale` | Candidate or source changed after validation | Validate again, then obtain a fresh review |
| `approval_mismatch` | The approval is not bound to current bytes | Review again and approve the current fingerprints |
| `active_run` | Another run owns the write lock | Resume that run; never delete its lock |
| `snapshot_stale` | Formal, Git or declared evidence moved; the run is cleaned | Collect evidence and begin a new transaction |
| `manual_recovery` / `no_trusted_copy` | Copies conflict or none is trustworthy | Stop, keep the scene, ask for human recovery |

For a transport failure, preserve an existing active/recoverable transaction exactly as found and stop. When no run
was established, delete only this workflow's no-longer-used evidence or Investigation leaf. Never present transport
failure as absent knowledge, no change, or success.
