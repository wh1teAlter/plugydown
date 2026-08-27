import type { ContextDocument, DocumentIssue } from './document.js'
import { KNOWLEDGE_ROOT } from './constants.js'
import { checkPlacement, parseDocument } from './document.js'
import { listRepositoryDirectory, readRepositoryFile } from './repository.js'
import { compareCodeUnits } from './stable-json.js'

/** A Domain and the documents that belong to it. */
export interface DomainNode {
  readonly id: string
  readonly documentIds: readonly string[]
  readonly hasDomainDocument: boolean
}

/** The derived document graph. */
export interface KnowledgeGraph {
  readonly documents: ReadonlyMap<string, ContextDocument>
  readonly domains: ReadonlyMap<string, DomainNode>
  /** code path or glob → document IDs that declare it. */
  readonly codeIndex: ReadonlyMap<string, readonly string[]>
  readonly issues: readonly DocumentIssue[]
}

/** @returns whether a file name is a Markdown document. */
function isMarkdown(name: string): boolean {
  return name.endsWith('.md')
}

/**
 * Loads every document under the knowledge root.
 *
 * Placement is checked here rather than in the parser because it depends on where the file
 * sits, which the parser deliberately does not know.
 *
 * @param root absolute repository root.
 * @returns parsed documents paired with their Domain, plus structural issues.
 */
async function loadDocuments(root: string): Promise<{
  readonly documents: readonly ContextDocument[]
  readonly domains: readonly { readonly id: string, readonly hasDomainDocument: boolean }[]
  readonly issues: readonly DocumentIssue[]
}> {
  const documents: ContextDocument[] = []
  const domains: { id: string, hasDomainDocument: boolean }[] = []
  const issues: DocumentIssue[] = []

  const read = async (path: string, category: string | undefined, domainId: string): Promise<boolean> => {
    const result = parseDocument(path, await readRepositoryFile(root, path))
    if (!result.ok) {
      issues.push(...result.issues)
      return false
    }
    const placement = checkPlacement(result.document, category)
    if (placement !== undefined)
      issues.push(placement)
    if (result.document.domain !== domainId) {
      issues.push({
        code: 'DOCUMENT_DOMAIN_MISMATCH',
        message: `Document declares domain "${result.document.domain}" but sits in "${domainId}".`,
        path,
      })
    }
    documents.push(result.document)
    return true
  }

  for (const entry of await listRepositoryDirectory(root, KNOWLEDGE_ROOT)) {
    if (entry.kind !== 'directory')
      continue
    const domainId = entry.name
    const children = await listRepositoryDirectory(root, `${KNOWLEDGE_ROOT}/${domainId}`)
    let hasDomainDocument = false

    for (const child of children) {
      if (child.kind === 'file' && child.name === 'domain.md')
        hasDomainDocument = await read(`${KNOWLEDGE_ROOT}/${domainId}/domain.md`, undefined, domainId)
      else if (child.kind === 'file' && isMarkdown(child.name))
        issues.push({ code: 'DOCUMENT_PLACEMENT_INVALID', message: 'Only domain.md may sit at the Domain root.', path: `${KNOWLEDGE_ROOT}/${domainId}/${child.name}` })
    }

    for (const child of children) {
      if (child.kind !== 'directory')
        continue
      for (const leaf of await listRepositoryDirectory(root, `${KNOWLEDGE_ROOT}/${domainId}/${child.name}`)) {
        if (leaf.kind === 'file' && isMarkdown(leaf.name))
          await read(`${KNOWLEDGE_ROOT}/${domainId}/${child.name}/${leaf.name}`, child.name, domainId)
      }
    }

    if (!hasDomainDocument) {
      issues.push({
        code: 'DOMAIN_DOCUMENT_MISSING',
        message: `Domain "${domainId}" must contain a domain.md.`,
        path: `${KNOWLEDGE_ROOT}/${domainId}`,
      })
    }
    domains.push({ id: domainId, hasDomainDocument })
  }

  return { documents, domains, issues }
}

/**
 * Detects a cycle in the `requires` relation.
 *
 * `related` is deliberately excluded: it carries no reading obligation, so a loop there is
 * meaningful rather than broken.
 *
 * @param documents every document by ID.
 * @returns the IDs that participate in a cycle.
 */
