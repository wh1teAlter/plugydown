import type { ContextDocument, DocumentLedger, KnowledgeIssue, Meta, Metrics } from './document.js'
import type { SourceFile } from './repository.js'
import type { JsonObject } from './stable-json.js'
import { bodyFingerprint, frontMatterFingerprint, parseDocument, parseMeta, placementIssues, sourceFingerprint } from './document.js'
import { RuntimeFault } from './protocol.js'
import {
  CONTEXT_ROOT,
  expandSourcePatternSets,
  fingerprintTree,
  lstatRepositoryPath,
  MAX_JSON_TEXT_BYTES,
  MAX_MARKDOWN_BYTES,
  readDirectory,
  readUtf8File,
} from './repository.js'
import { compareCodeUnits } from './stable-json.js'

export interface DomainNode {
  readonly id: string
  readonly documentIds: readonly string[]
  readonly domainDocumentId?: string
}

export type SourcePolicy = 'formal-only' | 'selected' | 'all-strict' | 'all-tolerant'

export interface SourceKnowledgeIssue extends KnowledgeIssue {
  readonly documentId: string
  readonly sourcePattern: string
}

export interface KnowledgeGraph {
  readonly contextPath: string
  readonly formalState: 'absent' | 'ready' | 'invalid'
  readonly sourceState: 'unchecked' | 'ready' | 'degraded'
  readonly metaState: 'absent' | 'valid' | 'invalid'
  readonly contextFingerprint?: string
  readonly sourceFingerprint?: string
  readonly documents: ReadonlyMap<string, ContextDocument>
  readonly domains: ReadonlyMap<string, DomainNode>
  readonly sources: ReadonlyMap<string, readonly SourceFile[]>
  readonly ledgers: ReadonlyMap<string, DocumentLedger>
  readonly meta?: Meta
  readonly issues: readonly KnowledgeIssue[]
  readonly sourceIssues: readonly SourceKnowledgeIssue[]
  readonly counts: {
    readonly domains: number
    readonly design: number
    readonly manual: number
    readonly reflections: number
    readonly documents: number
  }
  readonly relationCount: number
  readonly sourceDeclarationCount: number
}

const DOMAIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CATEGORIES = new Set(['design', 'manual', 'reflections'])
const META_PATH_FOR_ISSUE = 'context/meta.json'

function issue(code: string, message: string, issuePath: string): KnowledgeIssue {
  return { code, message, path: issuePath }
}

function faultIssues(error: unknown, fallbackPath: string): readonly KnowledgeIssue[] {
  if (!(error instanceof RuntimeFault))
    throw error
  return error.diagnostics.map(item => issue(item.code, item.message, item.path ?? fallbackPath))
}

function canonicalPath(contextPath: string, actualPath: string): string {
  return actualPath === contextPath ? CONTEXT_ROOT : `${CONTEXT_ROOT}/${actualPath.slice(contextPath.length + 1)}`
}

interface LoadedDocuments {
  readonly documents: readonly ContextDocument[]
  readonly domains: readonly string[]
  readonly issues: readonly KnowledgeIssue[]
  readonly counts: { readonly design: number, readonly manual: number, readonly reflections: number }
}

