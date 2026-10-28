---
schema: plugydown.context.document/v1
id: engineering.aaplugin-boundaries
description: Shared AAPlugin ownership boundaries, prohibited workarounds and the framework investigation procedure, distinct from package-specific Runtime behavior.
kind: decision
domain: engineering
relations:
  requires:
    - engineering
  related:
    - engineering.workspace-and-delivery
    - development-standards
    - package-context.packaging
  supersedes:
    - delivery.ownership-boundary
code:
  paths:
    - AGENTS.md
    - package.json
    - pnpm-workspace.yaml
---

# AAPlugin ownership boundaries

`AGENTS.md` is the shared engineering authority: each subpackage is a product, while framework capability belongs to
upstream AAPlugin. The boundary applies to future packages as well as Context.

## Ownership

| Layer | Owner | Plugydown supplies |
|---|---|---|
| Build lifecycle, diagnostics and build transactions | AAPlugin Core | inputs only |
| Command/Skill discovery and conversion | Core + Platform | canonical sources |
| Runtime compilation and delivery | Core | src/runtime and explicit entry declarations |
| Host manifests, paths and naming | Platform | public Contributor inputs, never direct manifest writes |
| Hook wire and handler packaging | official Hooks Extension | src/hooks/<id>/hook.ts |

A package may implement its own business Runtime and public Extensions; that does not transfer ownership of the
builder, renderer or host manifests. Context's knowledge transaction is product logic and is distinct from AAPlugin's
build transaction. `package-context.packaging` shows the public Contributor pattern in use.

## Prohibited workarounds

1. No post-build rename, copy, patch or deletion inside dist.
2. No direct writes to Platform-owned manifests.
3. No second renderer or builder.
4. No file-by-file TypeScript delivery or custom Runtime compiler.
5. No legacy ACPlugin compatibility layer.
6. No AAPlugin modification for package-specific business logic.
7. No platform-specific resources through Public copy, which copies to every Platform.
8. No broad test skips in place of missing fixtures.

Platform-neutral schemas may use Public. Host-specific resources require appropriate Contributor inputs. Release must
select complete AAPlugin output units and preserve hidden directories, permissions and licenses instead of repairing
output after the build. Missing required delivery must fail strict validation or be explicitly declared degraded.

## Framework capability gaps

First exhaust clean Extension, Contributor, Public and Runtime combinations. Record an independent investigation in
`.scratch/investigations/`; never hide the gap with monkey-patching, post-processing or a private fork. Raise an upstream
issue only for a general, worthwhile framework capability. Until it is resolved, explicitly state any unavailable
capability rather than silently omitting it.

A product Runtime defect belongs to that package unless evidence establishes a framework gap. Product-specific
filesystem and maintenance rules belong in its package Domain. Context's rules are documented under
`package-context.path-and-glob-safety` and `package-context.scratch-lifecycle`, not imposed on every package Runtime.

## Related repository requirements

Use pnpm workspace/catalog and the sole aaplugin build path; tsc is no-emit only. AAPlugin versions must be exact, and
final product dependencies cannot use file:, outside-repository workspace:, or Git SHA/URL sources. Turborepo and
Changesets are explicitly excluded; the latter has no npm publishing pipeline to drive. Details belong to
`engineering.workspace-and-delivery`.

`development-standards` owns Chinese TSDoc, risk-based testing, deterministic output and Git change safety. Host tool or
model preferences must never be presented as Runtime-enforced permissions. Actual host sessions must remain unverified
until executed; automated checks do not establish host behavior.
