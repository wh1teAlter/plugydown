---
schema: plugydown.context.document/v1
id: runtime-protocol.determinism
description: What makes Runtime output byte-stable — canonical JSON, code-unit ordering, body normalization, projected fingerprints — plus the one deliberate exception and one known gap.
kind: architecture
domain: runtime-protocol
relations:
  requires:
    - runtime-protocol
code:
  paths:
    - packages/context/src/runtime/stable-json.ts
---

# Determinism

Byte-identical output for byte-identical input is a load-bearing property, not a nicety. Fingerprints, cursors, and the
approval binding in `write-plane` all assume that recomputing a value yields the same bytes. Break determinism and the
transaction plane starts reporting spurious staleness.

## Canonical JSON

`packages/context/src/runtime/stable-json.ts` is the only serializer:

- `stableValue` recursively sorts object keys and preserves array order. Array order is meaningful everywhere it appears,
  so it is never re-sorted here; ordering of *lists* is imposed by the producer instead.
- `stableJson` emits 2-space indentation and exactly one trailing LF. Used for stdout, for `meta.json`, and for the
  manifest.
- `compactJson` emits no whitespace. Used for hashes and cursors, so a formatting change can never alter a hash.
- `compareCodeUnits` compares by UTF-16 code unit (`left < right`), never by locale. Every sort in the Runtime routes
  through it. Locale-aware comparison would make output depend on the machine.

## Text normalization

`normalizeBody` in `document.ts` is applied to every Document body before hashing or returning it:

1. strip a leading BOM
2. CRLF and lone CR → LF
3. strip trailing spaces and tabs on every line
4. collapse trailing newlines to exactly one

So a Windows checkout and a Unix checkout of the same Document produce the same body fingerprint, and adding a trailing
blank line is not a change. This also means a caller cannot rely on the Runtime echoing a body back verbatim — it echoes
the normalized form.

## Fingerprints hash projections, not raw text

Three distinct fingerprint kinds, all SHA-256 over `compactJson`:

- **front matter** — hashes a canonical *projection* built by `frontMatterValue`, not the raw YAML. Reordering keys,
  changing quoting style, or reformatting the block does not change the hash. Omitted-vs-empty is normalized: empty
  `relations` and empty `code` are absent from the projection.
- **body** — `sha256(normalizedBody)`.
- **source** — `aggregateSourceFingerprint` over the sorted declaration list plus each matched file's path and content
  hash. Declaring the same file set through different but equivalent globs yields a different hash, because declarations
  are part of the input.

The tree fingerprint (`fingerprintTree` in `repository.ts`) hashes an ordered list of `{path, hash}` for every file in
the tree, with paths rewritten to a canonical `context/...` prefix. That last detail is what lets a candidate tree at
`.scratch/runs/<id>/candidate/context/` produce the same fingerprint it will have once renamed to `context/`. Without
the rewrite, committing would always look like a change.

## No ambient inputs

Responses contain no wall-clock time, no PID, no environment values, and no absolute paths. Paths in diagnostics are
repository-relative and are dropped entirely when they cannot be proven safe.

The test coverage here is narrower than the claim: `tests/runtime/protocol.test.ts` asserts only the absolute-path half,
and only for product failures. The wall-clock, PID, and environment halves hold by inspection of the source, not by a
mechanical check. `AGENTS.md` mandates all four for generated files and reports.

**One deliberate exception:** `randomUUID()` generates `runId` in `transaction.ts`. A run identity must be unique across
processes, which is irreconcilable with determinism, so it is accepted and isolated to that one value.

**One known gap:** `readTree` reads file mode (`info.mode & 0o777`) into `TreeFile`, but `fingerprintTree` hashes only
path and content. A `chmod` inside `context/` therefore does not change the context fingerprint. Whether that omission
is intentional is unverified — the field is read, which suggests it was considered, but nothing consumes it. Treat mode
as outside the integrity boundary until someone decides otherwise.

## Observed stability of the build

Two consecutive `pnpm build` runs were observed to produce 72 `dist/` files with matching checksums. That is a
point-in-time observation, not a standing property: nothing re-checks it, and it was observed under a builder version
other than the one pinned at the recorded baseline (see `delivery.verification-and-gaps`).

Byte-equivalence of build output is mandated by `AGENTS.md`, which is why `delivery` pins every dependency exactly.
