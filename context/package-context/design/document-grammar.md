---
schema: plugydown.context.document/v1
id: package-context.document-grammar
description: The closed front-matter field set, front-matter and body size limits, canonical placement enforcement, and the relation rules including dangling-target and requires-cycle detection.
kind: architecture
domain: package-context
relations:
  requires:
    - package-context
  supersedes:
    - knowledge-model.document-grammar
code:
  paths:
    - packages/context/src/runtime/document.ts
    - packages/context/src/runtime/graph.ts
    - packages/context/public/schemas/document.schema.json
---

# Document grammar

## The front matter is a closed set

Front matter is YAML between `---` fences at the very start of the file (a leading BOM is tolerated, CRLF is tolerated).
The regex in `packages/context/src/runtime/document.ts` requires the opening fence to be the first thing in the file, so
a Document with a title line above the fence is `DOCUMENT_FRONT_MATTER_MISSING`.

| Field | Required | Rule |
|---|---|---|
| `schema` | yes | exactly `plugydown.context.document/v1` |
| `id` | yes | dotted lowercase kebab-case |
| `description` | yes | non-empty after trim; stored trimmed |
| `kind` | yes | `domain` \| `architecture` \| `decision` \| `guide` \| `reference` \| `reflection` |
| `domain` | yes | lowercase kebab-case, must equal the physical Domain directory |
| `relations` | no | non-empty object; only `requires`, `related`, `supersedes` |
| `code` | no | object with exactly one key, `paths` |

Any other key is `DOCUMENT_FIELD_UNKNOWN`. There is no extension point. The body must be non-empty after trim
(`DOCUMENT_BODY_EMPTY`).

Note the asymmetry on relation lists: each of `requires`, `related`, `supersedes` must be a **non-empty** array of
unique, valid Document ids if present. An empty list is an error, not a no-op — write nothing instead. Likewise a
`relations:` key with no sub-keys is `DOCUMENT_RELATIONS_INVALID`.

Parsing accumulates issues rather than stopping at the first, so one malformed Document reports everything wrong with it
at once. Five conditions short-circuit with a single issue because nothing further can be trusted: over-size file, missing
front matter, front matter over its 64 KiB limit, unparseable YAML, and YAML that parses but is not an object.

## Size limits

- whole Markdown file: 1 MiB (`DOCUMENT_SIZE_EXCEEDED`)
- front-matter block: 64 KiB (`DOCUMENT_FRONT_MATTER_SIZE_EXCEEDED`)

## Placement is enforced, not conventional

`placementIssues` derives the expected shape from the physical path:

- 3 path segments (`context/<domain>/domain.md`) — the filename must be exactly `domain.md`, kind must be `domain`, and
  `id` must equal the Domain id. Anything else in the Domain root is `DOCUMENT_PLACEMENT_INVALID`.
- 4 path segments — the category directory decides the allowed kinds: `design` → `architecture` or `decision`,
  `manual` → `guide` or `reference`, `reflections` → `reflection`. The id must start with `<domain-id>.`
  (`DOCUMENT_ID_DOMAIN_MISMATCH`).
- any other depth — `DOCUMENT_PLACEMENT_INVALID`.

Filenames must match `^[a-z0-9]+(-[a-z0-9]+)*\.md$`. No underscores, no uppercase, no dots beyond the extension.

Directory scanning in `graph.ts` adds the structural rules: unknown entries in the Context root, unknown directories
inside a Domain, non-`.md` files inside a category, and empty category directories
(`DOCUMENT_CATEGORY_EMPTY`) are all issues. Symlinks are reported as `KNOWLEDGE_SYMLINK` rather than followed, except a
`domain.md` that is not a regular file, which is `DOCUMENT_NOT_REGULAR_FILE`.

## Relations

Validated across the whole loaded graph in `graph.ts`:

- **self-reference** in any relation kind → `DOCUMENT_RELATION_SELF`
- **dangling target** in `requires` or `related` → `DOCUMENT_RELATION_DANGLING`. `supersedes` is deliberately exempt: it
  points at knowledge that has been removed, so requiring the target to exist would make superseding impossible.
- **requires cycle** → `DOCUMENT_REQUIRES_CYCLE`, reported for every member of the cycle, not just the entry point.
  Detection is a colour-marking DFS over ids sorted by code unit, so the reported set is deterministic.
- `domain` naming a Domain directory that does not exist → `DOCUMENT_DOMAIN_UNKNOWN`

`related` may form cycles freely. Only `requires` must be acyclic, because it is a prerequisite ordering: a cycle would
leave no Document a reader could read first. The `package-context.capabilities` closure walk does not depend on this — it expands each id
once and terminates on a cycle — so the rule is about meaning, not about keeping the walk finite.

## Semantic guidance for authors

Relations carry meaning that the Runtime cannot check:

- `requires` means *a reader cannot correctly understand this Document without that one*. The reading ladder follows it
  automatically, so an over-broad `requires` directly inflates every reader's context cost.
- `related` is optional context. Readers are told they may skip it.
- `supersedes` records that this Document replaces earlier knowledge.

`description` is not decoration. It is what `frontier.query` returns at depth 1 and 2, so for most readers it is the
*only* thing they see about a Document they did not select. A description that does not let a reader decide whether to
open the body has failed at its job.
