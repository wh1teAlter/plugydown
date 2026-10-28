---
schema: plugydown.context.document/v1
id: engineering.adding-a-package
description: How to add a product under packages/ and a matching package Domain, including shared catalog use and the CI/release integration that workspace discovery does not provide automatically.
kind: guide
domain: engineering
relations:
  requires:
    - engineering.workspace-and-delivery
    - engineering.aaplugin-boundaries
  related:
    - development-standards.coding-and-comments
    - development-standards.testing-and-validation
code:
  paths:
    - README.md
    - AGENTS.md
    - package.json
    - pnpm-workspace.yaml
    - .github/workflows/ci.yml
    - .github/workflows/release.yml
---

# Adding a package

1. Create the product in `packages/<name>` with its own package identity, ESM configuration and Node 24+ requirement.
   Add it to the root README package inventory. Workspace discovery already covers the directory pattern.
2. Reuse shared catalog dependencies. Any new AAPlugin dependency must have an exact catalog version. Keep the product
   implementation in its package; do not copy Context's Runtime or turn it into an implicit shared framework.
3. Declare canonical AAPlugin inputs, the Platforms actually supported, any explicit unique Runtime entry and official
   Hook handlers. Use public Extension/Contributor contracts for package-specific integration. Do not write manifests
   or post-process `dist/`.
4. Supply package scripts so root recursive gates include it. Add risk-appropriate offline tests and a complete-unit
   delivery check. Extend CI's currently Context-specific repeated-build comparison for the new output.
5. If publication is needed, explicitly extend or provide the package's release workflow and namespace. Merely placing
   the package in the workspace does not change the Context-only version/tag/map assumptions in `release.yml`.
6. Through an authorized Context transaction, create `context/package-<name>/domain.md`. Its id and domain are
   `package-<name>`; child IDs begin with that prefix. Add only the populated standard category directories.
7. Keep implementation and acceptance documents in that package Domain. Link shared tooling to `engineering`, and
   coding/testing requirements to `development-standards`. A genuinely new shared contract belongs in a shared Domain
   once; do not duplicate it in every package.
8. Validate graph relations, document placement and source declarations before committing the candidate. Cite real
   tracked source paths such as `packages/<name>/src/**`, not generated or ignored output. Keep descriptions useful
   for selecting a small reading frontier.

The package Domain is a routing boundary, not proof that every file or capability has been reviewed. Record host
acceptance separately from automated checks and declare unsupported delivery capabilities explicitly.
