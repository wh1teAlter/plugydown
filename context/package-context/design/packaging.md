---
schema: plugydown.context.document/v1
id: package-context.packaging
description: The strict six-platform build, mapped release units, shared Runtime and role index, native versus inline role delivery, and the fail-open session-start hook.
kind: architecture
domain: package-context
relations:
  requires:
    - package-context
  related:
    - package-context.roles-and-briefs
  supersedes:
    - delivery.packaging
code:
  paths:
    - packages/context/aaplugin.config.ts
    - packages/context/package.json
    - packages/context/delivery.json
    - packages/context/host-validation.md
    - packages/context/extension/internal-roles.ts
    - packages/context/src/skills/context/SKILL.md
    - packages/context/src/hooks/session-start/hook.ts
    - packages/context/scripts/verify-delivery.ts
    - .github/workflows/release.yml
---

# Packaging

## The build configuration

`packages/context/package.json` is the single source of truth for package identity. `aaplugin.config.ts` imports `pkg`
from `./package.json` with `{ type: 'json' }` and forwards seven fields verbatim: `version`, `description`, `license`,
`author`, `homepage`, `repository`, and `keywords`. The Codex block reuses two of them for `developerName` and
`websiteURL`. Only two identity fields are declared in the config itself — `name: 'context'`, because the npm name is
the scoped `@plugydown/context` and a plugin name cannot carry a scope, and `displayName`, which has no npm equivalent.
Platform marketplace `tags`, `capabilities`, and the Codex descriptions are per-platform copy, not duplicates of
`keywords`. The config selects all six Platforms, an explicit Runtime entry, Hooks and Internal Roles Extensions, and
platform-neutral public schemas.

Field *values* are deliberately not restated here. Reciting the version would make this document wrong at every release
while the mechanism it describes stayed correct; read `package.json` for the current values.

```
platforms:  claudeCode({...}), codex({...}), cursor(), antigravity(), openCode(), pi()
runtime:    entries: { context: { entry: 'cli.ts', kind: 'executable' } }
extensions: hooks(), internalRoles()
public:     dir 'public', copy schemas → schemas
build:      outDir 'dist', strict: true
```

Release and acceptance select units through `packages/context/delivery.json`:

| Platform | Unit | Internal roles |
|---|---|---|
| Claude Code | marketplace | native Agent |
| Codex | marketplace | private Markdown, inline |
| Cursor | plugin | native Agent |
| Antigravity CLI | plugin | private Markdown, inline |
| OpenCode | workspace | native Subagent |
| Pi | package | private Markdown, inline |

The mapping chooses a complete built unit for `release-<platform>`. Publication preserves its bytes, modes, hidden
directories, and licenses. OpenCode's unit is a business-repository overlay; Pi's generated package is installed from
Git, without an npm product release.

### One explicit Runtime entry

`runtime.entries.context` names `cli.ts` as the sole executable. Keep the declaration explicit: the other top-level
files in `src/runtime/` are helpers, not automatic executables. Core owns compilation and delivery; the product never
copies TypeScript or rearranges built files. The entry key must never be `agents`, which is reserved for the role index
and private resources.

The executable is `runtime/context/main.mjs`, except that OpenCode places the content under `.opencode/runtime/`.
Each discovered Skill resolves the same relative `../../runtime/context/main.mjs` and sibling
`../../runtime/agents/index.md`. The shipped executable keeps mode `0755` and the adjacent
`THIRD_PARTY_LICENSES.txt`; verification compares Runtime and license bytes across all Platforms. Node 24+ remains the
product requirement even when a host's generated manifest does not declare it.

## Role delivery differs per host

The canonical Markdown bodies under `packages/context/src/internal-roles/` are shared by all hosts. One Extension in
`packages/context/extension/internal-roles.ts` discovers and validates them, then contributes native components or
private assets through an explicit Contributor for each Platform.

