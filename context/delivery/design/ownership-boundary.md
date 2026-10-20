---
schema: plugydown.context.document/v1
id: delivery.ownership-boundary
description: The AGENTS.md constitution — what AAPlugin owns versus what this repository supplies, the eight explicit prohibitions, the framework capability-gap procedure, and the recorded tool decisions.
kind: decision
domain: delivery
relations:
  requires:
    - delivery
  related:
    - delivery.packaging
    - delivery.verification-and-gaps
code:
  paths:
    - AGENTS.md
    - packages/context/delivery.json
    - packages/context/extension/internal-roles.ts
    - packages/context/vitest.config.ts
    - packages/context/src/runtime/repository.ts
---

# Ownership boundary

`AGENTS.md` at the repository root is the engineering constitution. It is the document that establishes byte-equivalence
as an acceptance criterion, mandates the exact-version dependency policy, and draws the line between this repository and
the framework beneath it. The product's role Extension and delivery map apply that boundary to all six hosts.

## The framing that explains the rest

> Subpackages are **products**, not frameworks; framework capability belongs to upstream AAPlugin.

Almost every prohibition in this Document follows from that one sentence. When a build limitation appears, the tempting
fix is to reach around the framework — post-process the output, write the manifest yourself, patch the builder. Each of
those converts a product into a second, undocumented framework, and the constitution forbids all of them by name.

## Who owns what

| Layer | Owner | This repository's right |
|---|---|---|
| Build lifecycle, diagnostics, transactions | AAPlugin Core | supply inputs only |
| Command / Skill discovery and conversion | Core + Platform | supply canonical source files |
| Runtime compilation and delivery | Core | supply `src/runtime/` and the entry declaration |
| Host manifests, paths, naming | each Platform | **must not write directly** |
| Hook wire and handler packaging | official Hooks Extension | supply `src/hooks/<id>/hook.ts` |

Read this table alongside `delivery.packaging`. It explains why the role Extension contributes *components and assets*
rather than writing files into `dist/`, why command conversion is Platform-owned, and why the session-start hook is a
bare handler module with no wire protocol around it. The product can supply host-specific Contributor input and its
own assets through the public SDK; each Platform owns final rendering and manifest registration.

The Internal Roles Extension keeps one canonical body per role and supplies a Contributor for every selected Platform.
Native role components go to Claude Code, Cursor, and OpenCode; Codex, Antigravity CLI, and Pi receive private Markdown
resources. The Extension also owns the invocation index that lets the shared Skill locate the appropriate form.
Missing role delivery fails the strict build instead of silently dropping the capability.

Host tool and model configuration is distinct from product authority. OpenCode's tool settings do not confine bash
network access or writes to a candidate path; Cursor and private-role model/tool preferences are guidance. The Brief,
Recorder/Investigator separation, and Main Assistant approval remain the authority boundary, not a Runtime-enforced
filesystem or model sandbox.

## The eight prohibitions

1. Post-processing `dist` — no rename, copy, patch, or delete after the build.
2. Writing a Platform-owned manifest directly.
3. Creating a second renderer or a second builder.
4. Copying TypeScript file-by-file, or hand-rolling a Runtime compiler.
5. Building a compatibility layer for the legacy ACPlugin API.
6. Modifying AAPlugin to serve subpackage-specific logic.
7. Delivering platform-specific resources through Public copy — Public copies to *every* platform, so it cannot carry
anything platform-specific.
8. Using wide skips for missing fixtures in place of actual verification.

Prohibition 7 is the non-obvious one and it constrains real decisions: `public/` in `aaplugin.config.ts` carries the three
JSON Schemas precisely because they are platform-neutral. Anything platform-specific must go through a Platform
Contributor instead, which is how the invocation index and private role resources are delivered.

Prohibition 1 also applies to release: `packages/context/delivery.json` selects a complete AAPlugin output unit, and
publication must preserve it rather than repair its contents. Prohibition 8 requires executable evidence for the risks
being tested; recursive test collection and disabled coverage do not establish untested host behavior.

## When the framework cannot do what you need

The constitution prescribes a five-step procedure rather than leaving it to judgment:

1. First prove the project side cannot solve it cleanly — exhaust the Extension, Contributor, Public, and Runtime
   combinations.
2. Record the finding as a standalone framework investigation under `.scratch/investigations/`.
3. Do **not** disguise a fix inside the subpackage. No monkey-patching, no build post-processing, no private fork.
4. Raise an upstream AAPlugin issue only when the gap is general and worth generalizing.
5. If a capability cannot ship before the gap closes, **declare the degradation explicitly**. Silent omission is
   forbidden.

Step 5's spirit — declare a degradation rather than silently omit it — is the same discipline this Context applies to
limits of the product's own Runtime. Such a limit is a property of this product, not of the framework, so the procedure
is an analogy rather than a compliance relationship. Glob expansion under `packages/` is not currently one of them:
`expandGlob` in `packages/context/src/runtime/repository.ts` prunes its walk to the directories a pattern can still
match and never enters `node_modules`, so `packages/foo/src/**` expands in this working tree. See
`repository-access.path-and-glob-safety`.

Step 2 is worth noting for a different reason: `.scratch/investigations/` is load-bearing in this procedure, and it is the
one scratch collection with **zero Runtime representation**. See `authority-workflow.scratch-lifecycle`.

## Recorded tool decisions

These are decisions with stated reasons, not gaps:

- **No Turborepo.** pnpm workspace plus catalog is the whole build orchestration.
- **No Changesets** — there is currently no npm publish pipeline for it to drive. Recording this matters: the absence of
  version-bump and npm publishing tooling in `delivery.verification-and-gaps` is a consequence of this decision, not an
  oversight.
- **No npm or yarn.**
- `tsc` is for `--noEmit` type checking only and **must not produce any delivered bytes**.
- The build has exactly one path: `aaplugin build`.
- Final product dependencies must not use `file:`, a `workspace:` pointing outside the repository, or a Git SHA or URL.

## Determinism and test obligations

Two requirements from `AGENTS.md` that other Domains lean on:

- **Output determinism.** Generated files and reports must contain no timestamps, absolute paths, temporary paths,
  environment values, or credentials, and two consecutive builds must produce identical artifact bytes and reports. This
  is the source of the acceptance criterion cited in `runtime-protocol.determinism` and of the dependency policy's whole
  justification.
- **Risk-based testing.** New features must add tests by risk, and five areas are named as must-cover: transaction failure
  paths with fault injection, all three recovery outcomes, concurrency checks, path-safety refusals, and budget-overflow
  cursor returns. Routine CI must be offline and must invoke no model; tests must not depend on time, randomness, machine
  paths, or environment variables.

The concurrency obligation is worth comparing against reality: `write-plane` records that concurrency is tested only via
hand-written rival lock files, never two real processes. That is a partial satisfaction of a named must-cover area.

## Git and change safety

- Conventional Commits for messages.
- Preserve the user's existing staged and unstaged modifications; never overwrite with `reset`, `checkout`, or `clean`.
- `.scratch/` and `packages/*/dist/` stay out of version control.