function requiresCycles(documents: ReadonlyMap<string, ContextDocument>): readonly string[] {
  const state = new Map<string, 'visiting' | 'done'>()
  const cyclic = new Set<string>()

  const visit = (id: string, stack: string[]): void => {
    const seen = state.get(id)
    if (seen === 'done')
      return
    if (seen === 'visiting') {
      for (const member of stack.slice(stack.indexOf(id)))
        cyclic.add(member)
      return
    }
    state.set(id, 'visiting')
    stack.push(id)
    for (const next of documents.get(id)?.relations.requires ?? []) {
      if (documents.has(next))
        visit(next, stack)
    }
    stack.pop()
    state.set(id, 'done')
  }

  for (const id of [...documents.keys()].sort(compareCodeUnits))
    visit(id, [])
  return [...cyclic].sort(compareCodeUnits)
}

/**
 * Builds and validates the document graph.
 *
 * The graph is derived entirely from the file tree and front matter. Neither the ledger nor
 * any cache is a fact source: deleting `.scratch/cache/` must rebuild an equivalent graph.
 *
 * @param root absolute repository root.
 * @returns the graph and every structural issue found.
 */
export async function buildGraph(root: string): Promise<KnowledgeGraph> {
  const loaded = await loadDocuments(root)
  const issues: DocumentIssue[] = [...loaded.issues]

  const documents = new Map<string, ContextDocument>()
  for (const document of loaded.documents) {
    const existing = documents.get(document.id)
    if (existing !== undefined) {
      issues.push({ code: 'DOCUMENT_ID_DUPLICATE', message: `Document ID "${document.id}" is declared by more than one file.`, path: document.path })
      continue
    }
    documents.set(document.id, document)
  }

  const domainIds = new Set(loaded.domains.map(domain => domain.id))
  for (const document of documents.values()) {
    if (!domainIds.has(document.domain))
      issues.push({ code: 'DOCUMENT_DOMAIN_UNKNOWN', message: `Document references unknown Domain "${document.domain}".`, path: document.path })

    for (const relation of ['requires', 'related', 'supersedes'] as const) {
      for (const target of document.relations[relation]) {
        if (relation !== 'supersedes' && !documents.has(target))
          issues.push({ code: 'DOCUMENT_RELATION_DANGLING', message: `Relation ${relation} references unknown document "${target}".`, path: document.path })
        if (target === document.id)
          issues.push({ code: 'DOCUMENT_RELATION_SELF', message: `Relation ${relation} must not reference the document itself.`, path: document.path })
      }
    }
  }

  for (const id of requiresCycles(documents)) {
    const document = documents.get(id)
    if (document !== undefined)
      issues.push({ code: 'DOCUMENT_REQUIRES_CYCLE', message: `Document "${id}" participates in a requires cycle.`, path: document.path })
  }

  const domains = new Map<string, DomainNode>()
  for (const domain of loaded.domains) {
    domains.set(domain.id, {
      id: domain.id,
      hasDomainDocument: domain.hasDomainDocument,
      documentIds: [...documents.values()]
        .filter(document => document.domain === domain.id)
        .map(document => document.id)
        .sort(compareCodeUnits),
    })
  }

  const codeIndex = new Map<string, string[]>()
  for (const document of [...documents.values()].sort((left, right) => compareCodeUnits(left.id, right.id))) {
    for (const path of document.code.paths) {
      const owners = codeIndex.get(path) ?? []
      owners.push(document.id)
      codeIndex.set(path, owners)
    }
  }

  return {
    documents,
    domains,
    codeIndex,
    issues: issues.sort((left, right) => compareCodeUnits(left.path + left.code, right.path + right.code)),
  }
}

/**
 * Expands a document set along `requires`.
 *
 * @param graph the document graph.
 * @param seeds starting document IDs.
 * @returns the seeds plus every transitive prerequisite, ordered.
 */
export function requiresClosure(graph: KnowledgeGraph, seeds: Iterable<string>): readonly string[] {
  const closure = new Set<string>()
  const pending = [...seeds]

  while (pending.length > 0) {
    const id = pending.pop()
    if (id === undefined || closure.has(id))
      continue
    closure.add(id)
    for (const next of graph.documents.get(id)?.relations.requires ?? []) {
      if (graph.documents.has(next))
        pending.push(next)
    }
  }
  return [...closure].sort(compareCodeUnits)
}
