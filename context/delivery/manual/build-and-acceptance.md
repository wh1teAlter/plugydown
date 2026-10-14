---
schema: plugydown.context.document/v1
id: delivery.build-and-acceptance
description: Operator SOP for the six AGENTS.md gates, the dual-build checksum of `packages/context/dist/`, and what CI already runs for you.
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
    - .github/workflows/ci.yml
    - .github/workflows/release.yml
---

# Build and acceptance

How to run the gates. Why they exist, how the published schemas are validated, CI, and the filtered-suite gaps live in
`delivery.verification-and-gaps`. Packaging and the single-builder invariant live in `delivery.packaging`.

Install with `pnpm install --frozen-lockfile`.

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

CI runs this for you on pushes to `main` and `dev` and on pull requests, and as the first stage of a release: the gates
up to `validate`, then a second build whose `dist/` file hashes and `pnpm inspect` report are diffed against the first.
A local double build is still the quickest way to reproduce a CI mismatch.

## Publishing

To publish, bump the version in `packages/context/package.json`, merge to `main`, then run the release workflow by hand
(a dry run is available). The detail lives in `delivery.verification-and-gaps`.

## What this SOP does not cover

The filtered-suite and coverage gaps, how the published schemas are validated, the exact-version catalog policy
(`@aaplugin/*` at `1.0.0-beta.3`), and the release workflow that publishes the per-platform release branches are
recorded in `delivery.verification-and-gaps`. Do not treat a green `pnpm check` as having closed those.
