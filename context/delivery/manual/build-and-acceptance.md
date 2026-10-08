---
schema: plugydown.context.document/v1
id: delivery.build-and-acceptance
description: Operator SOP for the six AGENTS.md gates, the dead `verify` script, and dual-build checksum of `packages/context/dist/`.
kind: guide
domain: delivery
relations:
  requires:
    - delivery
  related:
    - delivery.verification-and-gaps
    - delivery.packaging
code:
  paths:
    - package.json
    - packages/context/package.json
    - packages/context/vitest.config.ts
    - AGENTS.md
---

# Build and acceptance

How to run the gates. Why they exist, the schema drift, and the filtered-suite gaps live in
`delivery.verification-and-gaps`. Packaging and the single-builder invariant live in `delivery.packaging`.

Install with `pnpm install --frozen-lockfile`.

## Do not run `pnpm verify`

Root `verify` is `pnpm -r --if-present run verify`. No package defines `verify`, so `--if-present` makes this a silent
success. A green `verify` verified nothing.

## The six gates

`AGENTS.md` required sequence, in this order:

```
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm validate
pnpm inspect
```

`pnpm check` is `lint && typecheck && test && build`. It does **not** include `validate` or `inspect`. If you use
`check`, run those two yourself afterwards.

Root `lint` is `eslint .`. `typecheck`, `test`, `build`, `validate`, and `inspect` fan out with
`pnpm -r --if-present run <name>`. The package `@plugydown/context` supplies `typecheck` (`tsc --noEmit`), `test`
(`vitest run`), and `dev`/`build`/`validate`/`inspect` via aaplugin.

| Command | Operator meaning of failure |
|---|---|
| `pnpm lint` | format or lint (`eslint`) |
| `pnpm typecheck` | types (`tsc --noEmit`; it cannot emit) |
| `pnpm test` | a test in the **filtered** include failed. Passing is not "every test file in the repository passed" |
| `pnpm build` | `aaplugin build` refused the package. It is the only emitter |
| `pnpm validate` | plugin/package shape (`aaplugin validate`) |
| `pnpm inspect` | inspect of the built package (`aaplugin inspect --json`) |

`packages/context/vitest.config.ts` sets `include: ['tests/runtime/*.test.ts']` — one directory, not nested — and
`coverage.enabled: false`. `testTimeout` is 30 seconds. A test placed anywhere else, including a nested subdirectory,
is silently not run.

## Dual-build checksum

Byte-equivalence is an acceptance criterion. Run `pnpm build` twice and compare checksums of `packages/context/dist/`
(gitignored). Mismatch is a product failure, not a flake. Generated output must not contain timestamps or absolute
paths.

There is no CI. Nothing re-runs this for you.

## What this SOP does not cover

The unvalidated, drifted `runtime.schema.json`, the filtered-suite and coverage gaps, the exact-version catalog policy
(`@aaplugin/*` at `1.0.0-beta.3`), and the absence of a release script are recorded in
`delivery.verification-and-gaps`. Do not treat a green `pnpm check` as having closed those.
