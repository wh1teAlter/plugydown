---
schema: plugydown.context.document/v1
id: delivery.verification-and-gaps
description: The verification gate and the CI that runs it, the exact-version dependency policy and its stated rationale, how the published JSON Schemas are held to the implementation, the release job, and what the repository still does not do.
kind: decision
domain: delivery
relations:
  requires:
    - delivery
  related:
    - authority-workflow.enforcement-boundary
code:
  paths:
    - pnpm-workspace.yaml
    - .github/workflows/ci.yml
    - packages/context/tests/runtime/fixture.ts
    - packages/context/vitest.config.ts
---

# Verification and gaps

## The gate

```
pnpm check = lint && typecheck && test && build
```

Root scripts fan out with `pnpm -r --if-present run <name>`. The package supplies `typecheck` (`tsc --noEmit`), `test`
(`vitest run`), `build`, `validate`, `inspect`, and `dev`; `lint` is root-level `eslint .`.

Note that `check` does **not** include `validate` or `inspect`. Those are separate invocations, and CI runs them.

## CI

`.github/workflows/ci.yml` triggers on pushes to `main` and `dev`, on pull requests, and on `context--v*` tags. Its
`verify` job installs with `--frozen-lockfile` and runs lint, typecheck, test, build, and validate on Node 20.19.0,
22.13.0, and 24.x, without `fail-fast`, so one Node version failing does not hide the others.

It then proves the build deterministic. It records the SHA-256 of every file under `packages/context/dist` together with
the `pnpm inspect` report, builds again, records both again, and diffs the two records. Any difference fails the job.
This is the byte-equivalence acceptance criterion from `AGENTS.md` enforced mechanically, on every run and every Node
version, rather than observed once.

### The release job

On a `context--v*` tag, a `release` job runs after `verify` passes. It builds on Node 24.x and fails unless the tag's
version equals the version in `packages/context/package.json`. It then publishes each platform's built marketplace
(`dist/<platform>/marketplace`), unmodified, as the tree of the branches `release-claude-code` and `release-codex`,
continuing each branch's history and skipping the commit when the branch already holds that build. Installers clone a Git
ref, never an archive, and `main` stays free of generated artifacts.

## Exact versions, by decision

Every dependency version lives in one place — the `catalog:` block of `pnpm-workspace.yaml` — and every version is exact.
No carets, no tildes. `catalogMode: manual` and `cleanupUnusedCatalogs: true`.

The rationale is recorded in a comment in that file and mandated by `AGENTS.md`, and it is a genuine causal chain rather
than a style preference:

1. All four `@aaplugin/*` packages are pinned at `1.0.0-beta.3`.
2. A range would silently pick up the next beta and swap the builder.
3. A builder change directly changes artifact bytes.
4. Byte-equivalence of the build is a product acceptance criterion, established in `AGENTS.md`.

Therefore upgrading must be an explicit, reviewable action. The byte-equivalence in step 4 is checked on every CI run by
the double-build diff above.

The same policy applies to `eslint`, `typescript`, `vitest`, `@antfu/eslint-config`, `@types/node`, `yaml`, and `ajv`.
The `ajv` here is major version 8, a direct devDependency of the package pinned in the catalog; it is distinct from the
ajv 6 that `eslint` pulls in transitively. `yaml` is the only runtime dependency of the package; everything else is a
devDependency, `ajv` included. That matters — the shipped Runtime's only third-party code is a YAML parser.

## The published schemas are validated

`packages/context/public/schemas/` ships `document.schema.json`, `meta.schema.json`, and `runtime.schema.json`, and the
test suite holds all three to the implementation. `packages/context/tests/runtime/fixture.ts` compiles each with ajv's
2020-12 build in strict mode, and every test reaches the Runtime through its helpers, which check:

- every Runtime response against `runtime.schema.json`
- every request the Runtime accepted against the same schema (rejected requests are deliberately malformed in many tests,
  so they are not checked)
- after each successful commit, the committed `meta.json` against `meta.schema.json` and every committed Document's front
  matter against `document.schema.json`

A schema that drifts from the implementation therefore fails the test that exposed it. The check is only as wide as the
suite: a response shape no test produces is not compared, so the code plus the tests remain the final contract.

`document.schema.json` and `runtime.schema.json` encode the forbidden source roots so that `.git`, `.scratch`, and
`context` fail only as the first segment, and `node_modules` fails at any level — a second place that must be edited if
the rule ever changes.

## What this repository does not do

Recorded because their absence is easy to assume away:

- **No version-bump or npm publishing tooling.** Both packages are private, and the version is raised by editing
  `package.json`, which the release job then requires the tag to match. The absence of Changesets is a **recorded
  decision** in `AGENTS.md`, not an oversight: there is currently no npm publish pipeline for it to drive. Turborepo is
  refused by the same document.

## Two gaps inside the test gate

`packages/context/vitest.config.ts` is small and both of its settings matter:

- `include: ['tests/runtime/*.test.ts']` — the suite is **filtered by default**. Only that one directory, one level deep,
  is collected. A test placed anywhere else, including a nested subdirectory, is silently not run. `pnpm test` passing is
  therefore not evidence that every test file in the repository passed.
- `coverage: { enabled: false }` — coverage is off by default, so nothing reports which branches the filtered suite
  misses. `AGENTS.md` requires new features to add tests by risk and names five must-cover areas (transaction failure
  paths and fault injection, the three recovery outcomes, concurrency checks, path-safety refusal, budget-overflow
  cursors). With coverage disabled there is no mechanical check that those areas stay covered.

`testTimeout` is 30 seconds, which is generous and suits the filesystem-heavy transaction tests.

CI inherits both gaps: it runs the same filtered suite with coverage off, so a green pipeline proves what a green local
`pnpm test` proves and no more.
