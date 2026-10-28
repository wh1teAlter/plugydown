---
schema: plugydown.context.document/v1
id: engineering
description: Shared monorepo engineering — workspace and toolchain, AAPlugin ownership, CI/release infrastructure and adding packages. Product implementation belongs to its package Domain.
kind: domain
domain: engineering
relations:
  related:
    - development-standards
    - package-context
  supersedes:
    - delivery
code:
  paths:
    - README.md
    - AGENTS.md
    - package.json
    - pnpm-workspace.yaml
    - .github/workflows/ci.yml
    - .github/workflows/release.yml
---

# Shared engineering

Plugydown is a monorepo of AI workflow products. Each directory under `packages/` owns a product built with AAPlugin;
framework lifecycle and host rendering belong upstream. This Domain owns infrastructure and boundaries shared by those
products. It does not make `packages/context` internals into a reusable framework.

## Route by ownership

| Question | Start with |
|---|---|
| Workspace, dependencies, root scripts and current release wiring | `engineering.workspace-and-delivery` |
| AAPlugin ownership, prohibited workarounds and capability gaps | `engineering.aaplugin-boundaries` |
| Adding another product and its knowledge Domain | `engineering.adding-a-package` |
| Coding, comments, tests and change safety | `development-standards` |
| Context Runtime, roles and host-specific delivery | `package-context` |

Formal knowledge is organized as flat peer Domains: `package-<directory-name>` for each existing product, plus
`engineering` and `development-standards`. Keep each Domain's required `domain.md` and optional `design/`, `manual/`,
`reflections/` directories. Do not insert a `context/packages/<name>/` level: the Context grammar does not allow it.

Put a fact in shared engineering when it describes root-owned tooling, infrastructure or an AAPlugin integration
boundary applicable across packages. Put it in a package Domain when it describes that product's implementation or
delivery choices. Use `related` for optional shared context; use `requires` only for genuine reading prerequisites.

## Current expansion boundary

Workspace discovery and several root commands already cover `packages/*`. The current CI byte comparison and release
workflow explicitly target Context. Adding a workspace package alone does not publish it. The onboarding guide names
the integration work needed to extend those package-specific steps without adding a second builder.