async function loadDocuments(root: string, contextPath: string): Promise<LoadedDocuments> {
  const documents: ContextDocument[] = []
  const domains: string[] = []
  const issues: KnowledgeIssue[] = []
  const counts = { design: 0, manual: 0, reflections: 0 }
  const rootEntries = await readDirectory(root, contextPath)
  for (const entry of rootEntries) {
    const actual = `${contextPath}/${entry.name}`
    const canonical = canonicalPath(contextPath, actual)
    if (entry.name === 'meta.json') {
      if (entry.kind !== 'file')
        issues.push(issue('META_NOT_REGULAR_FILE', 'context/meta.json must be a regular file.', canonical))
      continue
    }
    if (entry.kind !== 'directory') {
      issues.push(issue(entry.kind === 'symlink' ? 'KNOWLEDGE_SYMLINK' : 'KNOWLEDGE_ROOT_ENTRY_INVALID', 'The Context root may contain only Meta and Domain directories.', canonical))
      continue
    }
    if (!DOMAIN_ID.test(entry.name)) {
      issues.push(issue('DOMAIN_ID_INVALID', 'Domain directory names must use lowercase kebab-case.', canonical))
      continue
    }
    domains.push(entry.name)
    const children = await readDirectory(root, actual)
    let domainDocument = false
    for (const child of children) {
      const childActual = `${actual}/${child.name}`
      const childCanonical = canonicalPath(contextPath, childActual)
      if (child.name === 'domain.md') {
        if (child.kind !== 'file') {
          issues.push(issue('DOCUMENT_NOT_REGULAR_FILE', 'domain.md must be a regular Markdown file.', childCanonical))
        }
        else {
          const parsed = parseDocument(childCanonical, await readUtf8File(root, childActual, MAX_MARKDOWN_BYTES))
          if (parsed.ok) {
            documents.push(parsed.document)
            issues.push(...placementIssues(parsed.document))
            domainDocument = true
          }
          else {
            issues.push(...parsed.issues)
          }
        }
        continue
      }
      if (child.kind !== 'directory' || !CATEGORIES.has(child.name)) {
        issues.push(issue(child.kind === 'symlink' ? 'KNOWLEDGE_SYMLINK' : 'DOCUMENT_PLACEMENT_INVALID', 'A Domain may contain only domain.md and canonical category directories.', childCanonical))
        continue
      }
      const leaves = await readDirectory(root, childActual)
      if (leaves.length === 0)
        issues.push(issue('DOCUMENT_CATEGORY_EMPTY', 'Empty Document category directories are not allowed.', childCanonical))
      for (const leaf of leaves) {
        const leafActual = `${childActual}/${leaf.name}`
        const leafCanonical = canonicalPath(contextPath, leafActual)
        if (leaf.kind !== 'file' || !leaf.name.endsWith('.md')) {
          issues.push(issue(leaf.kind === 'symlink' ? 'KNOWLEDGE_SYMLINK' : 'DOCUMENT_PLACEMENT_INVALID', 'Document categories contain only regular Markdown files.', leafCanonical))
          continue
        }
        const parsed = parseDocument(leafCanonical, await readUtf8File(root, leafActual, MAX_MARKDOWN_BYTES))
        if (parsed.ok) {
          documents.push(parsed.document)
          issues.push(...placementIssues(parsed.document))
          counts[child.name as keyof typeof counts] += 1
        }
        else {
          issues.push(...parsed.issues)
        }
      }
    }
    if (!domainDocument)
      issues.push(issue('DOMAIN_DOCUMENT_MISSING', 'Every Domain must contain a valid domain.md.', `${CONTEXT_ROOT}/${entry.name}`))
  }
  if (domains.length === 0)
    issues.push(issue('DOMAIN_MISSING', 'A ready Context tree must contain at least one Domain.', CONTEXT_ROOT))
  return { documents, domains, issues, counts }
}

function requiresCycles(documents: ReadonlyMap<string, ContextDocument>): readonly string[] {
  const state = new Map<string, 'visiting' | 'done'>()
  const cyclic = new Set<string>()
  const visit = (id: string, stack: string[]): void => {
    const known = state.get(id)
    if (known === 'done')
      return
    if (known === 'visiting') {
      const offset = stack.indexOf(id)
      stack.slice(offset < 0 ? 0 : offset).forEach(member => cyclic.add(member))
      return
    }
    state.set(id, 'visiting')
    stack.push(id)
    for (const target of documents.get(id)?.relations.requires ?? []) {
      if (documents.has(target))
        visit(target, stack)
    }
    stack.pop()
    state.set(id, 'done')
  }
  for (const id of [...documents.keys()].sort(compareCodeUnits))
    visit(id, [])
  return [...cyclic].sort(compareCodeUnits)
}

function documentMetrics(documents: Iterable<ContextDocument>): Metrics {
  let documentCount = 0
  let frontMatterBytes = 0
  let bodyBytes = 0
  for (const document of documents) {
    documentCount += 1
    frontMatterBytes += document.frontMatterBytes
    bodyBytes += document.bodyBytes
  }
  return { documentCount, frontMatterBytes, bodyBytes, estimatedTokens: Math.ceil((frontMatterBytes + bodyBytes) / 3) }
}

export function graphMetrics(graph: KnowledgeGraph): { readonly current: Metrics, readonly perDomain: Readonly<Record<string, Metrics>> } {
  const perDomain: Record<string, Metrics> = {}
  for (const [id, domain] of graph.domains)
    perDomain[id] = documentMetrics(domain.documentIds.map(documentId => graph.documents.get(documentId) as ContextDocument))
  return { current: documentMetrics(graph.documents.values()), perDomain }
}

