---
schema: plugydown.context.document/v1
id: delivery.verification-and-gaps
description: Automated delivery and schema checks, deterministic bytes and modes, exact registry dependencies, mapped Git releases, and real-host acceptance that remains unverified.
kind: decision
domain: delivery
relations:
  requires:
    - delivery
  related:
    - authority-workflow.enforcement-boundary
code:
  paths:
    - AGENTS.md
    - package.json
    - pnpm-workspace.yaml
    - .github/workflows/ci.yml
    - .github/workflows/release.yml
    - packages/context/tests/runtime/fixture.ts
    - packages/context/vitest.config.ts
    - packages/context/package.json
    - packages/context/delivery.json
    - packages/context/scripts/verify-delivery.ts
    - packages/context/tests/delivery/platforms.test.ts
    - packages/context/host-validation.md
---

# Verification and gaps

## The gate

```
pnpm check = lint && typecheck && test && build
```

Root scripts fan out with `pnpm -r --if-present run <name>`. The package supplies `typecheck` (`tsc --noEmit`), `test`
(`vitest run`), `build`, `validate`, `inspect`, `verify:delivery`, and `dev`; `lint` is root-level `eslint .`.

`check` does **not** include `validate`, `inspect`, or `verify:delivery`. Those remain separate gates; CI runs validate,
includes inspect in its repeated-build comparison, and finishes with delivery verification.

## CI

`.github/workflows/ci.yml` triggers on pushes to `main` and `dev` and on pull requests, and the release workflow also
calls it. Its `verify` job installs with `--frozen-lockfile` and runs lint, typecheck, test, build, and validate on
Node 24, the product's minimum supported major. Development and Runtime support Node 24 or later; CI has no version
matrix and never publishes.

It records a sorted snapshot of every file under `packages/context/dist` through
`scripts/verify-delivery.ts --snapshot`: relative path, SHA-256, and permission mode. The walker includes hidden
directories and refuses symlinks or special files. CI adds the JSON inspect report, builds again, and diffs both records.
Any byte, mode, path, or report difference fails the job.

`pnpm verify:delivery` reads the exact unit chosen by `delivery.json` for every Platform. It checks Runtime mode `0755`,
the adjacent YAML license, schema-copy bytes, all discovered Skill-relative Runtime/index paths, canonical role bodies,
native registrations, private-role isolation from public Skills, and the relevant host metadata. It executes every
shipped Runtime with a separate empty business Git repository as cwd, validates the JSON response, and requires
`repository.inspect` to report absent Context. Runtime and license bytes must agree across Platforms.

`tests/delivery/platforms.test.ts` builds through the public `runProject` API using registry-installed dependencies.
It requires native Runtime compatibility and only `native`/`transform` results, compares repeated-build bytes, modes,
and reports, and confirms that selecting more Platforms does not change the existing Claude/Codex bytes. Missing
Contributors and canonical Agent collisions must fail without replacing the previous complete output.

The same suite invokes the generated OpenCode and Pi Hook modules through simulated host callbacks. It checks business
cwd, OpenCode's deduplicated system hint, Pi's message without a new turn, and absence of hints when Context is absent.
These are adapter checks, not executed host sessions.

### The release workflow

`.github/workflows/release.yml` runs only on `workflow_dispatch`, with one boolean input, `dry_run`; nothing else starts
a release. A concurrency group allows one release at a time. It has three jobs:

- `prepare` refuses to run unless started on `main`, reads the version from `packages/context/package.json`, derives the
  tag `context--v<version>`, and refuses if that tag already exists. Installs refresh only when the version moves, so a
  second build under one version would never reach anyone who already installed it.
- `verify` calls `ci.yml`, so every CI check runs on the exact commit being released.
- `publish` builds on Node 24.x and iterates `packages/context/delivery.json`. Claude/Codex select marketplace units,
  Cursor/Antigravity select plugin units, OpenCode selects workspace, and Pi selects package. Each complete
  `dist/<platform>/<unit>` becomes the tree of `release-<platform>`, preserving bytes, modes, hidden directories, and
  licenses. It continues branch history, skips branches already holding this build, then creates the tag and a GitHub
  Release with notes generated from merged PRs.

Branches are pushed before the tag, so a run that fails partway leaves no tag and can be re-run. With `dry_run`, the run
reports what each branch would receive and pushes, tags and releases nothing. Product release is through Git refs;
OpenCode's workspace overlay must be merged into the business repository, while Pi can install the Git package ref.
There is no npm product publishing pipeline, and `main` stays free of generated artifacts.

## Exact versions, by decision

Every dependency version lives in one place — the `catalog:` block of `pnpm-workspace.yaml` — and every version is exact.
No carets, no tildes. `catalogMode: manual` and `cleanupUnusedCatalogs: true`.

The rationale is recorded in that file and mandated by `AGENTS.md`:

1. The kit, selected Platforms, and Hooks Extension use exact registry versions.
2. A range would silently pick up the next beta and swap the builder.
3. A builder change directly changes artifact bytes.
4. Byte-equivalence of the build is a product acceptance criterion, established in `AGENTS.md`.

Therefore upgrading is an explicit, reviewable action. Read the catalog for current versions instead of copying release
values into knowledge. Final product dependencies cannot use `file:`, outside-repository `workspace:`, or Git SHA/URL
sources. The repeated-build comparison checks the resulting byte-equivalence.

The tooling dependencies also use the exact catalog. `yaml` is the package's runtime dependency; `ajv` is a direct
development dependency for schema verification. Bundled YAML code requires the adjacent license file checked above.

## The published schemas are validated

`packages/context/public/schemas/` ships `document.schema.json`, `meta.schema.json`, and `runtime.schema.json`, and the
Runtime test suite holds all three to the implementation. `packages/context/tests/runtime/fixture.ts` compiles each
with ajv's 2020-12 build in strict mode. Its helpers check:

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
  `package.json`, from which the release workflow derives the tag and refuses a version already tagged. The absence of
  Changesets is a **recorded decision** in `AGENTS.md`, not an oversight: there is currently no npm publish pipeline for
  it to drive. Turborepo is refused by the same document.

## Collection and remaining verification limits

`packages/context/vitest.config.ts` recursively collects `tests/**/*.test.ts`, including Runtime and delivery tests.
It keeps `coverage.enabled: false` and a default 30-second timeout. A green suite establishes its assertions; it does
not report branch coverage or prove every required risk is covered. Risk-based testing obligations in `AGENTS.md`
still apply.

`packages/context/host-validation.md` explicitly records that real sessions on all six hosts remain unexecuted.
Schema checks, Node subprocesses, and simulated callbacks cannot establish installation, Skill/command discovery,
model-visible absolute paths, native delegation, inline role behavior, or SessionStart behavior inside those hosts.
Acceptance must record host version, install source, actual resolved paths, responses, and Hook observations. Antigravity
support here is the CLI contract, not an App/IDE claim.
