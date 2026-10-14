# Context Runtime Reference

This is the only shared invocation reference for the private Plugydown Context Runtime. Use it from the business
repository where the plugin is installed; never assume access to the Plugydown source repository.

## Locate and call

Resolve `../../runtime/context/main.mjs` from the directory containing the loaded Context `SKILL.md`. Confirm that the
resolved target is a regular non-symlink file inside the installed plugin. Start it with the business repository root as
`cwd`. Do not pass a repository root in JSON.

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
| `repository.inspect` | optional `selectedDocumentIds` |
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
git status --porcelain=v2 --branch -z > "$evidence_dir/status.bin"
git diff --name-status -z "$baseline"...HEAD > "$evidence_dir/diff.bin"
```

Write `mid-operation.json` as exactly `{"active":false}` or, for example,
`{"active":true,"kind":"merge"}` after checking Git state. An active `kind` must be one of `merge`, `rebase`,
`cherry-pick`, `revert`, or `bisect`. Create `diff.bin`
only when the ledger baseline differs from HEAD. Do not decode, line-split, trim, or rewrite the two NUL-delimited
files. `delta.compute` and a following transaction may share the same evidence leaf.

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
accurate against their changed sources; their ledgers are then settled without an edit. Every ID must exist and sit
inside the authorized scope, or `begin` fails with `TRANSACTION_SCOPE_INVALID` before taking the lock. It is fixed at
`begin` like every other input, and it permits rather than forbids: a listed Document may still be edited. Without it,
an accurate Document whose sources moved cannot be settled at all — no edit means no ledger refresh.

Call `validate` or `resume` with only `runId`. Call `commit` with `runId` and an approval containing exactly
`approved: true`, the returned `candidateFingerprint`, the returned `sourceEvidenceFingerprint`, and a short nonempty
`summary`. Any candidate or source change requires validate and semantic review again.

`dry_run` ends at validate: Runtime returns fingerprints, removes candidate/run/evidence and the write lock, and never
turns that run into a real commit. `no_change` is also terminal. Normal commit returns the final Context fingerprint and
approved fingerprint bindings; it does not return or retain a report file.

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

A `success` may carry warnings. `DOCUMENT_REVIEW_PENDING` from `graph.validate` names a Document whose cited sources
changed since it was last reviewed: an Update signal, never damage. Errors such as `META_DOCUMENT_*` do mean damage.

Transaction outcomes are distinct results, never one generic retry:

| Outcome | Meaning | Do this |
|---|---|---|
| `candidate_edit_required` | The candidate is repairable in place | Fix the candidate, then validate again |
| `candidate_stale` | Candidate or source changed after validation | Validate again, then obtain a fresh review |
| `approval_mismatch` | The approval is not bound to current bytes | Review again and approve the current fingerprints |
| `active_run` | Another run owns the write lock | Resume that run; never delete its lock |
| `snapshot_stale` | Formal, Git or declared evidence moved; the run is cleaned | Collect evidence and begin a new transaction |
| `manual_recovery` / `no_trusted_copy` | Copies conflict or none is trustworthy | Stop, keep the scene, ask for human recovery |

For a transport failure, preserve an existing active/recoverable transaction exactly as found and stop. When no run
was established, delete only this workflow's no-longer-used evidence or Investigation leaf. Never present transport
failure as absent knowledge, no change, or success.
