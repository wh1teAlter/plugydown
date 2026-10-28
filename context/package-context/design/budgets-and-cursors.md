---
schema: plugydown.context.document/v1
id: package-context.budgets-and-cursors
description: Output ceilings measured on exact serialized bytes, the never-truncate-an-item rule, body chunking on code-point boundaries, and the sealed continuation cursor.
kind: architecture
domain: package-context
relations:
  requires:
    - package-context.determinism
    - package-context
  supersedes:
    - runtime-protocol.budgets-and-cursors
code:
  paths:
    - packages/context/src/runtime/protocol.ts
---

# Budgets and cursors

## Two ceilings

| Limit | Default | Maximum |
|---|---|---|
| `items` | 100 | 1000 |
| `bytes` | 262144 (256 KiB) | 1048576 (1 MiB) |
| `estimatedTokens` | 32000 | 128000 |

A caller may lower any field; a value above `MAX_BUDGET` is `BUDGET_INVALID`. Omitted fields fall back to the default,
so a partial budget object is legal. `DEFAULT_BUDGET` and `MAX_BUDGET` live in `packages/context/src/runtime/protocol.ts`.

Bytes are measured on the exact serialized response — `Buffer.byteLength(stableJson(response))` — not on an estimate of
the payload. `responseFits` builds the full candidate response, including the cursor it would emit, before deciding.
That is why a budget can be too small for a response that carries no items at all: the envelope itself has a size.

`estimateTokens` is a `bytes/3` heuristic (`Math.ceil(byteLength(compactJson(value)) / 3)`), not a tokenizer. Treat the
token ceiling as a coarse guard, not as a promise about any specific model's accounting.

## Items are never truncated

`paginate` adds one whole item at a time and stops before the first item that would not fit. If the *first* item does
not fit, it does not shrink the item — it fails:

- `RESULT_ITEM_TOO_LARGE` when the item plus its envelope exceeds `MAX_BUDGET`. Nothing the caller can do with `budget`
  will help; the data itself is too big for the protocol.
- `BUDGET_TOO_SMALL` when it fits `MAX_BUDGET` but not the caller's budget. Raising the budget will help.

Distinguishing these two is the point. A caller that collapses them will retry forever on the first.

## Bodies chunk separately

Document bodies are the one thing that *is* split, because a single body can legitimately exceed a page.
`fitBodyChunk` precomputes every UTF-8 byte boundary by iterating code points, then binary-searches for the largest
boundary whose response still fits. Consequences:

- A chunk never lands mid-code-point. A cursor byte offset that is not a boundary is `CURSOR_INVALID`.
- The chunk carries `startByte`, `endByte`, `totalBytes`, and `complete`, so a caller always knows where it is.
- Even here the same two failures apply: if one code point plus the envelope busts `MAX_BUDGET` it is
  `RESULT_ITEM_TOO_LARGE`; if it busts only the caller budget it is `BUDGET_TOO_SMALL`. Progress is guaranteed or the
  request fails — the Runtime never returns a cursor that does not advance.

In `frontier.query`, metadata pagination deliberately stops at the first item that has a body (`queries.ts`), so a page
is either a run of metadata or exactly one body chunk. That keeps the two mechanisms from interleaving.

## Cursor integrity and snapshot binding

A cursor is base64url of a compact JSON payload containing:

```
format, capability, inputFingerprint, contextFingerprint, stateFingerprint, itemOffset, bodyByteOffset?, integrityHash
```

`integrityHash` is SHA-256 over the same object without the hash. It is an unkeyed integrity check, not a signature or
authorization mechanism. Decoding enforces, in order:

1. character set `^[\w-]+$`, then **canonical** base64url — re-encoding the decoded bytes must reproduce the input
   exactly, so padded or otherwise alternative encodings are rejected
2. exact key set (with `bodyByteOffset` present only if it was present), hash shape, and non-negative safe-integer
   offsets
3. `timingSafeEqual` against the recomputed hash
4. field-by-field equality of format, capability, input, context, and state fingerprints

Steps 1–2 fail as `CURSOR_INVALID` (malformed or tampered). Steps 3–4 fail as `CURSOR_STALE` (well-formed but no longer
matching this query or this repository state). These are genuinely different situations: `CURSOR_INVALID` means the
caller's cursor handling is broken, `CURSOR_STALE` means the world moved and the query must be reissued from the start.

Because `contextFingerprint` and `stateFingerprint` are bound in, a cursor cannot survive an edit to `context/`, a
change in the capability-owned state or underlying evidence. There is no way to page through a tree that is
being modified underneath you and get a coherent result — the second page simply refuses.

`inputFingerprint` is `sha256(compactJson(input))`, so changing any selector invalidates the cursor too. Continuing a
cursor with a modified input is not "refining a query"; it is an error.
