import type { JsonObject } from './types.js'
import { META_SCHEMA } from './constants.js'
import { FINGERPRINT_VERSION } from './fingerprint.js'

/** Per-document validity record. */
export interface DocumentLedgerEntry {
  readonly frontMatterFingerprint: string
  readonly bodyFingerprint: string
  readonly sourceFingerprint?: string
  readonly validatedSourceState?: string
  readonly status: 'valid' | 'stale' | 'unverified'
}

/** Repository-wide validated baseline. */
export interface RepositoryBaseline {
  readonly revision: string
  readonly treeFingerprint: string
  readonly verifiedAt?: string
}

/** Size snapshot recorded by the last successful init or prune. */
export interface ConvergenceBaseline {
  readonly source: 'init' | 'prune'
  readonly documentCount: number
  readonly frontMatterBytes: number
  readonly bodyBytes: number
  readonly estimatedTokens: number
  readonly perDomain: Readonly<Record<string, number>>
}

/** The historical validity ledger. */
export interface Ledger {
  readonly toolVersion: string
  readonly fingerprintVersion: string
  readonly repository?: { readonly baseline?: RepositoryBaseline }
  readonly documents: Readonly<Record<string, DocumentLedgerEntry>>
  readonly convergence?: ConvergenceBaseline
}

/**
 * Fields the ledger must never carry.
 *
 * Each one is either derivable from the current tree, or session state that would make the
 * ledger a second, competing source of truth.
 */
const FORBIDDEN = new Set([
  'paths',
  'catalog',
  'relations',
  'graph',
  'index',
  'backlinks',
  'body',
  'bodies',
  'markdown',
  'session',
  'task',
  'compact',
  'state',
  'investigations',
  'feedback',
  'plan',
  'candidate',
  'journal',
  'tickets',
  'reports',
])

/** Recognised top-level ledger fields. */
const ALLOWED = new Set(['$schema', 'toolVersion', 'fingerprintVersion', 'repository', 'documents', 'convergence'])

/** One structural problem found in the ledger. */
export interface LedgerIssue {
  readonly code: string
  readonly message: string
}

/** Outcome of reading a ledger. */
export type LedgerResult
  = | { readonly ok: true, readonly ledger: Ledger }
    | { readonly ok: false, readonly issues: readonly LedgerIssue[] }

/** @returns whether a value is a plain object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parses and validates a ledger document.
 *
 * @param raw parsed JSON.
 * @returns the ledger, or the issues that prevented it.
 */
