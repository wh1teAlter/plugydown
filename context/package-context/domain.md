---
schema: plugydown.context.document/v1
id: package-context
description: "Context product boundaries and routing for Markdown knowledge, immutable confirmations, scoped queries, migration, transactions, roles and six-host delivery."
kind: domain
domain: package-context
relations:
  related:
    - engineering
    - development-standards
  supersedes:
    - authority-workflow
    - knowledge-model
    - read-plane
    - repository-access
    - runtime-protocol
    - write-plane
code:
  paths:
    - packages/context/package.json
    - packages/context/README.md
    - packages/context/aaplugin.config.ts
    - packages/context/src/skills/context/SKILL.md
---

# Context package

This Domain owns knowledge about `packages/context`, the `@plugydown/context` product. Runtime protocol, knowledge grammar,
filesystem access, read/write planes and role workflows are package topics, not a reusable repository-wide framework.
A future product receives its own `package-<directory-name>` Domain.

Repository infrastructure belongs to `engineering`; cross-package coding and validation requirements belong to
`development-standards`. Link to shared rules rather than making this product's implementation mandatory everywhere.

## Product boundary

Current knowledge lives in Markdown/front matter under the business repository's `context/`. `.meta/manifest.json` is
the single format entry; `.meta/confirmations/` holds immutable complete-input confirmations. Current matching is derived
on read. There is no mutable current-content ledger, persistent reviewRequired flag or daily Repair workflow.

The installed plugin operates in business cwd and its `.scratch/` collections. AAPlugin delivers the same product to
Claude Code, Codex, Cursor, Antigravity CLI, OpenCode and Pi. Runtime computes facts, checks scope and binds approvals to
bytes. The host owns actual semantic review. Private inline roles are not independently executed Agents or sandboxes.

## Choose the relevant topic

| Work | Documents |
|---|---|
| Markdown grammar, placement and relations | `package-context.document-grammar` |
| Metadata, complete-input confirmations and baselines | `package-context.meta-ledger` |
| Requests, statuses, invocation and evidence | `package-context.wire-contract`, `package-context.capability-invocation` |
| Budgets, cursors and deterministic bytes | `package-context.budgets-and-cursors`, `package-context.determinism` |
| Paths, globs and collected Git facts | `package-context.path-and-glob-safety`, `package-context.git-evidence` |
| Read projections, confirmation matching and scoped impact | `package-context.capabilities`, `package-context.delta-and-light` |
| Transaction phases, write scope and recovery | `package-context.transaction-lifecycle`, `package-context.scope-authorization`, `package-context.outcomes-and-recovery` |
| Ordinary rebase and explicit old-format conversion | `package-context.migration-and-confirmation` |
| Roles and temporary resources | `package-context.roles-and-briefs`, `package-context.scratch-lifecycle`, `package-context.enforcement-boundary` |
| Delivery and acceptance | `package-context.packaging`, `package-context.verification-and-gaps`, `package-context.build-and-acceptance` |

The private Node Runtime accepts one JSON request on stdin and returns one JSON response on stdout. There are seven read
capabilities and one transaction capability with four actions. Init, Update, Prune and Migrate are transaction commands,
not executables. There is no HTTP service, daemon or alternate Runtime entry.

All mutating Runtime filesystem calls remain in transaction.ts. Writes stage a complete candidate, validate it, obtain
fingerprint-bound approval, switch directories and verify the result. Read-only checks do not create confirmation files
or recovery state. Unmatched confirmations permit ordinary reading and Update; damaged structure still needs correction.

## Bounded use of a package Domain

Use descriptions and explicit Document selectors. Depth 3 returns a body only for IDs explicitly named in
selectors.documentIds; selecting this entire Domain does not request all bodies. Delta reports scoped mismatches and
requires-only reading prerequisites, not automatic updates to every Domain sibling. The concentrated growth hint can
still fire for a large package Domain; it does not authorize regrouping or Prune.
