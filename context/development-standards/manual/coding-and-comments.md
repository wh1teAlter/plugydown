---
schema: plugydown.context.document/v1
id: development-standards.coding-and-comments
description: Repository-wide ESM and formatting conventions, the required Chinese TSDoc and business-variable comments, and preservation of user changes under Conventional Commits.
kind: guide
domain: development-standards
relations:
  requires:
    - development-standards
  related:
    - engineering.aaplugin-boundaries
    - development-standards.testing-and-validation
    - development-standards.describe-mechanisms-not-rewritten-values
code:
  paths:
    - AGENTS.md
    - eslint.config.mjs
    - package.json
    - pnpm-workspace.yaml
    - tsconfig.base.json
---

# Coding and comments

## Code and tooling

Use Node.js 24+ and ESM. Use pnpm workspace/catalog, `@antfu/eslint-config` for lint and formatting, Vitest for tests,
and `tsc --noEmit` for type checks. The root ESLint configuration selects single quotes and no semicolons, disables
additional formatters and excludes Markdown, TOML, YAML, scratch, dependencies and generated `dist/`.

The shared `tsconfig.base.json` uses NodeNext module resolution, strict checking, exact optional property types,
unchecked-index protection, isolated modules and verbatim module syntax. Its noEmit setting keeps type checking out of
delivery generation; package configurations extend the base and select their own source/test inputs.

Do not introduce another builder, Runtime compiler, Turborepo or Changesets. AAPlugin owns delivery rendering;
`engineering.aaplugin-boundaries` records the complete prohibitions and the framework-gap procedure.

## Chinese comment contract

The requirements apply to source, scripts, configuration code and test helpers:

- Place Chinese TSDoc before function, method, class, interface, type-alias and enum declarations.
- For public APIs, explain parameters, return values, failure behavior and the calling lifecycle stage. Use parameter
  and return tags where appropriate; a void/never API must still explain that return contract. Internal implementations
  may use one concise line explaining purpose or side effects.
- Document module constants/state and class fields before their declarations. Explain type fields whose units, owner
  or lifecycle are not otherwise clear; distinguish bytes from characters, current evidence from recorded review, and
  temporary ownership from persistent state.
- Add Chinese single-line comments for local variables with independent business meaning. Loop variables, catch
  bindings, simple indices, obvious test actual/expected values and purely syntactic destructuring may be omitted.
- Explain the actual implementation. Do not describe a preference as enforced permission, a successful request as
  successful validation, or source availability as completed semantic review.

Lint passing is not proof that the full prose contract was reviewed. Avoid repeating an identifier in different words;
retain the reason, boundary, unit or lifecycle fact that a reader cannot infer reliably from syntax alone.

For comment-only work, preserve code behavior and test fixtures. Comparing non-comment syntax can detect accidental
edits; it complements type checking and the applicable repository verification gates.

## Change safety

Use Conventional Commits. Preserve existing staged and unstaged user changes; do not overwrite them with `reset`,
`checkout` or `clean`. Keep `.scratch/` and `packages/*/dist/` out of version control. Do not modify generated output to
make a test or installation pass.
