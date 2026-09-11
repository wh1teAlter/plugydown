---
schema: plugydown.context.document/v1
id: delivery.verification-and-gaps
description: The verification gate and its one dead script, the exact-version dependency policy and its stated rationale, the unvalidated drifted runtime schema, and what the repository does not produce.
kind: decision
domain: delivery
relations:
  requires:
    - delivery
  related:
    - authority-workflow.enforcement-boundary
---

# Verification and gaps

## The gate

```
pnpm check = lint && typecheck && test && build
```

Root scripts fan out with `pnpm -r --if-present run <name>`. The package supplies `typecheck` (`tsc --noEmit`), `test`
(`vitest run`), `build`, `validate`, `inspect`, and `dev`; `lint` is root-level `eslint .`.

Observed at the recorded HEAD: lint 0 problems, typecheck 0 errors, 158 tests across 6 files passing, build reporting
`success (claude-code, codex)`, `validate` and `inspect` succeeding.

Note that `check` does **not** include `validate` or `inspect`. Those are separate invocations.

### `verify` is a no-op

The root `verify` script is `pnpm -r --if-present run verify`, and no package defines a `verify` script. Because of
`--if-present`, it silently skips everything and exits successfully. Anyone wiring `pnpm verify` into a hook or a
pipeline gets a green result that verified nothing. Use `pnpm check` instead.

## Exact versions, by decision

Every dependency version lives in one place — the `catalog:` block of `pnpm-workspace.yaml` — and every version is exact.
No carets, no tildes. `catalogMode: manual` and `cleanupUnusedCatalogs: true`.

The rationale is recorded in a comment in that file and mandated by `AGENTS.md`, and it is a genuine causal chain rather
than a style preference:

1. All four `@aaplugin/*` packages are pinned at `1.0.0-beta.1`.
2. A range would silently pick up the next beta and swap the builder.
3. A builder change directly changes artifact bytes.
4. Byte-equivalence of the build is a product acceptance criterion, established in `AGENTS.md`.

Therefore upgrading must be an explicit, reviewable action. Step 4 has been observed to hold: two consecutive builds
produced 72 `dist/` files with matching checksums. That was a point-in-time observation, not a standing guarantee, and
nothing re-checks it — see the CI gap below.

A bump of all four `@aaplugin/*` pins to `1.0.0-beta.2` exists as an **uncommitted working-tree change** and is not part
of the recorded baseline. The baseline state is `beta.1`.

The same policy applies to `eslint`, `typescript`, `vitest`, `@antfu/eslint-config`, `@types/node`, and `yaml`. `yaml` is
the only runtime dependency of the package; everything else is a devDependency. That matters — the shipped Runtime's only
third-party code is a YAML parser.

## The unvalidated schema

`packages/context/public/schemas/runtime.schema.json` is shipped as if it were the wire contract. **It is validated by
nothing.** No JSON-Schema validator is wired to these schemas: `ajv@6.15.0` is present in the tree, but only as an
`eslint` transitive dependency, and nothing routes it at these files. So no test, no build step, and no runtime check
compares the schema to the implementation. It has drifted in six confirmed ways:

| # | Schema says | Implementation does |
|---|---|---|
| 1 | `frontier.query` `body` is a string | emits an object (the `BodyChunk` with `text`/`startByte`/`endByte`/`totalBytes`/`complete`) |
| 2 | `repository.inspect` `context` has `additionalProperties: false` without `sourceState` | also emits `sourceState` |
| 3 | `selected[].state` omits `source_unavailable` | also emits `source_unavailable` |
| 4 | `growth.measure` `perDomain` is an object | emits an array |
| 5 | `delta.compute` `brokenEvidence` items are strings | emits objects |
| 6 | `transaction.resume` input has no `disposition` | accepts `disposition: continue\|abandon` |

Items 2 and 3 are the sharp ones: a consumer that actually enforced this schema would *reject valid Runtime responses*.

**The code plus the 158 tests are the real contract.** Treat `runtime.schema.json` as stale documentation. Either wire a
validator into `pnpm check` or stop shipping the file; leaving it in place unvalidated is the worst of the three options,
because it looks authoritative.

`document.schema.json` and `meta.schema.json` are also unvalidated by any tooling, but they mirror the implementation
faithfully at HEAD, so they are useful reference. Note that `document.schema.json` even encodes the forbidden source
segments (`.git`, `.scratch`, `context`, `node_modules`) into a single regex — impressive, and a second place that must be
edited if the segment list ever changes.

## What this repository does not do

Recorded because their absence is easy to assume away:

- **No CI.** There is no `.github/` directory and no pipeline configuration of any kind. Every check is local and manual.
  `AGENTS.md` does specify what routine CI must be — offline, invoking no model — so the absence is a gap against a
  recorded intent, not an undecided question.
- **No release or publish script.** No version bumping, no packing step. Both packages are private. The absence of
  Changesets is a **recorded decision** in `AGENTS.md`, not an oversight: there is currently no npm publish pipeline for
  it to drive. Turborepo is refused by the same document.
- **No produced release artifact.** The root `README.md` states that the install source is a GitHub Release archive, but
  nothing in the repository produces one. Release construction is manual and unrecorded — the procedure exists only in
  whoever's head last performed it.

## Two gaps inside the test gate

`packages/context/vitest.config.ts` is small and both of its settings matter:

- `include: ['tests/runtime/*.test.ts']` — the suite is **filtered by default**. Only that one directory, one level deep,
  is collected. A test placed anywhere else, including a nested subdirectory, is silently not run. `pnpm test` passing is
  therefore not evidence that every test file in the repository passed.
- `coverage: { enabled: false }` — coverage is off by default, so nothing reports which branches the 158 tests miss.
  `AGENTS.md` requires new features to add tests by risk and names five must-cover areas (transaction failure paths and
  fault injection, the three recovery outcomes, concurrency checks, path-safety refusal, budget-overflow cursors). With
  coverage disabled there is no mechanical check that those areas stay covered.

`testTimeout` is 30 seconds, which is generous and suits the filesystem-heavy transaction tests.

The combination of "byte-equivalence is an acceptance criterion" and "no CI verifies it" is the notable tension in this
Domain. The dependency policy exists to protect a property that nothing automatically checks.
