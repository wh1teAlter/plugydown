---
schema: plugydown.context.document/v1
id: knowledge-model.meta-ledger
description: The context/meta.json validity ledger, the three fingerprint kinds it records, the two optional baselines, and how formalState, sourceState, and metaState combine into readiness.
kind: architecture
domain: knowledge-model
relations:
  requires:
    - knowledge-model
    - knowledge-model.document-grammar
  related:
    - runtime-protocol.determinism
code:
  paths:
    - packages/context/src/runtime/document.ts
    - packages/context/public/schemas/document.schema.json
    - packages/context/public/schemas/meta.schema.json
---

# Meta ledger

`context/meta.json` is the machine-written record of what the Runtime last proved about the tree. It is derived during
`transaction.validate` by `deriveMeta` in `transaction.ts`, serialized by `serializeMeta`, and re-parsed strictly by
`parseMeta` in `document.ts`. It is never hand-written.

## Shape

```json
{
  "$schema": "plugydown.context.meta/v1",
  "toolVersion": "0.1.0",
  "runtimeProtocol": "plugydown.context.runtime/v1",
  "fingerprintVersion": "1",
  "documents": { "<document-id>": { "frontMatterFingerprint": "…", "bodyFingerprint": "…", "sourceFingerprint": "…" } },
  "repository": { "baseline": { "revision": "<git-rev>", "sourceFingerprint": "…" } },
  "convergence": {
    "source": "init|prune",
    "documentCount": 0,
    "frontMatterBytes": 0,
    "bodyBytes": 0,
    "estimatedTokens": 0,
    "perDomain": { "<domain-id>": { "documentCount": 0, "frontMatterBytes": 0, "bodyBytes": 0, "estimatedTokens": 0 } }
  }
}
```

The first five keys are required; `repository` and `convergence` are optional. Every entry in `documents` must carry
exactly the three fingerprint keys, each 64 lowercase hex. Parsing is exact-key throughout: an unknown field anywhere is
an issue, and partial shapes are rejected rather than repaired.

`fingerprintVersion` is `'1'` and `toolVersion` is `'0.1.0'`, both constants in `document.ts`. Changing how any
fingerprint is computed requires bumping `fingerprintVersion`, otherwise every existing ledger silently becomes wrong
rather than visibly stale. `toolVersion` is `TOOL_VERSION` in `document.ts`, not the npm package version.

## The three fingerprint kinds

| Kind | Covers | Changes when |
|---|---|---|
| `frontMatterFingerprint` | canonical projection of the closed field set | id, description, kind, domain, relations, or code.paths change |
| `bodyFingerprint` | normalized body text | prose changes |
| `sourceFingerprint` | sorted declarations + each matched file's path and content hash | declared source files change content, appear, or disappear |

The split is what makes staleness attributable. A body edit does not look like a source drift, and a source drift does
not look like an editorial change.

## Two baselines, two purposes

`repository.baseline` records the Git revision and aggregate source fingerprint at the last point the Runtime could
honestly claim the whole repository was accounted for. `deriveMeta` advances it only for `init`, or for `update` when
*all* of these hold: repository scope, no Git mid-operation, every changed path maps to some Document's declarations, and
history is complete — meaning no previous baseline exists at all, or the previous baseline equals HEAD, or a diff was
supplied. A scoped update therefore leaves
the baseline alone — claiming repository-wide freshness from a partial look would be a lie, and `delta.compute` reads
this field to decide Light eligibility.

`convergence` is a size baseline written only by `init` and `prune`. `growth.measure` subtracts it from current metrics
to show drift since the last deliberate convergence. An `update` never touches it, so growth is measured against
intentional shape, not against yesterday.

## Readiness is three independent axes

`loadKnowledge` in `graph.ts` returns a `KnowledgeGraph` with three separate states. Conflating them is the most common
way to misread this system.

- **`formalState`**: `absent` | `ready` | `invalid`. Covers Markdown structure, placement, relations, and — when Meta is
  required — Meta validity and agreement. `ready` requires zero formal issues.
- **`sourceState`**: `unchecked` | `ready` | `degraded`. `unchecked` means the capability did not ask for source
  expansion at all; `degraded` means expansion produced at least one issue. Only computed when `formalState` is already
  `ready`, so an invalid tree always reports `unchecked` — absence of source complaints there means nothing.
- **`metaState`**: `absent` | `valid` | `invalid`.

Capabilities choose a source policy: `formal-only`, `selected`, `all-strict`, or `all-tolerant`. `graph.validate` demands
`all-strict` and both `formalState` and `sourceState` ready; most reads use `formal-only` and never look at source at all.

## Meta must agree with the tree

When Meta is required, `loadKnowledge` cross-checks:

- the Meta id set must exactly equal the Markdown id set (`META_DOCUMENT_SET_MISMATCH`)
- for every id, recomputed front-matter and body fingerprints must equal the recorded ones
  (`META_DOCUMENT_FINGERPRINT_MISMATCH`)

Source fingerprints are deliberately *not* checked here — they need filesystem expansion, so only `graph.validate`
compares them (`META_SOURCE_FINGERPRINT_MISMATCH`). A tree can be `formalState: ready` while its source ledger is stale.
That is a real, reachable state and it is why `graph.validate` exists as a separate capability rather than being folded
into loading.

## Effect of the glob-expansion limitation on this Context

Exact `code.paths` under `packages/context/` expand and produce a non-empty `sourceFingerprint`. Globs whose first
segment is `packages` still cannot expand in this working tree (see `repository-access.path-and-glob-safety`), so
Documents must declare exact files rather than `packages/context/**` if they want `delta.compute` to map those files.
Empty declarations still expand cleanly and `graph.validate` still passes; they just map nothing.
