---
schema: plugydown.context.document/v1
id: development-standards.testing-and-validation
description: Shared validation sequence, risk-based failure and recovery coverage, offline/model-free tests, deterministic artifacts and the separation of automated checks from actual host acceptance.
kind: guide
domain: development-standards
relations:
  requires:
    - development-standards
  related:
    - engineering.workspace-and-delivery
    - package-context.verification-and-gaps
code:
  paths:
    - AGENTS.md
    - package.json
    - .github/workflows/ci.yml
---

# Testing and validation

Run the repository gates:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm validate
pnpm inspect
pnpm verify:delivery
```

`pnpm check` covers only the first four. Type checking must not emit delivery bytes; the build path is AAPlugin.
Recursive scripts skip missing package scripts, so package onboarding must explicitly provide the applicable checks.

## Test risks, not just happy paths

Add tests according to feature risk. The repository names transaction failures and fault injection, recovery outcomes,
concurrent access, path-safety refusals, and cursor returns on budget exhaustion as required high-risk coverage.
For a transactional product, distinguish completed candidate, restored original and inability to identify a trusted
copy; preserve conflicting copies when recovery cannot choose safely. Do not replace missing fixtures with broad skips.

Routine tests and CI are offline and invoke no models. Tests must not depend on ambient time, randomness, machine paths
or environment values. Isolated temporary fixtures and fixed inputs may exercise these boundaries without letting the
machine's ambient state determine expected behavior. A pass establishes the assertions executed, not unmeasured coverage.

## Deterministic delivery

Generated files and reports must not contain timestamps, absolute or temporary paths, environment values or credentials.
Compare two consecutive builds for artifact bytes and reports; preserve hidden directories, permissions and licenses.
AAPlugin dependencies are exact catalog versions because silently changing the builder would invalidate byte-equivalence
assumptions. Package-specific snapshot and delivery implementations belong in the package Domain.

## Report only executed evidence

Distinguish automated schema/layout checks, execution of a built Node Runtime, simulated host callbacks and actual host
sessions. None substitutes for the next. Record unsupported or unexecuted host behavior explicitly; tool/model
preferences must not be described as enforced Runtime permissions. For Context's actual acceptance procedures and
current gaps, use `package-context.build-and-acceptance` and `package-context.verification-and-gaps`.
