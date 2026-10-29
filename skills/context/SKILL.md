---
description: Route, read, and maintain persistent repository knowledge with bounded context.
disable-model-invocation: false
name: context
---
# Plugydown Context Operating Skill

Use Plugydown Context to read only the durable repository knowledge needed by the current task and to keep that
knowledge honest when persistent engineering facts change. Formal knowledge lives only in `context/`. Temporary work
uses the business repository's direct `.scratch/{evidence,feedback,investigations,runs,locks}/` collections; there is no
Plugydown source-workspace namespace in an installed plugin.

Read `references/runtime.md` before the first Runtime call in a session. It is the sole reference for locating the
executable, collecting Git evidence, interpreting transport, and forming protocol requests.

## Start and progressive reading

Call `repository.inspect` before relying on formal knowledge.

- `absent`: mention that Init is available when relevant; do not create formal knowledge during an ordinary task.
- `legacy`: current-format maintenance requires an explicitly authorized Migrate; preview with `migration: true`.
- `invalid`: report diagnostics and correct the actual structural problem. Never fix it by blindly refreshing hashes.
- `ready`: select only the task-relevant frontier.
- `activeRun`: do not start another write; use `transaction.resume` before deciding the next action.

Use the smallest useful level and stop as soon as the task is answerable:

```text
L0 repository.inspect
→ L1 frontier.query depth 1 for candidate Domain metadata
→ read the selected Domain's domain.md
→ L2 frontier.query depth 2 for selected Document metadata and necessary requires closure
→ L3 frontier.query depth 3 for explicitly selected bodies
```

Do not load a complete Domain for reassurance. Follow `requires` only for prerequisites; `related` is optional context.
Runtime never returns source bodies, so read the minimum repository-relative source locations only when the task needs
current behavior. If source and knowledge disagree, current source is evidence for the task and the disagreement is an
Update signal. Continue a cursor only while the next page is useful.

## Runtime status

- `success`: the request completed.
- `no_change`: a transaction ended without changing formal bytes.
- `dry_run`: the candidate validated, formal Context was not modified, and Runtime already cleaned that run.
- `incomplete`: follow only the returned stable `nextAction`, cursor, active-run, evidence, review, or recovery need.
- `failed`: stop the affected workflow and report diagnostics; never present it as completion.

A `success` means the operation completed. `confirmation.check` separately reports `matched`, `unmatched` or
`unavailable` per Document. Matched means the complete current input tuple equals a recorded confirmation; it is not a
proof of natural-language truth. Unmatched is an Update signal, not structural damage. Source failures are separate.

After rebase/merge, use targeted checks when reading or maintaining Context. Ordinary Git preserves immutable records;
no driver, hook or Repair step is needed. Third-combination Markdown can be structurally valid and still need review.
If it is accurate, confirm it without rewriting it. Never treat conflict resolution itself as semantic confirmation.

A Transport failure is separate from these statuses. Preserve an existing active/recoverable run and stop; if no run
was established, remove only this workflow's now-unused evidence/Investigation leaf. For a read, report a short failure
rather than treating it as absent knowledge or no change.

## Role Brief and authority

Every Internal Role receives a short Markdown Brief with exactly these headings:

```markdown
## Goal
## Questions
## Scope
## Evidence
## Allowed writes
## Budget
## Expected result
```

Unlisted writes are forbidden. Investigator establishes facts and reviews candidates but cannot edit knowledge.
Reflector evaluates reusable feedback and may write only explicitly allowed temporary Feedback. Recorder is the only
semantic candidate author and never writes live Context or source. Runtime alone generates metadata and immutable confirmations.
Before invoking a role, read
`../../runtime/agents/index.md` relative to this Skill's directory. It identifies this installation's native Agents or
private role resources, model guidance, and tool boundaries. Follow its instructions with the same Brief.

The Main Assistant owns authorization scope and final semantic approval. Recorder cannot review itself; Reflector
cannot approve a formal Reflection. Init, Deep Update, Prune, Migrate, and Feedback promotion require Investigator candidate
review. Light Update may be reviewed directly by the Main Assistant unless uncertainty appears.

## Common write contract

Semantic writes require explicit Init, Update, Prune, or Migrate authorization. They use the same contract:

```text
resolve authorization and scope
→ collect Git evidence and deterministic signals
→ Update only: review impacted Documents; keep the IDs found still accurate
→ transaction.begin (Update passes those IDs as confirmedDocumentIds)
→ one Recorder edits the complete candidate (Migrate: Runtime converts historical evidence; no role edits)
→ transaction.validate
→ semantic review of the validated candidate
→ Main Assistant approval bound to candidateFingerprint and sourceEvidenceFingerprint
→ transaction.commit
→ clean workflow-owned Investigation and promoted/discarded Feedback
→ concise user report
```

Never edit live `context/` directly. Any candidate or source change after validation invalidates review and approval.
Never expand beyond authorized scope without the user's decision. Preserve conflicting copies for manual recovery. The
command documents own command-specific sequencing: Init is Deep, Update chooses Light/Deep from blockers and evidence,
and Prune and Migrate are Deep. Migration requires an explicit trust strategy and preserves baselines.
Only semantically reviewed new/changed or explicitly confirmed Documents receive new records. Ordinary commands retain
historical records unchanged; no persistent reviewRequired, current pointer or replacement pending flag is written.

## Central confirmation retention

`confirmation.retention` previews a bounded plan without writing. Only the separately authorized `compact` command may
evict records, through the repository's single mainline maintenance workflow. Ordinary Update, Prune and development
branches continue to append/retain records. Do not infer coordination from a branch name.

Compact changes no document content, source mapping, baseline or surviving record. Its `retention_review` is mechanical:
preserve current exact/content match facts and one real record per retired identity. A repository-authorized CI policy
may approve this result without a Recorder or model. This exception does not grant semantic confirmation or permission
to push, merge or configure CI during ordinary tasks. Follow the Compact command and shipped integration guide.
Existing format=1 data remains readable and writable by 0.8 clients.

## Ordinary task completion

Before finishing, independently consider:

1. **Feedback:** a stable correction, repeated consequential failure/omission, repeatedly effective strategy, renewed
   Reflection match, or explicit request may justify Reflector work. One-time preferences and harmless attempts do not.
2. **Persistent change:** suggest Update only for durable architecture, contract, procedure, convention, capability,
   relation, `code.paths`, or formal-fact changes. Pure implementation detail that leaves knowledge correct is not a
   signal.
3. **Growth:** `growth.measure` may justify suggesting Prune; it never triggers a write automatically.

Feedback promotion happens only inside a user-authorized Update. Delete the corresponding temporary Feedback only
after the Reflection candidate commits successfully; keep unpromoted or failed-promotion Feedback until later use or an
explicit user discard.

## Scratch naming and lifecycle

Use only these shapes:

```text
.scratch/evidence/<evidence-id>/
.scratch/feedback/<slug>-<short-identity-hash>.md
.scratch/investigations/<slug>-<short-identity-hash>.md
.scratch/runs/<runtime-uuid>/
.scratch/locks/context-write/
```

Names are lowercase; collections are plural, the singleton lock is kebab-case, run IDs are Runtime UUIDs, and human
Markdown uses an ASCII slug plus an 8-hex stable identity hash. Feedback identity comes from its four matching fields
and Investigation identity from the Role Brief goal/questions/scope, so appending Evidence never forces a rename; it is
not a hash of the whole file. Never put timestamps in names or contents. Do not delete `.scratch/`, a collection root,
or unknown siblings.

Runtime removes transaction evidence/run/lock after `success`, `no_change`, `dry_run`, trusted-backup restoration, or a
safe pre-write failure. Delete workflow-owned Investigation files at the same safe terminal point. Preserve only facts
needed by a continuable `incomplete` result or human recovery; `manualRecoveryRequired` and `no_trusted_copy` keep the
run/evidence/Investigation/lock and block new writes. There is no timeout, PID expiry, archive, or persistent report.

## Compact state

Maintain a short state block for the host's normal compact summary, with only:

```text
schema
goal
nextAction
selectedDocumentIds
contextFingerprint
sourceFingerprint
decisions
changedFiles
validation
openRisks
activeRunId?
cursor?
```

Do not include Document bodies, full role output, conversation text, environment data, or credentials, and do not write
the state block to disk. After compaction, call `repository.inspect`: continue from `nextAction` when fingerprints are
fresh, refresh only affected selections when stale, resume an active run before writing, or perform a normal L0 start
when no state block survived.

## Final report

For writes, report command, mode, scope, product status, major knowledge changes, unresolved items, candidate/context
fingerprints, validation/review/commit/recovery results, and relevant Feedback/Prune suggestions. Do not claim that the
Runtime made a semantic judgment, and do not hide `incomplete`, `failed`, or manual recovery.