export function parseLedger(raw: unknown): LedgerResult {
  const issues: LedgerIssue[] = []
  const fail = (code: string, message: string): void => void issues.push({ code, message })

  if (!isObject(raw))
    return { ok: false, issues: [{ code: 'META_SHAPE_INVALID', message: 'The ledger must be a JSON object.' }] }
  if (raw.$schema !== META_SCHEMA)
    fail('META_SCHEMA_INVALID', `The ledger must declare $schema "${META_SCHEMA}".`)

  for (const field of Object.keys(raw)) {
    if (FORBIDDEN.has(field))
      fail('META_FIELD_FORBIDDEN', `The ledger must not persist "${field}".`)
    else if (!ALLOWED.has(field))
      fail('META_FIELD_UNKNOWN', `Unknown ledger field "${field}".`)
  }

  if (typeof raw.toolVersion !== 'string' || raw.toolVersion.length === 0)
    fail('META_TOOL_VERSION_INVALID', 'The ledger must record a tool version.')
  if (typeof raw.fingerprintVersion !== 'string' || raw.fingerprintVersion.length === 0)
    fail('META_FINGERPRINT_VERSION_INVALID', 'The ledger must record a fingerprint version.')

  const documents: Record<string, DocumentLedgerEntry> = {}
  if (!isObject(raw.documents)) {
    fail('META_DOCUMENTS_INVALID', 'The ledger must record a documents map.')
  }
  else {
    for (const [id, value] of Object.entries(raw.documents)) {
      if (id.includes('/')) {
        fail('META_DOCUMENT_KEY_INVALID', `Ledger key "${id}" looks like a path; keys must be stable document IDs.`)
        continue
      }
      if (!isObject(value)) {
        fail('META_DOCUMENT_INVALID', `Ledger entry "${id}" must be an object.`)
        continue
      }
      const status = value.status
      documents[id] = {
        frontMatterFingerprint: typeof value.frontMatterFingerprint === 'string' ? value.frontMatterFingerprint : '',
        bodyFingerprint: typeof value.bodyFingerprint === 'string' ? value.bodyFingerprint : '',
        ...(typeof value.sourceFingerprint === 'string' ? { sourceFingerprint: value.sourceFingerprint } : {}),
        ...(typeof value.validatedSourceState === 'string' ? { validatedSourceState: value.validatedSourceState } : {}),
        status: status === 'valid' || status === 'stale' || status === 'unverified' ? status : 'unverified',
      }
    }
  }

  if (issues.length > 0)
    return { ok: false, issues }

  const repository = isObject(raw.repository) && isObject(raw.repository.baseline)
    ? {
        baseline: {
          revision: String(raw.repository.baseline.revision ?? ''),
          treeFingerprint: String(raw.repository.baseline.treeFingerprint ?? ''),
          ...(typeof raw.repository.baseline.verifiedAt === 'string' ? { verifiedAt: raw.repository.baseline.verifiedAt } : {}),
        },
      }
    : undefined

  const convergence = isObject(raw.convergence)
    ? {
        source: raw.convergence.source === 'prune' ? 'prune' as const : 'init' as const,
        documentCount: Number(raw.convergence.documentCount ?? 0),
        frontMatterBytes: Number(raw.convergence.frontMatterBytes ?? 0),
        bodyBytes: Number(raw.convergence.bodyBytes ?? 0),
        estimatedTokens: Number(raw.convergence.estimatedTokens ?? 0),
        perDomain: isObject(raw.convergence.perDomain) ? raw.convergence.perDomain as Record<string, number> : {},
      }
    : undefined

  return {
    ok: true,
    ledger: {
      toolVersion: raw.toolVersion as string,
      fingerprintVersion: raw.fingerprintVersion as string,
      ...(repository === undefined ? {} : { repository }),
      documents,
      ...(convergence === undefined ? {} : { convergence }),
    },
  }
}

/** @returns an empty ledger for a freshly initialized repository. */
export function emptyLedger(toolVersion: string): Ledger {
  return { toolVersion, fingerprintVersion: FINGERPRINT_VERSION, documents: {} }
}

/**
 * Serializes a ledger to its JSON shape.
 *
 * @param ledger the ledger to serialize.
 * @returns a JSON object ready for deterministic serialization.
 */
export function ledgerToJson(ledger: Ledger): JsonObject {
  const documents: JsonObject = {}
  for (const [id, entry] of Object.entries(ledger.documents)) {
    documents[id] = {
      frontMatterFingerprint: entry.frontMatterFingerprint,
      bodyFingerprint: entry.bodyFingerprint,
      ...(entry.sourceFingerprint === undefined ? {} : { sourceFingerprint: entry.sourceFingerprint }),
      ...(entry.validatedSourceState === undefined ? {} : { validatedSourceState: entry.validatedSourceState }),
      status: entry.status,
    }
  }

  return {
    $schema: META_SCHEMA,
    toolVersion: ledger.toolVersion,
    fingerprintVersion: ledger.fingerprintVersion,
    ...(ledger.repository?.baseline === undefined
      ? {}
      : {
          repository: {
            baseline: {
              revision: ledger.repository.baseline.revision,
              treeFingerprint: ledger.repository.baseline.treeFingerprint,
              ...(ledger.repository.baseline.verifiedAt === undefined ? {} : { verifiedAt: ledger.repository.baseline.verifiedAt }),
            },
          },
        }),
    documents,
    ...(ledger.convergence === undefined
      ? {}
      : {
          convergence: {
            source: ledger.convergence.source,
            documentCount: ledger.convergence.documentCount,
            frontMatterBytes: ledger.convergence.frontMatterBytes,
            bodyBytes: ledger.convergence.bodyBytes,
            estimatedTokens: ledger.convergence.estimatedTokens,
            perDomain: { ...ledger.convergence.perDomain },
          },
        }),
  }
}
