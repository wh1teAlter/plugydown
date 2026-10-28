---
schema: plugydown.context.document/v1
id: package-context
description: The packages/context product — knowledge grammar, private Runtime, queries, transactions and Repair, role workflows, and six-host delivery. Start here for Context implementation work.
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

This Domain owns the knowledge about `packages/context`, the `@plugydown/context` product. Runtime protocol, knowledge
grammar, filesystem access, read/write planes and role workflows are topics inside this package, rather than independent
repository-wide Domains. A future package receives its own `package-<directory-name>` Domain.

Repository infrastructure belongs to `engineering`; cross-package coding and validation requirements belong to
`development-standards`. Link to those rules instead of making Context's implementation a rule for every product.

## Product boundary

Context stores formal repository knowledge as Markdown plus a Runtime-managed ledger under the business repository's
`context/`. The installed plugin uses the business repository cwd and its `.scratch/` collections, not a workspace in
the plugin installation. It is delivered through AAPlugin to Claude Code, Codex, Cursor, Antigravity CLI, OpenCode and Pi.

The product combines mechanical Runtime checks with a prose authority workflow. Runtime authorizes document scope and
binds approval to bytes; the host assistant is responsible for actual semantic review and role separation. Model/tool
preferences are not a Runtime-enforced sandbox. On hosts with private role resources, inline role execution is not an
independently executed Agent.

## Choose the relevant topic

| Work | Documents |
|---|---|
| Markdown grammar, layout and graph relations | `package-context.document-grammar` |
| Content/source fingerprints, Meta versions and readiness | `package-context.meta-ledger` |
| Requests, statuses and the meaning of evidence | `package-context.wire-contract`, `package-context.capability-invocation` |
| Output budgets, cursors and deterministic bytes | `package-context.budgets-and-cursors`, `package-context.determinism` |
| Paths, globs and host-collected Git facts | `package-context.path-and-glob-safety`, `package-context.git-evidence` |
| Read projections, pending review and impact analysis | `package-context.capabilities`, `package-context.delta-and-light` |
| Transaction phases, scope, commit and recovery | `package-context.transaction-lifecycle`, `package-context.scope-authorization`, `package-context.outcomes-and-recovery` |
| Merge/rebase content fingerprint recovery | `package-context.content-fingerprint-repair` |
| Investigator/Recorder/Reflector and temporary artifacts | `package-context.roles-and-briefs`, `package-context.scratch-lifecycle`, `package-context.enforcement-boundary` |
| Package delivery and acceptance | `package-context.packaging`, `package-context.verification-and-gaps`, `package-context.build-and-acceptance` |

The private Runtime accepts one JSON value on stdin and returns one JSON value on stdout. It has six read capabilities
and one `transaction` capability with four actions. Init, Update, Prune and Repair are transaction commands, not separate
executables. There is no HTTP service, daemon or alternate Runtime entry point.

All mutating Runtime filesystem calls live in `transaction.ts`. Reads do not create recovery artifacts. Writes stage a
complete candidate, validate it, obtain fingerprint-bound approval, switch directories and verify the result. Ordinary
reads refuse damaged formal knowledge; inspect can diagnose it, and the restricted Repair workflow can reconcile content
fingerprints without claiming that the merged prose has already been checked against source.

## Using a package-sized Domain

Use descriptions and explicit Document selectors to read only the relevant topic. Depth 3 returns a body only for IDs
explicitly named in `selectors.documentIds`; selecting this whole Domain does not request all bodies.

The current impact algorithm expands through Domain siblings. Grouping by package therefore makes `expandedImpact`
package-wide when a member is affected. `directImpact` remains the precise pending-review queue determined by content
review obligations and source fingerprints. The `concentrated` growth hint can also fire for this intentionally large
Domain; neither hint automatically authorizes regrouping or Prune.
