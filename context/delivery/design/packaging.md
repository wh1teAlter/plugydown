---
schema: plugydown.context.document/v1
id: delivery.packaging
description: The AAPlugin build configuration, how role delivery differs between Claude Code and Codex, the build-enforced closed role set, and the fail-open session-start hook.
kind: architecture
domain: delivery
relations:
  requires:
    - delivery
  related:
    - authority-workflow.roles-and-briefs
code:
  paths:
    - packages/context/aaplugin.config.ts
    - packages/context/package.json
---

# Packaging

## The build configuration

`packages/context/package.json` is the single source of truth for package identity. `aaplugin.config.ts` imports `pkg`
from `./package.json` with `{ type: 'json' }` and forwards seven fields verbatim: `version`, `description`, `license`,
`author`, `homepage`, `repository`, and `keywords`. The Codex block reuses two of them for `developerName` and
`websiteURL`. Only two identity fields are declared in the config itself — `name: 'context'`, because the npm name is
the scoped `@plugydown/context` and a plugin name cannot carry a scope, and `displayName`, which has no npm equivalent.
Platform marketplace `tags`, `capabilities`, and the Codex descriptions are per-platform copy, not duplicates of
`keywords`. The config declares two platforms, one runtime entry, two extensions, and a public asset copy.

Field *values* are deliberately not restated here. Reciting the version would make this document wrong at every release
while the mechanism it describes stayed correct; read `package.json` for the current values.

```
platforms:  claudeCode({...}), codex({...})
runtime:    entries: { context: { entry: 'cli.ts', kind: 'executable' } }
extensions: hooks(), internalRoles()
public:     dir 'public', copy schemas → schemas
build:      outDir 'dist', strict: true
```

Four packages are emitted: a plugin and a marketplace entry for each host.

### The runtime entry key must never be `agents`

The `context` key produces the output path `runtime/context/main.mjs`. A comment in the config states the constraint
directly: the key must never be `agents`, because Codex private role resources are written to `runtime/agents/`. Naming
the runtime entry `agents` would collide the executable directory with the role resource directory. This is a
one-character footgun preserved only by that comment and this record.

## Role delivery differs per host

The same three canonical Markdown role files under `packages/context/src/internal-roles/` reach the two hosts in
different forms, implemented by two platform contributors in `packages/context/extension/internal-roles.ts`.

**Claude Code** receives each role as a **native agent** — `kind: 'native-agent'` with id, description, body, model, and
tools. Compatibility level `native`.

**Codex** has no native agent concept, so each role is emitted as a **private runtime resource** at
`runtime/agents/<id>.md`, with a small front-matter header (`id`, `description`, `delivery: private-runtime-resource`,
`model`, `tools`) prepended to the canonical body. Compatibility level `transform`, transformation
`private-runtime-resource`.

The behavioural consequence is documented in `SKILL.md`: on Claude Code prefer the native role agent; on Codex read the
matching private `runtime/agents/<role>.md` resource and execute the same Brief inline. Same authority model, two delivery
mechanisms.

Codex also receives the three commands as explicit skills that must be invoked deliberately rather than inferred by the
model. That transformation and the flag implementing it are owned by `@aaplugin/platform-codex` and are not declared
anywhere in this repository — consistent with `delivery.ownership-boundary`, under which command and skill conversion
belongs to the Platform.

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
check is effectively on the sorted set. Per-role tool grants are static in the same file: Investigator gets
Read/Glob/Grep/Bash, Recorder gets Read/Glob/Grep/Write/Edit, Reflector gets Read/Glob/Grep/Write. Recorder is the only
role with `Edit`; Investigator is the only one with `Bash`. Investigator and Recorder use model `capable`, Reflector
inherits.

## The session-start hook

`packages/context/src/hooks/session-start/hook.ts` is deliberately almost nothing:

- reads only `input.cwd`
- `lstat`s `<cwd>/context/meta.json`
- returns `{decision: 'continue'}` **always**
- adds `additionalContext` only when that path is a regular file

It performs no writes, spawns nothing, and swallows every error. The comment states the design: SessionStart is fail-open,
and absence or inspection errors must not affect the host session. Its own doc comment calls it a best-effort discovery
hint and defers authority to Runtime inspection.

So the hook is a hint, not a source of truth. The `additionalContext` string it injects tells the assistant to load the
skill and call `repository.inspect` — it never asserts that Context is usable. A `meta.json` that exists but is invalid
still produces the hint, and `repository.inspect` is what discovers the problem.

## Public schemas

`public/schemas/` is copied verbatim into the artifact: `document.schema.json`, `meta.schema.json`, and
`runtime.schema.json`. The first two mirror the implementation faithfully. The third has drifted and is validated by
nothing; see `delivery.verification-and-gaps`.
