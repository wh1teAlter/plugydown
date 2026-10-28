---
schema: plugydown.context.document/v1
id: development-standards
description: Cross-package development requirements — Chinese TSDoc, code and dependency conventions, safe Git changes, risk-based offline tests, deterministic output and honest validation claims.
kind: domain
domain: development-standards
relations:
  related:
    - engineering
code:
  paths:
    - AGENTS.md
    - eslint.config.mjs
    - package.json
---

# Development standards

This Domain records requirements that apply across Plugydown packages. `AGENTS.md` is the repository authority;
ESLint and root scripts implement only part of those requirements. Product-specific protocols, role workflows and
acceptance evidence remain in each `package-<name>` Domain.

- `development-standards.coding-and-comments` covers implementation conventions, Chinese TSDoc and safe changes.
- `development-standards.testing-and-validation` covers the verification gates, risk coverage and deterministic output.
- `development-standards.describe-mechanisms-not-rewritten-values` preserves the reusable documentation lesson about
  explaining mechanisms rather than repeating values that routine automation changes.

The distinction from `engineering` is practical: engineering explains the shared workspace and delivery machinery;
this Domain states how contributors must write, verify and describe changes made through that machinery.
