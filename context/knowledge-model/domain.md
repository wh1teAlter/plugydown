---
schema: plugydown.context.document/v1
id: knowledge-model
description: The formal Document and Meta grammar — front-matter parsing, canonical two-level placement, relation validation, the three fingerprint kinds, and the three-axis readiness state.
kind: domain
domain: knowledge-model
relations:
  related:
    - runtime-protocol.determinism
code:
  paths:
    - packages/context/src/runtime/document.ts
---

# Knowledge model

Formal repository knowledge is Markdown with YAML front matter under `context/`, plus one machine-written validity
ledger at `context/meta.json`. Nothing else counts as formal knowledge. Implemented in
`packages/context/src/runtime/document.ts` (parsing, fingerprints, Meta) and `graph.ts` (loading, cross-Document
validation, readiness). Published JSON Schemas live at `packages/context/public/schemas/document.schema.json` and
`meta.schema.json`.

## Why this Domain exists

Every other Domain depends on being able to say "this tree is ready" with a single word. `read-plane` refuses to answer
from an unready tree; `write-plane` refuses to commit one. That word has to mean something precise, and this Domain is
where the precision lives.

## What lives here

- `knowledge-model.document-grammar` — the closed front-matter field set, placement rules, and relation validation.
- `knowledge-model.meta-ledger` — the Meta file, the three fingerprint kinds, and the three readiness axes.

## The shape in one glance

```
context/<domain-id>/domain.md                  kind: domain,       id == <domain-id>
context/<domain-id>/design/<name>.md           kind: architecture | decision
context/<domain-id>/manual/<name>.md           kind: guide | reference
context/<domain-id>/reflections/<name>.md      kind: reflection
context/meta.json                              machine-written ledger
```

Exactly two levels. The Domain root may hold only `domain.md`. Category directory names are exactly `design`, `manual`,
`reflections` — no others, and an empty one is an error.

## Invariants

- A Domain without a valid `domain.md` is invalid (`DOMAIN_DOCUMENT_MISSING`). A Context with zero Domains is invalid
  (`DOMAIN_MISSING`). There is no such thing as a partially initialized Context.
- Every non-Domain Document id must begin with `<domain-id>.`. Physical location and logical identity cannot drift.
- Document ids are globally unique across the whole tree, not per-Domain (`DOCUMENT_ID_DUPLICATE`).
- Symlinks anywhere in the tree are refused, not followed (`KNOWLEDGE_SYMLINK`). Same for non-regular files.
- `meta.json` is derived by the Runtime during `transaction.validate`. A human or a role must never hand-write it; the
  Runtime overwrites it and then re-proves the result.

## Self-hosting limitation

`code.paths` may name this product's source as exact files under `packages/context/`. `.git`, `.scratch`, and `context`
are forbidden only as the first segment; nested names such as `packages/context/src/runtime/document.ts` are legal.
Globs anchored at `packages` still fail to expand because `listAnchorFiles` walks into pnpm `node_modules` symlinks and
hits `PATH_SYMLINK`. See `repository-access.path-and-glob-safety` for the mechanism and `knowledge-model.meta-ledger`
for the remaining glob-expansion cost.
