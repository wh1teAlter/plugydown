---
schema: plugydown.context.document/v1
id: delivery
description: How the monorepo is packaged for two hosts by a single builder, the exact-version dependency policy, the verification gate, and what the repository does not do.
kind: domain
domain: delivery
code:
  paths:
    - packages/context/aaplugin.config.ts
    - packages/context/package.json
    - .github/workflows/ci.yml
---

# Delivery

A pnpm monorepo with one package, `@plugydown/context`, which AAPlugin builds into four artifacts: a plugin and a
marketplace entry for each of Claude Code and Codex. Root package is `plugydown-workspace`, private, ESM, pnpm 10.34.5,
Node `^20.19.0 || ^22.13.0 || >=23.5.0`.

## What lives here

- `delivery.packaging` — the one builder, dual-platform emission, role delivery per host, and the session-start hook.
- `delivery.ownership-boundary` — what AAPlugin owns, the eight prohibitions, and the capability-gap procedure.
- `delivery.verification-and-gaps` — the verification gate, CI and the release job, the dependency policy, how the
  published schemas are validated, and what the repository does not do.
- `delivery.build-and-acceptance` — the operator SOP for the six gates, how CI runs them, and dual-build checksum.

## One builder, no exceptions

`aaplugin build` is the only thing that emits deliverables. `tsconfig.base.json` sets `noEmit: true`, so `tsc` is
structurally incapable of producing output — it is a checker only. There is no bundler config, no separate compile step,
and no hand-assembled `dist/`. `dist/` is gitignored.

This is worth stating as an invariant because it is what makes byte-equivalence of the build meaningful: there is exactly
one code path from source to artifact.

## Both packages are private

Root and `@plugydown/context` are both `"private": true`. Nothing here publishes to a registry; installers clone a Git
ref instead, from the release branches CI publishes (see below).

## The engineering constitution

`AGENTS.md` at the repository root is the authority for this Domain. It establishes the ownership boundary between this
repository and AAPlugin, eight explicit prohibitions, the procedure for a framework capability gap, the exact-version
dependency policy, and the byte-equivalence requirement that the rest of this Context leans on. Recorded in
`delivery.ownership-boundary`.

Two tool choices are recorded *decisions* there rather than accidents: no Turborepo, and no Changesets (there is
currently no npm publish pipeline for Changesets to drive).

## Continuous integration

`.github/workflows/ci.yml` runs lint, typecheck, test, build, and validate on Node 20.19.0, 22.13.0, and 24.x for every
push to `main` or `dev`, every pull request, and every `context--v*` tag. It then builds a second time and diffs the
hash of every `dist/` file plus the `pnpm inspect` report against the first build, so byte-equivalence is checked
rather than assumed. On a `context--v*` tag whose version matches the built `package.json` version, a release job
publishes each platform's built marketplace, unmodified, to the branches `release-claude-code` and `release-codex`.
The filtered test include `tests/runtime/*.test.ts` and `coverage.enabled: false` still limit what a green run proves;
see `delivery.verification-and-gaps`.
