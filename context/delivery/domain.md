---
schema: plugydown.context.document/v1
id: delivery
description: How the monorepo is packaged for two hosts by a single builder, the exact-version dependency policy, the verification gate, and what the repository does not do.
kind: domain
domain: delivery
---

# Delivery

A pnpm monorepo with one package, `@plugydown/context`, which AAPlugin builds into four artifacts: a plugin and a
marketplace entry for each of Claude Code and Codex. Root package is `plugydown-workspace`, private, ESM, pnpm 10.34.5,
Node `^20.19.0 || ^22.13.0 || >=23.5.0`. 45 tracked files at the recorded HEAD.

## What lives here

- `delivery.packaging` — the one builder, dual-platform emission, role delivery per host, and the session-start hook.
- `delivery.ownership-boundary` — what AAPlugin owns, the eight prohibitions, and the capability-gap procedure.
- `delivery.verification-and-gaps` — the verification gate, the dependency policy, the unvalidated schema, and what the
  repository does not produce.

## One builder, no exceptions

`aaplugin build` is the only thing that emits deliverables. `tsconfig.base.json` sets `noEmit: true`, so `tsc` is
structurally incapable of producing output — it is a checker only. There is no bundler config, no separate compile step,
and no hand-assembled `dist/`. `dist/` is gitignored.

This is worth stating as an invariant because it is what makes byte-equivalence of the build meaningful: there is exactly
one code path from source to artifact.

## Both packages are private

Root and `@plugydown/context` are both `"private": true`. Nothing here publishes to a registry.

## The engineering constitution

`AGENTS.md` at the repository root is the authority for this Domain. It establishes the ownership boundary between this
repository and AAPlugin, eight explicit prohibitions, the procedure for a framework capability gap, the exact-version
dependency policy, and the byte-equivalence requirement that the rest of this Context leans on. Recorded in
`delivery.ownership-boundary`.

Two tool choices are recorded *decisions* there rather than accidents: no Turborepo, and no Changesets (there is
currently no npm publish pipeline for Changesets to drive).

## Observed state at HEAD

Observed passing: `pnpm lint` (0 problems), `pnpm typecheck` (0 errors), `pnpm test` (158 tests across 6 files),
`pnpm build` (`success (claude-code, codex)`), `pnpm validate`, `pnpm inspect`. Two consecutive builds were observed to
produce 72 `dist/` files with identical checksums.

These are point-in-time observations, not standing guarantees — there is no CI, so nothing re-checks any of them.
