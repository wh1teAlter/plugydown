import type { JsonObject } from './types.js'
import { DOMAIN_CATEGORIES, KNOWLEDGE_ROOT, META_PATH, META_SCHEMA } from './constants.js'
import { listRepositoryDirectory, readRepositoryFile, repositoryPathExists } from './repository.js'

/** Recognised Domain sub-directory names. */
const CATEGORIES = new Set(Object.keys(DOMAIN_CATEGORIES))

/** What the ledger looks like from the outside, before any schema work. */
interface LedgerState {
  readonly present: boolean
  readonly recognized: boolean
  readonly documentCount?: number
}

/** One Domain as it appears on disk, before the graph is built. */
interface DomainState {
  readonly id: string
  readonly hasDomainDocument: boolean
  readonly categories: readonly string[]
  readonly documentCount: number
}

/**
 * Reads the ledger far enough to say whether it is recognisable.
 *
 * Parsing deliberately stops at the schema constant. Deciding whether the ledger is
 * correct* is the graph's job; this only answers whether the runtime is looking at its own
 * data or at something it should not touch.
 *
 * @param root absolute repository root.
 * @returns the ledger's externally visible state.
 */
async function readLedger(root: string): Promise<LedgerState> {
  if (!await repositoryPathExists(root, META_PATH))
    return { present: false, recognized: false }

  try {
    const parsed: unknown = JSON.parse(await readRepositoryFile(root, META_PATH))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return { present: true, recognized: false }

    const ledger = parsed as Record<string, unknown>
    if (ledger.$schema !== META_SCHEMA)
      return { present: true, recognized: false }

    const documents = ledger.documents
    const documentCount = typeof documents === 'object' && documents !== null && !Array.isArray(documents)
      ? Object.keys(documents).length
      : 0
    return { present: true, recognized: true, documentCount }
  }
  catch {
    return { present: true, recognized: false }
  }
}

/**
 * Describes one Domain directory.
 *
 * @param root absolute repository root.
 * @param id the Domain directory name.
 * @returns the Domain's on-disk shape.
 */
async function readDomain(root: string, id: string): Promise<DomainState> {
  const entries = await listRepositoryDirectory(root, `${KNOWLEDGE_ROOT}/${id}`)
  const categories = entries
    .filter(entry => entry.kind === 'directory' && CATEGORIES.has(entry.name))
    .map(entry => entry.name)

  let documentCount = entries.filter(entry => entry.kind === 'file' && entry.name.endsWith('.md')).length
  for (const category of categories) {
    const nested = await listRepositoryDirectory(root, `${KNOWLEDGE_ROOT}/${id}/${category}`)
    documentCount += nested.filter(entry => entry.kind === 'file' && entry.name.endsWith('.md')).length
  }

  return {
    id,
    hasDomainDocument: entries.some(entry => entry.kind === 'file' && entry.name === 'domain.md'),
    categories,
    documentCount,
  }
}

/**
 * Takes a safe inventory of the formal knowledge tree.
 *
 * This is a shape survey, not a validation pass: it reports what exists so a caller can
 * decide whether to initialize, update, or read. Structural correctness belongs to the graph.
 *
 * @param root absolute repository root.
 * @returns the inventory payload.
 */
export async function inspectRepository(root: string): Promise<JsonObject> {
  if (!await repositoryPathExists(root, KNOWLEDGE_ROOT)) {
    return {
      knowledgeRoot: KNOWLEDGE_ROOT,
      present: false,
      ledger: { present: false, recognized: false },
      domains: [],
    }
  }

  const entries = await listRepositoryDirectory(root, KNOWLEDGE_ROOT)
  const domains: JsonObject[] = []
  for (const entry of entries) {
    if (entry.kind !== 'directory')
      continue
    const domain = await readDomain(root, entry.name)
    domains.push({
      id: domain.id,
      hasDomainDocument: domain.hasDomainDocument,
      categories: [...domain.categories],
      documentCount: domain.documentCount,
    })
  }

  const ledger = await readLedger(root)
  return {
    knowledgeRoot: KNOWLEDGE_ROOT,
    present: true,
    ledger: {
      present: ledger.present,
      recognized: ledger.recognized,
      ...(ledger.documentCount === undefined ? {} : { documentCount: ledger.documentCount }),
    },
    domains,
  }
}
