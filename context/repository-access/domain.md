---
schema: plugydown.context.document/v1
id: repository-access
description: The filesystem trust boundary — path safety, symlink refusal, the controlled glob language, resource ceilings, and strict parsing of host-collected Git evidence.
kind: domain
domain: repository-access
code:
  paths:
    - packages/context/src/runtime/repository.ts
---

# Repository access

Every filesystem read in the Runtime goes through `packages/context/src/runtime/repository.ts`. No other module calls
`node:fs` for reading. That single funnel is what makes the safety properties checkable: there is one place where a path
becomes an absolute path, and one place where a glob becomes a file list.

## Why this Domain exists

The Runtime runs with the host's full filesystem privileges inside a repository it did not write. A Document's
`code.paths`, a scope's `paths`, and an evidence path are all attacker-adjacent inputs in the sense that they arrive as
data and get turned into filesystem operations. This Domain is the layer that refuses to let data become traversal.

## What lives here

- `repository-access.path-and-glob-safety` — lexical path rules, symlink refusal, the controlled glob language,
  forbidden segments, and the resource ceilings.
- `repository-access.git-evidence` — the host-collects/Runtime-parses split and the exact accepted evidence format.

## Invariants

- **The Runtime never executes Git.** It never spawns any process. Git facts arrive as bytes the host collected.
- **Symlinks are refused, never followed** — including a symlink that would have resolved back inside the root.
  `resolveRepositoryPath` walks every segment and fails on the first `isSymbolicLink()`.
- Only regular files are read. Directories, FIFOs, sockets, and devices are refused by kind.
- Path validation is lexical *and* physical. Lexical rules reject the string; physical checks reject what it resolves to.
  Neither alone is sufficient.
- Errors are classified. Only a known errno set becomes `REPOSITORY_IO_FAILED`; anything else propagates as a real bug
  rather than being flattened into a domain failure.
- Paths appear in diagnostics only when provably safe, and most faults do not disclose the path at all — `pathFault`
  takes an explicit `disclose` flag that defaults to false.

## Self-hosting limitation

`.git`, `.scratch`, and `context` are forbidden only as the **first** path segment; `node_modules` is forbidden at any
level. Nested reserved names such as `packages/context/src/runtime.ts` and `tools/.scratch/build.ts` are legal. Root
patterns such as `.git/config`, `.scratch/input.md`, `context/service/domain.md`, and `src/node_modules/pkg.ts` still
fail with `SOURCE_ROOT_FORBIDDEN`.

The remaining limitation is glob expansion, not declaration. `expandSourcePatternSets` uses the first path segment as
the walk anchor, and `listAnchorFiles` refuses symlinks with `PATH_SYMLINK` rather than skipping. A glob whose first
segment is `packages` (including `packages/context/**`) therefore cannot expand in this working tree because
`packages/context/node_modules` contains pnpm symlinks. Exact non-glob file paths under `packages/context/` expand by
lstat of that file only. See `repository-access.path-and-glob-safety`.
