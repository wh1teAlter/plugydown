---
schema: plugydown.context.document/v1
id: engineering.workspace-and-delivery
description: Root-owned pnpm workspace and exact catalog dependencies, recursive checks, the single AAPlugin build path, and CI/release steps that still explicitly target Context.
kind: architecture
domain: engineering
relations:
  requires:
    - engineering
  related:
    - engineering.aaplugin-boundaries
    - engineering.adding-a-package
    - development-standards.testing-and-validation
    - package-context.packaging
code:
  paths:
    - README.md
    - AGENTS.md
    - package.json
    - pnpm-workspace.yaml
    - .github/workflows/ci.yml
    - .github/workflows/release.yml
---

# Workspace and delivery infrastructure

## Toolchain and dependencies

Development and delivered Runtimes require Node.js 24 or later and ESM. The root `packageManager` pins pnpm;
`pnpm-workspace.yaml` discovers `packages/*` and centralizes versions in its catalog. Packages consume catalog entries
instead of inventing parallel version declarations. Do not use npm/yarn, Turborepo or Changesets.

AAPlugin kit, Platforms and Extensions must use exact registry versions. They are beta dependencies: a range could
silently change the builder, and builder changes can alter delivered bytes. Upgrades are explicit reviewed changes.
The current catalog also pins tooling exactly, uses manual catalog mode and removes unused catalog entries. Read the
catalog for current versions. Final product dependencies cannot use `file:`, outside-repository `workspace:`, or Git
SHA/URL sources.

## Root commands

`lint` runs root ESLint. `typecheck`, `test`, `build`, `validate`, `inspect` and `verify:delivery` delegate with
`pnpm -r --if-present run <name>`. A new package participates by supplying the appropriate scripts; `--if-present`
does not prove that every package implemented every required gate. Root `dev` currently selects `@plugydown/context`.

`pnpm check` runs only lint, typecheck, test and build. The remaining validate, inspect and delivery gates are explicit;
see `development-standards.testing-and-validation`. `tsc --noEmit` checks types and must never produce delivery bytes.
AAPlugin is the only builder, and no step may patch its output afterward.

## CI and reproducibility

`ci.yml` runs on pushes to `main`/`dev`, pull requests and workflow calls. It installs the pinned pnpm and Node 24,
uses `pnpm install --frozen-lockfile`, then runs the required checks without model calls. There is no Node version
matrix or publication step in CI.

Its repeated-build step currently invokes Context's snapshot script and filtered inspect command. It compares paths,
SHA-256 bytes, permissions and the inspect report across two builds, including hidden files. Root recursive commands
can discover another package, but this explicit comparison must be extended when that package gains delivery output.

## Publication is currently Context-specific

`release.yml` is manually dispatched on `main`, serialized by a release concurrency group, and has prepare, verify and
publish jobs. Prepare reads Context's package version and refuses an existing `context--v<version>` tag. Verify reuses
CI at the selected commit. Publish builds, reads Context's delivery map, writes complete output units to the six
`release-<platform>` branches, then creates the tag and GitHub Release.

Branches are published before the tag so an interrupted release can be retried; a branch already containing the same
build is skipped. `dry_run` builds and reports without pushes, tags or Releases. Hidden directories, executable modes
and licenses are preserved. Root and Context are private packages; there is no npm publishing pipeline.

A future product needs an explicit release target, namespace and complete-unit mapping. Existing Context release
branches must not be reused as if the workflow already multiplexed products. Package-specific installation and host
acceptance remain with that package's knowledge, for Context in `package-context.build-and-acceptance`.
