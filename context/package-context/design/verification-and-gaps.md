---
schema: plugydown.context.document/v1
id: package-context.verification-and-gaps
description: Context-specific Schema, Runtime, delivery and Repair verification, plus the limits of concurrency tests and unexecuted real-host sessions.
kind: decision
domain: package-context
relations:
  requires:
    - package-context
  related:
    - engineering.workspace-and-delivery
    - development-standards.testing-and-validation
    - package-context.enforcement-boundary
  supersedes:
    - delivery.verification-and-gaps
code:
  paths:
    - packages/context/delivery.json
    - packages/context/host-validation.md
    - packages/context/package.json
    - packages/context/scripts/verify-delivery.ts
    - packages/context/tests/delivery/platforms.test.ts
    - packages/context/tests/runtime/fixture.ts
    - packages/context/tests/runtime/knowledge.test.ts
    - packages/context/tests/runtime/repair.test.ts
    - packages/context/tests/runtime/transaction.test.ts
    - packages/context/vitest.config.ts
---

# Context verification and remaining gaps

Shared gate ordering and infrastructure are documented in `development-standards.testing-and-validation` and
`engineering.workspace-and-delivery`. This Document owns the evidence specific to packages/context.

## Package gates and delivery checks

The package supplies typecheck (tsc --noEmit), test (vitest run), AAPlugin build/validate/inspect/dev, and the read-only
delivery verifier. Root lint uses ESLint. Root check covers only lint, typecheck, test and build; validation, inspect and
delivery verification remain separate requirements.

`packages/context/scripts/verify-delivery.ts` snapshots every dist file's relative path, SHA-256 and permission mode,
including hidden directories, and refuses symlinks or special files. The shared CI's Context-specific comparison adds
its inspect report, builds again and fails on any byte, mode, path or report difference.

The verifier uses the complete release units in `packages/context/delivery.json`, not a blanket marketplace assumption.
It checks Runtime mode 0755, the adjacent third-party YAML license, copied schema bytes, discovered Skill-relative
Runtime/index paths, canonical role bodies, native registrations, private-role isolation and host metadata. Each shipped
Runtime is executed with a separate empty business Git repository as cwd. Its response must satisfy the public Schema
and report absent Context; Runtime and license bytes must agree across hosts.

`tests/delivery/platforms.test.ts` builds through the public runProject API using registry-installed dependencies. It
requires native Runtime compatibility and only native/transform capability results. It compares repeated bytes, modes
and reports, and proves that selecting more Platforms preserves existing Claude/Codex output. Missing Contributors and
canonical Agent collisions must fail while preserving the previous complete output.

The same suite invokes generated OpenCode and Pi Hook modules through simulated callbacks: business cwd, deduplicated
OpenCode system hints, Pi messages without an unsolicited new turn, and absent-Context behavior. These are adapter tests,
not real host sessions.

## Public Schemas

One delivery contains document.schema.json, meta.schema.json and runtime.schema.json. The strict Ajv 2020-12 checks in
`tests/runtime/fixture.ts` verify every produced Runtime response, every request accepted by Runtime, and committed
Meta/front matter after a successful commit. Rejected requests may be intentionally malformed. The single Meta Schema
uses its discriminator to accept v1/v2 while allowing reviewRequired only in v2; knowledge tests verify that distinction
against Runtime parsing.

The source path rules appear in both document and Runtime Schemas: .git, .scratch and context are forbidden only as the
first segment, while node_modules is forbidden at any depth. Changes to those rules must keep parser and public Schemas
aligned. A shape no test produces remains outside the Schema assertions executed by that run.

## Runtime risk coverage

The Runtime suite includes exact protocol rejection, graph/ledger integrity, path refusal, budget/cursor behavior,
transaction approval freshness, failure injection and recovery. Repair tests reproduce an actual Git merge of two
independently transacted branch edits, preserve merged Markdown and source/baseline records, test dry-run and incomplete
scope, retain reviewRequired with unchanged sources, and clear only authorized reviewed obligations through Update.

Concurrency includes rival-lock fixtures and simultaneous begin calls in one process. This is not multiprocess or
network-filesystem stress testing. Recovery tests exercise candidate completion, original restoration, conflicting
copies and no trusted copy. Passing assertions do not establish unmeasured coverage or semantic review quality.

## Delivery and acceptance boundaries

Context is private and released through Git refs. The manually started release workflow reads this package's version,
rejects an existing tag, reuses CI and publishes mapped complete units; see `engineering.workspace-and-delivery` for
job order and retry behavior. The package's yaml Runtime dependency and Ajv development dependency come from the exact
catalog. No separate npm product publishing or version-bump tooling is implied.

`vitest.config.ts` recursively collects tests/**/*.test.ts, disables coverage reporting and uses a default 30-second
per-test timeout. `packages/context/host-validation.md` records actual sessions on all six hosts as unexecuted. Schema
checks, Node subprocesses and simulated callbacks cannot establish installation, workflow discovery, model-visible
paths, native delegation or inline roles inside those hosts. Antigravity support is the CLI contract, not App/IDE.

Real acceptance follows the package README and host procedure. Current command sources also include Repair; validate
its discovery and merge/rebase workflow when extending actual host acceptance. Do not mark any such session passed
because this automated suite is green.