function emptyGraph(contextPath: string, formalState: 'absent' | 'invalid', issues: readonly KnowledgeIssue[]): KnowledgeGraph {
  return {
    contextPath,
    formalState,
    sourceState: 'unchecked',
    metaState: 'absent',
    documents: new Map(),
    domains: new Map(),
    sources: new Map(),
    ledgers: new Map(),
    issues,
    sourceIssues: [],
    counts: { domains: 0, design: 0, manual: 0, reflections: 0, documents: 0 },
    relationCount: 0,
    sourceDeclarationCount: 0,
  }
}

/** Loads formal knowledge and source evidence under an explicit capability policy. */
export async function loadKnowledge(
  root: string,
  contextPath = CONTEXT_ROOT,
  options: {
    readonly ignoreMeta?: boolean
    readonly requireMeta?: boolean
    readonly sourcePolicy?: SourcePolicy
    readonly selectedDocumentIds?: readonly string[]
  } = {},
): Promise<KnowledgeGraph> {
  const requireMeta = options.requireMeta !== false
  const sourcePolicy = options.sourcePolicy ?? 'all-strict'
  let info
  try {
    info = await lstatRepositoryPath(root, contextPath)
  }
  catch (error) {
    return emptyGraph(contextPath, 'invalid', faultIssues(error, CONTEXT_ROOT))
  }
  if (info === undefined)
    return emptyGraph(contextPath, 'absent', [])
  if (!info.isDirectory())
    return emptyGraph(contextPath, 'invalid', [issue('CONTEXT_NOT_DIRECTORY', 'The Context root must be a regular directory.', CONTEXT_ROOT)])

  const formalIssues: KnowledgeIssue[] = []
  let contextFingerprint: string | undefined
  try {
    contextFingerprint = await fingerprintTree(root, contextPath)
  }
  catch (error) {
    formalIssues.push(...faultIssues(error, CONTEXT_ROOT))
  }
  let loaded: LoadedDocuments = { documents: [], domains: [], issues: [], counts: { design: 0, manual: 0, reflections: 0 } }
  try {
    loaded = await loadDocuments(root, contextPath)
    formalIssues.push(...loaded.issues)
  }
  catch (error) {
    formalIssues.push(...faultIssues(error, CONTEXT_ROOT))
  }

  const documents = new Map<string, ContextDocument>()
  for (const document of [...loaded.documents].sort((left, right) => compareCodeUnits(left.path, right.path))) {
    if (documents.has(document.id))
      formalIssues.push(issue('DOCUMENT_ID_DUPLICATE', `Document id "${document.id}" is duplicated.`, document.path))
    else
      documents.set(document.id, document)
  }
  const domainSet = new Set(loaded.domains)
  for (const document of documents.values()) {
    if (!domainSet.has(document.domain))
      formalIssues.push(issue('DOCUMENT_DOMAIN_UNKNOWN', 'Document refers to an unknown Domain.', document.path))
    for (const relation of ['requires', 'related', 'supersedes'] as const) {
      for (const target of document.relations[relation]) {
        if (target === document.id)
          formalIssues.push(issue('DOCUMENT_RELATION_SELF', 'A Document must not relate to itself.', document.path))
        if (relation !== 'supersedes' && !documents.has(target))
          formalIssues.push(issue('DOCUMENT_RELATION_DANGLING', `Relation target "${target}" is missing.`, document.path))
      }
    }
  }
  for (const id of requiresCycles(documents))
    formalIssues.push(issue('DOCUMENT_REQUIRES_CYCLE', `Document "${id}" participates in a requires cycle.`, documents.get(id)?.path ?? CONTEXT_ROOT))

  const domains = new Map<string, DomainNode>()
  for (const id of [...domainSet].sort(compareCodeUnits)) {
    const documentIds = [...documents.values()].filter(document => document.domain === id).map(document => document.id).sort(compareCodeUnits)
    const domainDocumentId = documentIds.find(documentId => documents.get(documentId)?.kind === 'domain')
    domains.set(id, { id, documentIds, ...(domainDocumentId === undefined ? {} : { domainDocumentId }) })
  }

  let meta: Meta | undefined
  let metaState: KnowledgeGraph['metaState'] = 'absent'
  const metaActual = `${contextPath}/meta.json`
  let metaInfo
  if (options.ignoreMeta !== true) {
    try {
      metaInfo = await lstatRepositoryPath(root, metaActual)
    }
    catch (error) {
      metaState = 'invalid'
      formalIssues.push(...faultIssues(error, META_PATH_FOR_ISSUE))
    }
  }
  if (metaInfo !== undefined) {
    if (!metaInfo.isFile()) {
      metaState = 'invalid'
      formalIssues.push(issue('META_NOT_REGULAR_FILE', 'context/meta.json must be a regular file.', META_PATH_FOR_ISSUE))
    }
    else {
      try {
        const text = await readUtf8File(root, metaActual, MAX_JSON_TEXT_BYTES)
        let raw: unknown
        try {
          raw = JSON.parse(text.replace(/^\uFEFF/, ''))
        }
        catch (error) {
          if (!(error instanceof SyntaxError))
            throw error
          formalIssues.push(issue('META_JSON_INVALID', 'context/meta.json must contain valid JSON.', META_PATH_FOR_ISSUE))
          metaState = 'invalid'
        }
        if (raw !== undefined) {
          const parsed = parseMeta(META_PATH_FOR_ISSUE, raw)
          if (parsed.ok) {
            meta = parsed.meta
            metaState = 'valid'
          }
          else {
            metaState = 'invalid'
            formalIssues.push(...parsed.issues)
          }
        }
      }
      catch (error) {
        metaState = 'invalid'
        formalIssues.push(...faultIssues(error, META_PATH_FOR_ISSUE))
      }
    }
  }
  if (requireMeta && options.ignoreMeta !== true && metaState === 'absent')
    formalIssues.push(issue('META_MISSING', 'A ready Context tree requires context/meta.json.', META_PATH_FOR_ISSUE))
  if (requireMeta && meta !== undefined) {
    const expectedIds = [...documents.keys()].sort(compareCodeUnits)
    const actualIds = Object.keys(meta.documents).sort(compareCodeUnits)
    if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds))
      formalIssues.push(issue('META_DOCUMENT_SET_MISMATCH', 'Meta Document IDs must exactly match the formal Markdown tree.', META_PATH_FOR_ISSUE))
    for (const id of expectedIds) {
      const document = documents.get(id) as ContextDocument
      const actual = meta.documents[id]
      if (actual === undefined
        || frontMatterFingerprint(document) !== actual.frontMatterFingerprint
        || bodyFingerprint(document) !== actual.bodyFingerprint) {
        formalIssues.push(issue('META_DOCUMENT_FINGERPRINT_MISMATCH', `Meta content fingerprints for "${id}" are stale or incomplete.`, META_PATH_FOR_ISSUE))
      }
    }
  }

  const sortedFormalIssues = formalIssues.sort((left, right) => compareCodeUnits(`${left.path}\0${left.code}`, `${right.path}\0${right.code}`))
  const formalState: KnowledgeGraph['formalState'] = sortedFormalIssues.length === 0 && (!requireMeta || metaState === 'valid') ? 'ready' : 'invalid'
  const sources = new Map<string, readonly SourceFile[]>()
  const ledgers = new Map<string, DocumentLedger>()
  const sourceIssues: SourceKnowledgeIssue[] = []
  let sourceState: KnowledgeGraph['sourceState'] = 'unchecked'
  let sourceDatasetFingerprint: string | undefined

  if (formalState === 'ready' && sourcePolicy !== 'formal-only') {
    const selectedIds = sourcePolicy === 'selected'
      ? [...(options.selectedDocumentIds ?? [])].filter(id => documents.has(id)).sort(compareCodeUnits)
      : [...documents.keys()].sort(compareCodeUnits)
    if (selectedIds.length > 0 || sourcePolicy !== 'selected') {
      const expansion = await expandSourcePatternSets(root, selectedIds.map(id => ({
        owner: id,
        patterns: (documents.get(id) as ContextDocument).codePaths,
      })))
      sourceDatasetFingerprint = expansion.fingerprint
      const affected = new Set<string>()
      for (const problem of expansion.issues) {
        affected.add(problem.owner)
        sourceIssues.push({
          documentId: problem.owner,
          sourcePattern: problem.pattern,
          code: problem.diagnostic.code,
          message: problem.diagnostic.message,
          path: documents.get(problem.owner)?.path ?? CONTEXT_ROOT,
        })
      }
      for (const id of selectedIds) {
        if (affected.has(id))
          continue
        const document = documents.get(id) as ContextDocument
        const files = expansion.filesByOwner.get(id) ?? []
        sources.set(id, files)
        ledgers.set(id, {
          frontMatterFingerprint: frontMatterFingerprint(document),
          bodyFingerprint: bodyFingerprint(document),
          sourceFingerprint: sourceFingerprint(document, files),
        })
      }
      sourceState = sourceIssues.length === 0 ? 'ready' : 'degraded'
    }
  }

  const sortedSourceIssues = sourceIssues.sort((left, right) => compareCodeUnits(
    `${left.documentId}\0${left.sourcePattern}\0${left.code}`,
    `${right.documentId}\0${right.sourcePattern}\0${right.code}`,
  ))
  const relationCount = [...documents.values()].reduce((total, document) => total
    + document.relations.requires.length + document.relations.related.length + document.relations.supersedes.length, 0)
  const sourceDeclarationCount = [...documents.values()].reduce((total, document) => total + document.codePaths.length, 0)
  return {
    contextPath,
    formalState,
    sourceState,
    metaState,
    ...(contextFingerprint === undefined ? {} : { contextFingerprint }),
    ...(sourceDatasetFingerprint === undefined ? {} : { sourceFingerprint: sourceDatasetFingerprint }),
    documents,
    domains,
    sources,
    ledgers,
    ...(meta === undefined ? {} : { meta }),
    issues: sortedFormalIssues,
    sourceIssues: sortedSourceIssues,
    counts: {
      domains: domains.size,
      design: loaded.counts.design,
      manual: loaded.counts.manual,
      reflections: loaded.counts.reflections,
      documents: documents.size,
    },
    relationCount,
    sourceDeclarationCount,
  }
}

