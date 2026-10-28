---
schema: plugydown.context.document/v1
id: package-context.build-and-acceptance
description: Operator gates for six-platform delivery, repeated-build bytes and modes, mapped Git publishing, and separate real-host acceptance.
kind: guide
domain: package-context
relations:
  requires:
    - package-context
  related:
    - package-context.verification-and-gaps
    - package-context.packaging
  supersedes:
    - delivery.build-and-acceptance
code:
  paths:
    - package.json
    - packages/context/package.json
    - packages/context/vitest.config.ts
    - packages/context/delivery.json
    - packages/context/scripts/verify-delivery.ts
    - packages/context/README.md
    - packages/context/host-validation.md
    - AGENTS.md
    - .github/workflows/ci.yml
    - .github/workflows/release.yml
---

# Build and acceptance

How to run the gates. Why they exist, how the published schemas are validated, CI, and verification limits live in
`package-context.verification-and-gaps`. Packaging and the single-builder invariant live in `package-context.packaging`.

Use Node.js 24 or later and the root-pinned pnpm. Install with `pnpm install --frozen-lockfile`.

## The gates

`AGENTS.md` required sequence, in this order:

```
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm validate
pnpm inspect
pnpm verify:delivery
```

`pnpm check` is `lint && typecheck && test && build`. If you use it, still run `validate`, `inspect`, and
`verify:delivery` afterwards.

Root `lint` is `eslint .`. `typecheck`, `test`, `build`, `validate`, `inspect`, and `verify:delivery` fan out with
`pnpm -r --if-present run <name>`. The package `@plugydown/context` supplies `typecheck` (`tsc --noEmit`), `test`
(`vitest run`), `dev`/`build`/`validate`/`inspect` via aaplugin, and the read-only delivery verifier.

| Command | Operator meaning of failure |
|---|---|
| `pnpm lint` | format or lint (`eslint`) |
| `pnpm typecheck` | types (`tsc --noEmit`; it cannot emit) |
| `pnpm test` | a Runtime or delivery assertion failed within the recursive `tests/**/*.test.ts` include |
| `pnpm build` | `aaplugin build` refused the package. It is the only emitter |
| `pnpm validate` | plugin/package shape (`aaplugin validate`) |
| `pnpm inspect` | inspect of the built package (`aaplugin inspect --json`) |
| `pnpm verify:delivery` | a mapped release unit, Runtime/license, role/Skill path, or shipped Runtime response failed verification |

`packages/context/vitest.config.ts` collects nested test files through `tests/**/*.test.ts` and leaves coverage
disabled. Passing tests establish those assertions, not a branch-coverage or real-host acceptance claim.

## Compare consecutive builds

Byte and mode equivalence is an acceptance criterion. Capture the following output after each of two consecutive
`pnpm build` invocations and diff the captures:

```sh
node packages/context/scripts/verify-delivery.ts --snapshot
pnpm --silent --filter @plugydown/context run inspect
```

The snapshot includes relative paths, SHA-256, and modes for all `dist/` files, including hidden directories. The
inspect output covers the report. A mismatch is a product failure. Generated output must not include timestamps,
absolute or temporary paths, environment values, or credentials.

CI runs this for you on pushes to `main` and `dev` and on pull requests, and as the first stage of a release: the gates
up to `validate`, then the repeated-build comparison, then `verify:delivery`. The verifier executes the mapped
Runtime for every Platform with a separate business repository as cwd and requires an absent-Context response.
It also checks Runtime mode `0755`, adjacent licenses, role links and bodies, and schema bytes. Do not substitute
checking only marketplace directories: OpenCode and Pi deliver workspace and package units.

## Publishing

To publish, bump the version in `packages/context/package.json`, merge to `main`, then run the release workflow by hand
(a dry run is available). It reuses CI, selects complete units through `packages/context/delivery.json`, publishes
`release-<platform>` branches, then creates `context--v<version>` and the GitHub Release. Preserve output bytes,
modes, hidden directories, and licenses; do not patch `dist/` to make installation work. The detailed failure and
rerun behavior lives in `package-context.verification-and-gaps`.

## Real-host acceptance

After the automated gates, use `packages/context/README.md` for each host's complete-unit installation and
`packages/context/host-validation.md` for acceptance in a disposable business Git repository. Keep Node 24+ on PATH.
OpenCode merges the `.opencode/` and `schemas/` overlay with existing repository configuration; Pi can install its Git
package ref. Antigravity instructions apply to the CLI.

Record host version and installation source, confirm workflow discovery, resolve the actual Skill/Runtime/index paths,
and send `repository.inspect` from business cwd. Exercise the native Agent or inline role indicated by the index, then
explicitly run Init through candidate, validation, review, approval, and commit. Restart the host to check the Hook
hint, including OpenCode deduplication and Pi's lack of an unsolicited new turn.

For the current confirmation model, exercise explicit legacy migration, source-unavailable recovery in a candidate,
confirmation.check with full pagination, and an Update that confirms accurate prose without editing it. Rebase should
preserve exact input matches and leave a third content combination unmatched. Test discovery for current, legacy and
incomplete Context directories. A business CI adapter must explicitly select its confirmation policy and validate the
new envelope; a plugin upgrade alone does not update that adapter.

The source host-validation checklist records the full real-host matrix as unexecuted. Record only scenarios actually
performed; schema checks, direct Node execution and simulated callbacks do not establish every host lifecycle behavior.
