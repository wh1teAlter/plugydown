---
schema: plugydown.context.document/v1
id: repository-access
description: The filesystem trust boundary — path safety, symlink refusal, the controlled glob language, resource ceilings, and strict parsing of host-collected Git evidence.
kind: domain
domain: repository-access
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

`context` is a forbidden source-pattern segment, and this product's own source lives under `packages/context/`. There is
no legal pattern that names it. Anchoring at `packages` instead fails on pnpm's `node_modules` symlinks, which
`listAnchorFiles` refuses with `PATH_SYMLINK` rather than skipping. Both verified empirically. This repository therefore
cannot declare `code.paths` for itself; see `repository-access.path-and-glob-safety` for the mechanism and
`knowledge-model.meta-ledger` for what it costs.
