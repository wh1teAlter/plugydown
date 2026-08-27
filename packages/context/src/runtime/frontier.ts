import type { ContextDocument } from './document.js'
import type { KnowledgeGraph } from './graph.js'
import type { Budget, DocumentKind, JsonObject } from './types.js'
import { Buffer } from 'node:buffer'
import { normalizeBody } from './fingerprint.js'
import { compareCodeUnits } from './stable-json.js'

/** Default limits applied when the caller declares none. */
const DEFAULT_BUDGET: Required<Budget> = { items: 25, bytes: 96 * 1024, estimatedTokens: 24_000 }

/** Conservative characters-per-token ratio. Deliberately pessimistic so budgets never overrun. */
const CHARS_PER_TOKEN = 3

/** What a query asks the runtime to select. */
export interface FrontierSelector {
  readonly domains?: readonly string[]
  readonly ids?: readonly string[]
  readonly kinds?: readonly DocumentKind[]
  readonly codePaths?: readonly string[]
  readonly relation?: 'requires' | 'related' | 'supersedes'
  /** `metadata` returns front matter only; `body` includes normalized bodies. */
  readonly projection?: 'metadata' | 'body'
}

/** One selected document, projected to the requested depth. */
export interface FrontierItem {
  readonly id: string
  readonly domain: string
  readonly kind: DocumentKind
  readonly description: string
  readonly path: string
  readonly requires: readonly string[]
  readonly body?: string
}

/** The result of one bounded query. */
export interface FrontierPage {
  readonly items: readonly FrontierItem[]
  readonly cursor?: string
  readonly totalCandidates: number
}

/** @returns a conservative token estimate for a string. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Orders candidates by default relevance.
 *
 * Direct code relations come first because they are the strongest evidence that a document
 * describes what the caller is touching; `related` comes last because it carries no obligation.
 *
 * @param graph the document graph.
 * @param selector the query.
 * @returns candidate IDs in priority order.
 */
function rank(graph: KnowledgeGraph, selector: FrontierSelector): readonly string[] {
  const codeMatched = new Set<string>()
  for (const declared of selector.codePaths ?? []) {
    for (const [path, owners] of graph.codeIndex) {
      if (path === declared || declared.startsWith(`${path.replace(/\/\*\*.*$/, '')}/`))
        owners.forEach(id => codeMatched.add(id))
    }
  }

  const required = new Set<string>()
  for (const id of selector.ids ?? []) {
    for (const next of graph.documents.get(id)?.relations.requires ?? [])
      required.add(next)
  }

  const sameDomain = new Set<string>()
  for (const domain of selector.domains ?? []) {
    for (const id of graph.domains.get(domain)?.documentIds ?? [])
      sameDomain.add(id)
  }

  const related = new Set<string>()
  for (const id of selector.ids ?? []) {
    for (const next of graph.documents.get(id)?.relations.related ?? [])
      related.add(next)
  }

  const tier = (id: string): number => {
    if ((selector.ids ?? []).includes(id))
      return 0
    if (codeMatched.has(id))
      return 1
    if (required.has(id))
      return 2
    if (sameDomain.has(id))
      return 3
    if (related.has(id))
      return 4
    return 5
  }

  return [...graph.documents.keys()]
    .sort((left, right) => tier(left) - tier(right) || compareCodeUnits(left, right))
}

/** @returns whether a document satisfies every declared filter. */
function matches(document: ContextDocument, selector: FrontierSelector, ranked: ReadonlySet<string>): boolean {
  if (selector.domains !== undefined && !selector.domains.includes(document.domain))
    return false
  if (selector.kinds !== undefined && !selector.kinds.includes(document.kind))
    return false
  if (selector.ids !== undefined || selector.codePaths !== undefined || selector.relation !== undefined)
    return ranked.has(document.id)
  return true
}

/** @returns the candidate set a selector admits, in priority order. */
function candidates(graph: KnowledgeGraph, selector: FrontierSelector): readonly string[] {
  const ordered = rank(graph, selector)

  const admitted = new Set<string>()
  if (selector.ids !== undefined)
    selector.ids.forEach(id => admitted.add(id))
  if (selector.relation !== undefined) {
    for (const id of selector.ids ?? []) {
      for (const next of graph.documents.get(id)?.relations[selector.relation] ?? [])
        admitted.add(next)
    }
  }
  if (selector.codePaths !== undefined) {
    for (const declared of selector.codePaths) {
      for (const [path, owners] of graph.codeIndex) {
        if (path === declared || declared.startsWith(`${path.replace(/\/\*\*.*$/, '')}/`))
          owners.forEach(id => admitted.add(id))
      }
    }
  }

  return ordered.filter((id) => {
    const document = graph.documents.get(id)
    return document !== undefined && matches(document, selector, admitted)
  })
}

/**
 * Runs one bounded frontier query.
 *
 * A returned cursor means the page was bounded, never that anything was dropped: the caller
 * decides whether the task actually needs the next page.
 *
 * @param graph the document graph.
 * @param selector the query.
 * @param budget item, byte, and token limits.
 * @param cursor a continuation cursor from a previous page.
 * @returns the page and, when more remains, a continuation cursor.
 */
export function queryFrontier(
  graph: KnowledgeGraph,
  selector: FrontierSelector,
  budget: Budget = {},
  cursor?: string,
): FrontierPage {
  const limits = { ...DEFAULT_BUDGET, ...budget }
  const ordered = candidates(graph, selector)
  const start = cursor === undefined ? 0 : Math.max(0, ordered.indexOf(cursor))

  const items: FrontierItem[] = []
  let bytes = 0
  let tokens = 0
  let index = start

  for (; index < ordered.length; index += 1) {
    const id = ordered[index]
    const document = id === undefined ? undefined : graph.documents.get(id)
    if (document === undefined)
      continue

    const body = selector.projection === 'body' ? normalizeBody(document.body) : undefined
    const projected = `${document.id}${document.description}${body ?? ''}`
    const nextBytes = bytes + Buffer.byteLength(projected, 'utf8')
    const nextTokens = tokens + estimateTokens(projected)

    if (items.length > 0 && (items.length >= limits.items || nextBytes > limits.bytes || nextTokens > limits.estimatedTokens))
      break

    items.push({
      id: document.id,
      domain: document.domain,
      kind: document.kind,
      description: document.description,
      path: document.path,
      requires: document.relations.requires,
      ...(body === undefined ? {} : { body }),
    })
    bytes = nextBytes
    tokens = nextTokens
  }

  const next = ordered[index]
  return {
    items,
    totalCandidates: ordered.length,
    ...(index < ordered.length && next !== undefined ? { cursor: next } : {}),
  }
}

/** @returns a frontier page as a JSON payload. */
export function pageToJson(page: FrontierPage): JsonObject {
  return {
    totalCandidates: page.totalCandidates,
    items: page.items.map(item => ({
      id: item.id,
      domain: item.domain,
      kind: item.kind,
      description: item.description,
      path: item.path,
      requires: [...item.requires],
      ...(item.body === undefined ? {} : { body: item.body }),
    })),
    ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
  }
}
