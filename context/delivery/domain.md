---
schema: plugydown.context.document/v1
id: delivery
description: Six-platform product delivery through one builder, the exact-version dependency policy, release units, and the distinction between automated verification and host acceptance.
kind: domain
domain: delivery
code:
  paths:
    - AGENTS.md
    - package.json
    - packages/context/aaplugin.config.ts
    - packages/context/package.json
    - packages/context/delivery.json
    - packages/context/host-validation.md
    - packages/context/scripts/verify-delivery.ts
    - packages/context/vitest.config.ts
    - .github/workflows/ci.yml
    - .github/workflows/release.yml
---

# Delivery

A private pnpm/ESM monorepo whose `@plugydown/context` product uses AAPlugin to deliver Claude Code, Codex, Cursor,
Antigravity CLI, OpenCode, and Pi from canonical sources. Development and every shipped Runtime require Node.js 24 or
later; the pnpm version is pinned by the root `packageManager` field.

## What lives here

- `delivery.packaging` — the one builder, release-unit mapping, role delivery per host, and the session-start hook.
- `delivery.ownership-boundary` — what AAPlugin owns, the eight prohibitions, and the capability-gap procedure.
- `delivery.verification-and-gaps` — the verification gate, CI and the release workflow, the dependency policy, how
  the published schemas are validated, and what the repository does not do.
- `delivery.build-and-acceptance` — the operator gates, repeated-build comparison, and real-host acceptance procedure.

## One builder, no exceptions

`aaplugin build` is the only delivery builder. `tsc --noEmit` only checks types; product code must not add a Runtime
compiler, renderer, or post-processing of `dist/`. Core compiles the explicitly declared `context` Runtime entry and
Platforms deliver it with the other assets. The config selects all six Platforms with `strict: true`.

## Both packages are private

Root and `@plugydown/context` are both `"private": true`. Product release uses Git branches, not npm.
`packages/context/delivery.json` is the shared release and acceptance mapping: Claude Code and Codex use marketplace
units, Cursor and Antigravity CLI use plugin units, OpenCode uses a workspace overlay, and Pi uses a package. Installers
need the complete unit, including hidden directories, Runtime, role resources, schemas, and licenses.

## The engineering constitution

`AGENTS.md` at the repository root is the authority for this Domain. It establishes the ownership boundary between this
repository and AAPlugin, eight explicit prohibitions, the procedure for a framework capability gap, the exact-version
dependency policy, and the byte-equivalence requirement that the rest of this Context leans on. Recorded in
`delivery.ownership-boundary`.

Two tool choices are recorded *decisions* there rather than accidents: no Turborepo, and no Changesets (there is
currently no npm publish pipeline for Changesets to drive).

## Continuous integration

`.github/workflows/ci.yml` only checks and never publishes. It runs lint, typecheck, test, build, and validate on
Node 24 for every push to `main` or `dev` and every pull request. It compares every `dist/` file's SHA-256 and mode,
plus the inspect report, across consecutive builds. `verify:delivery` checks the mapped release units and executes each
shipped Runtime against a separate business repository.

Publishing is the separate `.github/workflows/release.yml`, started by hand on `main`. It re-runs every CI check,
publishes each mapped delivery unit unchanged to `release-<platform>`, then tags `context--v<version>` and creates a
GitHub Release. The mapping is shared with verification so release cannot accidentally select marketplace units for
hosts that consume a different layout.

Tests recursively collect `tests/**/*.test.ts`; coverage remains disabled. Automated layout, protocol, and callback
checks do not establish real-host installation, discovery, or session behavior. Those sessions remain unexecuted in
`packages/context/host-validation.md`; see `delivery.verification-and-gaps`.
