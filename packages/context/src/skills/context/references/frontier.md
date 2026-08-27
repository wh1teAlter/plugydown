# Frontier: selecting and budgeting reads

The Runtime filters, orders, and paginates. You decide *where to look semantically*.

## Levels

| Level | Input | Output | Stop here when |
|---|---|---|---|
| L0 | repository root | Domain list and shape | The task is not knowledge-dependent |
| L1 | candidate Domain IDs | `domain.md` front matter | One Domain obviously owns the task |
| L2 | Domain, kind, relation, or code path selector | document metadata | A description answers the question |
| L3 | document IDs | bodies, plus minimal source | You need the actual invariant or contract |

Each level is a legitimate stopping point.

## Selectors

A batch accepts any of:

- Domain ID
- document ID
- `kind` — `domain`, `architecture`, `decision`, `guide`, `reference`, `reflection`
- relation — `requires`, `related`, `supersedes`
- code path

Default candidate order when you do not impose one:

```text
direct code relation → requires → same Domain → related
```

## Budgets

Every batch is bounded by three limits at once: item count, bytes, and a conservative token
estimate. When any limit is reached the Runtime returns a **continuation cursor**.

A cursor means *paginated*, not *truncated*. Nothing was silently dropped. Continue only if
the task genuinely needs the next page.

Cursors are ephemeral. They never appear in `context/` documents or in `meta.json`.

## Reading a Domain

```text
select Domain → read domain.md → follow relations.requires → read only what is required
```

`domain.md` is short by contract: purpose, boundary, invariants, vocabulary, navigation.
Navigation tells you *which kind of document to read under which circumstance* — it is not a
file listing, so do not expect it to enumerate the Domain.

Never read a Domain exhaustively "to be safe". If `requires` does not lead you to a document,
that document is not a prerequisite.

## When knowledge and code disagree

Trust the code for current behavior, and say so. A contradiction is evidence for an `update`,
not something to silently work around — record it as feedback or raise it at task end.
