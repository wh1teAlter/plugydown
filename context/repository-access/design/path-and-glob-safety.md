---
schema: plugydown.context.document/v1
id: repository-access.path-and-glob-safety
description: The lexical path rules, symlink and non-regular-file refusal, the deliberately small glob language with its forbidden segments, and the resource ceilings on tree and source expansion.
kind: architecture
domain: repository-access
relations:
  requires:
    - repository-access
code:
  paths:
    - packages/context/src/runtime/repository.ts
    - packages/context/public/schemas/document.schema.json
    - packages/context/public/schemas/runtime.schema.json
---

# Path and glob safety

## Lexical rules

`assertSafeRelativePath` in `packages/context/src/runtime/repository.ts` rejects, each with its own code:

| Condition | Code |
|---|---|
| empty | `PATH_EMPTY` |
| longer than 1024 characters | `PATH_LENGTH_EXCEEDED` |
| contains a backslash | `PATH_SEPARATOR_INVALID` |
| POSIX-absolute, Win32-absolute, or drive-lettered | `PATH_ABSOLUTE` |
| any code point ≤ 0x1F or 0x7F | `PATH_CONTROL_CHARACTER` |
| contains `$` or `%VAR%` | `PATH_VARIABLE` |
| any segment empty, `.`, `..`, or containing `~` | `PATH_SEGMENT_INVALID` |

Note that `~` is rejected anywhere inside a segment, not just as a leading character, and drive letters are rejected even
on POSIX. The rules are deliberately stricter than any single platform requires so that the same path text is safe
everywhere.

## Physical resolution

`resolveRepositoryPath` real-paths the root, resolves the candidate against it, and confirms containment
(`PATH_ESCAPE`). Then it walks segment by segment:

- a symlink at *any* segment is `PATH_SYMLINK`, even if it points back inside the root
- a non-directory in a parent position is `PATH_PARENT_NOT_DIRECTORY`
- with `allowMissingTail`, a missing final segment returns the intended absolute path instead of failing, which is how
  the write plane targets paths it is about to create

Refusing inward-pointing symlinks is stricter than containment requires. The reason is that following any link makes the
mapping from declaration to file set depend on link state, which would make source fingerprints unstable.

## The glob language is intentionally tiny

`assertSourcePattern` layers four rules on top of the lexical ones:

1. If the pattern contains `*`, it must have at least two segments and the **first segment must be concrete** —
   `GLOB_ANCHOR_INVALID`. Every glob is anchored at a real directory, so expansion never walks the repository root.
2. `?`, `[`, `]`, `{`, `}`, `!` are all unsupported — `GLOB_SYNTAX_INVALID`. No character classes, no brace expansion,
   no negation.
3. At most one `**`, and `**` must occupy a whole segment. `src/**/**/*.ts` and `src/a**b/*.ts` are both
   `GLOB_RECURSION_INVALID`.
4. The first segment must not be `.git`, `.scratch`, or `context`, and no segment may be `node_modules` —
   `SOURCE_ROOT_FORBIDDEN`. Nested reserved names such as `packages/context/**` and `tools/.scratch/build.ts` are
   legal; root patterns such as `.git/config`, `.scratch/input.md`, `context/service/domain.md`, and
   `src/node_modules/pkg.ts` are not.

There is no separate exact-path validator. `code.paths`, `scope.paths`, and `frontier.query` `selectors.codePaths` all
use `assertSourcePattern`; globs are allowed. `assertSourcePath`, `PATH_GLOB_INVALID`, and schema `$defs.sourcePath`
do not exist. Both published schemas encode the same first-segment-versus-`node_modules` rule in `$defs.sourcePattern`.

Matching is implemented by `controlledGlobMatches` — a recursive segment matcher where `**` consumes zero or more
segments and `*` within a segment becomes `.*` with everything else regex-escaped. `declarationMatches(declaration,
candidate)` is one-way: exact string equality, or glob-match when the declaration contains `*`. A declaration without
`*` never enters the matcher.

### Glob expansion walks only what a pattern can match

Declaration and expansion are different steps. `expandGlob` starts at the pattern's first segment, which is always a
literal directory, and recurses with `couldContainMatch`: it lists a directory only while the pattern can still match
somewhere below it. Unrelated siblings — another package's pnpm-symlinked `node_modules`, a build output tree — are never
opened, so they can neither fail the glob nor count against the file ceiling. `node_modules` is skipped at any depth,
not refused: a pattern may not name it, so `**` must not reach into it either.

A symlink or special entry is handled differently. It is refused (`PATH_SYMLINK`, `PATH_SPECIAL_FILE`) only where it
would itself be selected or must be descended through to reach a match; one the pattern can never reach is left unopened.
Either way it is never followed. Exact non-glob paths expand by lstat of that file only.

The first-segment rule stops knowledge from declaring the live `context/` tree as its own source, which would make
fingerprints self-referential. It does not restrict `packages/`: a glob such as `packages/foo/src/**` expands in this
working tree.

## Resource ceilings

| Limit | Value | Applies to |
|---|---|---|
| `MAX_MARKDOWN_BYTES` | 1 MiB | one Document |
| `MAX_FRONT_MATTER_BYTES` | 64 KiB | one front-matter block |
| `MAX_JSON_TEXT_BYTES` | 4 MiB | Meta, manifest, lock owner, tree files |
| `MAX_GIT_EVIDENCE_BYTES` | 16 MiB | one Git evidence file |
| `MAX_SOURCE_FILES` | 10000 | selected files in one expansion, counted across all owners; a file selected twice counts once |
| `MAX_SOURCE_BYTES` | 512 MiB | one expansion, accumulated |

The file-count and byte ceilings are shared across an entire expansion, not per pattern, so a Document cannot evade them
by splitting one glob into ten. Both are hard: `SOURCE_FILE_LIMIT_EXCEEDED` and `SOURCE_BYTE_LIMIT_EXCEEDED` are
explicitly excluded from the per-pattern issue path in `sourceDiagnostic` and rethrown, failing the whole request. Every
other expansion problem is attributed to its owning Document as a recoverable issue.

`readTree` enforces the same two ceilings under different names (`FORMAL_FILE_LIMIT_EXCEEDED`,
`FORMAL_BYTE_LIMIT_EXCEEDED`) and refuses any non-ordinary entry.

## Expansion is one bounded operation

`expandSourcePatternSets` takes every owner's patterns at once and:

- sorts owners by id, so ordering is deterministic
- caches each walk by pattern (`globCache`), so two Documents declaring the same pattern walk once; different patterns
  that overlap walk their shared directories separately
- hashes each unique file exactly once via a streaming SHA-256, so overlapping declarations do not multiply cost
- attributes a failure to *every* owner that selected the failing file

A zero-match glob is an error (`SOURCE_GLOB_ZERO_MATCH`), and a missing exact declaration is
`SOURCE_EXACT_MISSING`. Silence would let knowledge claim coverage it does not have.