**Claude Code, Cursor, and OpenCode** receive native role components with compatibility `native`. Claude Code receives
model and tool metadata. Cursor receives name, description, and body; model and tool preferences remain invocation
guidance. OpenCode receives a native Subagent with read/glob/grep enabled, bash for Investigator, edit for Recorder and
Reflector, and webfetch/task disabled. It uses the default model.

**Codex, Antigravity CLI, and Pi** use this product's private resources at `runtime/agents/<id>.md`. A front-matter
header supplies id, description, delivery marker, model preference, and tool names before the canonical body.
Compatibility is `transform` with transformation `private-runtime-resource`. Internal Roles do not become public
Skills on these hosts.

Every Contributor generates `runtime/agents/index.md`, under `.opencode/` for OpenCode. The canonical Skill reads this
index instead of carrying platform branches. Native links are `../../agents/<id>.md` relative to the index; inline
links are `./<id>.md`. Inline execution must switch explicitly between Recorder authorship and Investigator review and
must not be presented as an independently executed Agent.

Model preferences unsupported by the host are guidance. OpenCode's native tool configuration does not isolate the
network or candidate directory: bash can still write or access the network, and edit can touch other paths. Private
delivery configures no independent model or tool restrictions. The Role Brief governs allowed writes, Recorder cannot
approve its own work, and the Main Assistant retains final approval on every host.

Command conversion remains Platform-owned: Claude Code, Cursor, and OpenCode expose native commands; Codex exposes
`context-init` and its companion Skills, Antigravity CLI exposes `command-init` and its companion Skills, and Pi
exposes Prompts. These user workflows are distinct from the private Internal Roles.

## The role set is closed and build-enforced

`ROLE_METADATA` is a frozen list of exactly three entries. Discovery maps filenames to that metadata and **throws** on any
unrecognized file — an extra Markdown file under `src/internal-roles/` fails the build rather than being ignored. It also
throws on a non-file entry and on an empty body.

Validation adds two diagnostics:

| Code | Condition |
|---|---|
| `CONTEXT_ROLE_SET_INVALID` | the discovered id sequence does not exactly equal `investigator, recorder, reflector` |
| `CONTEXT_ROLE_AGENT_COLLISION` | a role id collides with a canonical Agent of the same id |

The comparison is order-sensitive (`actual.join('\0') !== expected.join('\0')`), and discovery sorts by id first, so the
check is effectively on the sorted set. Per-role tool metadata is static in the same file: Investigator lists
Read/Glob/Grep/Bash, Recorder lists Read/Glob/Grep/Write/Edit, Reflector lists Read/Glob/Grep/Write. Recorder is the only
role with `Edit`; Investigator is the only one with `Bash`. Investigator and Recorder prefer model `capable`, Reflector
inherits. Actual host enforcement follows the distinctions above.

Each role declares a `role-delivery` capability subject. A selected Platform without a compatible Contributor reports
`unsupported` and fails the strict build rather than silently omitting roles.

## The session-start hook

`packages/context/src/hooks/session-start/hook.ts` is deliberately almost nothing:

- reads only `input.cwd`
- `lstat`s `<cwd>/context`
- returns `{decision: 'continue'}` **always**
- adds `additionalContext` when that path is a directory or symlink, leaving validity to Runtime

It performs no writes, spawns nothing, and swallows every error. The comment states the design: SessionStart is fail-open,
and absence or inspection errors must not affect the host session. Its own doc comment calls it a best-effort discovery
hint and defers authority to Runtime inspection.

So the hook is a hint, not a source of truth. The `additionalContext` string it injects tells the assistant to load the
skill and call `repository.inspect` — it never asserts that Context is usable. Current-layout, legacy and incomplete directories all produce a discovery hint. A linked Context also prompts
inspection, which rejects the unsafe path; the hook itself never claims that the directory is usable.

## Public schemas

`public/schemas/` is copied verbatim into the artifact: `document.schema.json`, `meta.schema.json`, `confirmation.schema.json`, and
`runtime.schema.json`. All four are held to the implementation by the test suite; see `package-context.verification-and-gaps`.
The mapped complete delivery unit reaches installers through the hand-started Git release workflow described there.