export function requiresClosure(graph: KnowledgeGraph, seeds: readonly string[]): readonly { readonly id: string, readonly reasons: readonly string[] }[] {
  const reasons = new Map<string, Set<string>>()
  const pending = [...seeds].sort(compareCodeUnits).map(id => ({ id, reason: 'selected' }))
  while (pending.length > 0) {
    const current = pending.shift() as { id: string, reason: string }
    const known = reasons.get(current.id) ?? new Set<string>()
    const before = known.size
    known.add(current.reason)
    reasons.set(current.id, known)
    if (before > 0)
      continue
    for (const target of graph.documents.get(current.id)?.relations.requires ?? [])
      pending.push({ id: target, reason: `required by ${current.id}` })
  }
  return [...reasons.entries()].sort(([left], [right]) => compareCodeUnits(left, right)).map(([id, values]) => ({
    id,
    reasons: [...values].sort(compareCodeUnits),
  }))
}

/** Expands direct delta impact through prerequisites, reverse dependents and Domain membership. */
export function impactClosure(graph: KnowledgeGraph, direct: ReadonlyMap<string, readonly string[]>): readonly { readonly documentId: string, readonly reasons: readonly string[] }[] {
  const reasons = new Map<string, Set<string>>()
  const pending: string[] = []
  for (const [id, directReasons] of direct) {
    reasons.set(id, new Set(directReasons))
    pending.push(id)
  }
  while (pending.length > 0) {
    const id = pending.shift() as string
    const document = graph.documents.get(id)
    if (document === undefined)
      continue
    const additions: { id: string, reason: string }[] = []
    for (const target of document.relations.requires)
      additions.push({ id: target, reason: `required by impacted ${id}` })
    for (const candidate of graph.documents.values()) {
      if (candidate.relations.requires.includes(id))
        additions.push({ id: candidate.id, reason: `depends on impacted ${id}` })
      if (candidate.domain === document.domain && candidate.id !== id)
        additions.push({ id: candidate.id, reason: `shares Domain ${document.domain} with impacted ${id}` })
    }
    for (const addition of additions.sort((left, right) => compareCodeUnits(`${left.id}\0${left.reason}`, `${right.id}\0${right.reason}`))) {
      const known = reasons.get(addition.id) ?? new Set<string>()
      const wasEmpty = known.size === 0
      known.add(addition.reason)
      reasons.set(addition.id, known)
      if (wasEmpty)
        pending.push(addition.id)
    }
  }
  return [...reasons.entries()].sort(([left], [right]) => compareCodeUnits(left, right)).map(([documentId, values]) => ({
    documentId,
    reasons: [...values].sort(compareCodeUnits),
  }))
}

export function documentMetadata(document: ContextDocument, reasons?: readonly string[]): JsonObject {
  return {
    id: document.id,
    description: document.description,
    kind: document.kind,
    domain: document.domain,
    path: document.path,
    relations: {
      requires: [...document.relations.requires],
      related: [...document.relations.related],
      supersedes: [...document.relations.supersedes],
    },
    code: { paths: [...document.codePaths] },
    ...(reasons === undefined ? {} : { reasons: [...reasons] }),
  }
}
