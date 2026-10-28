---
schema: plugydown.context.document/v1
id: package-context.git-evidence
description: The host-collects/Runtime-parses split for Git facts, the exact accepted evidence directory format, and the strict parsers for porcelain v2 and name-status bytes.
kind: architecture
domain: package-context
relations:
  requires:
    - package-context
  supersedes:
    - repository-access.git-evidence
code:
  paths:
    - packages/context/src/runtime/repository.ts
    - packages/context/src/skills/context/references/runtime.md
---

# Git evidence

## The split

The Runtime never executes Git. It never spawns any process at all. The host shell collects raw Git bytes into one
directory; the Runtime reads and validates them. This is what keeps the Runtime free of subprocess handling, shell
quoting, locale-dependent Git output parsing, and any dependence on a Git binary being present or on a particular Git
version's human-readable output.

The cost is that Git facts are only as fresh as the collection. `package-context.transaction-lifecycle` compensates by fingerprinting the evidence
directory at `transaction.begin` and re-proving those collected bytes before destructive steps; changes to that
evidence become `GIT_EVIDENCE_CONFLICT`. Runtime does not independently query current Git HEAD or operation state, so
timely and honest collection remains the host's responsibility.

`readGitEvidence` does require `.git` to exist in the root as either a directory or a file — the file form covers
worktrees and submodules. Absence is `GIT_REPOSITORY_REQUIRED`.

## The accepted directory

Exactly one leaf directly under `.scratch/evidence/`, named in lowercase kebab-case:

```
.scratch/evidence/<evidence-id>/
├── head.txt              required
├── mid-operation.json    required
├── status.bin            required
└── diff.bin              optional
```

`assertGitEvidencePath` requires exactly three path segments with the first two being `.scratch/evidence`. No nesting, no
sharing, no evidence outside that collection. Any file in the directory other than these four, or any non-regular entry,
is `GIT_EVIDENCE_UNKNOWN_FILE` — extra files are refused rather than ignored, so a partially rewritten evidence leaf
cannot be silently consumed.

The host commands that produce these bytes are documented in
`packages/context/src/skills/context/references/runtime.md`. The two `.bin` files are NUL-delimited and must not be
decoded, line-split, trimmed, or rewritten by the host.

## Strict parsing

**`head.txt`** must match `^[0-9a-f]{40}(?:[0-9a-f]{24})?\n$` — a full lowercase SHA-1 or SHA-256 revision plus exactly
one LF. An abbreviated revision, uppercase hex, a missing newline, or extra content is `GIT_HEAD_INVALID`. Abbreviations
are refused because a prefix is not a stable identity.

**`mid-operation.json`** must be exactly `{"active":false}` or `{"active":true,"kind":K}` where K is one of `merge`,
`rebase`, `cherry-pick`, `revert`, `bisect`. The key set is compared exactly, so `{"active":false,"kind":"merge"}` is
`GIT_MID_OPERATION_INVALID`. A leading BOM is stripped. This flag matters: a Git mid-operation is an unconditional
Light-eligibility blocker in `package-context.capabilities`, and it prevents `deriveMeta` from advancing the repository baseline.

**`status.bin`** is porcelain v2, NUL-delimited, and must end with a NUL. Parsing recognizes only:

- headers `# branch.oid`, `# branch.head`, `# branch.upstream`, `# branch.ab` — each at most once, each shape-checked.
  Any other `# ` header is `GIT_STATUS_INVALID`.
- `? path` untracked, `! path` ignored (skipped). A `? dir/` record fails with `GIT_STATUS_UNTRACKED_COLLAPSED`: Git's
  default untracked mode collapses a new directory to its name, hiding which files are new, and `delta.compute` must map
  files. The message names the fix, `--untracked-files=all`, and the shipped recipe already passes it:
  `git status --porcelain=v2 --branch -z --untracked-files=all`.
- `1 XY …` ordinary, where the change kind comes from X unless X is `.`, in which case Y
- `2 XY …` rename or copy, which consumes the *following* record as the previous path; a missing or empty one is an error
- `u …` unmerged, recorded as modified and setting `hasUnmergedPaths`; Repair rejects this flag even when the supplied mid-operation flag is false

Exactly one `branch.oid` and one `branch.head` are required. Any unrecognized record is a hard failure — the parser has
no tolerant fallback, so a Git version emitting something new fails loudly instead of silently under-reporting changes.

**`diff.bin`** is `--name-status -z`. Statuses match `^[ACDMRTUXB]\d*$`; `R`/`C` consume two paths, everything else one.
Incomplete records are `GIT_DIFF_INVALID`. Empty is legal.

Every path from either file passes back through `assertSafeRelativePath`, so Git cannot introduce a path the rest of the
Runtime would refuse.

## Cross-checks and output

`status.bin`'s `branch.oid` must equal `head.txt` (`GIT_STATUS_HEAD_MISMATCH`). This catches the common collection bug of
running the two commands around an intervening checkout.

Changes from both files are merged, sorted by `path\0kind\0previousPath`, and deduplicated by canonical JSON equality.
The evidence fingerprint is SHA-256 over each present file's name and content hash, sorted by name — so it covers
`diff.bin`'s presence or absence as well as its content.

`hasDiff` is exposed separately, but it decides only `changedPathsComplete` in `delta.compute`: when the recorded
repository baseline differs from HEAD and no diff was supplied, the changes between them are unlisted and the result
covers only the working tree. The host supplies `diff.bin` only when the baseline differs from HEAD and
`git cat-file -e "$baseline^{commit}"` succeeds, since a baseline commit orphaned by a squash merge may never have been
fetched into this clone; otherwise it omits the file. Nothing else reads `hasDiff`: the review queue comes from
fingerprints and `package-context.transaction-lifecycle` does not consult it.
