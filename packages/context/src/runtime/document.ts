import type { SourceFile } from './repository.js'
import type { JsonObject, JsonValue } from './stable-json.js'
import { Buffer } from 'node:buffer'
import { parse as parseYaml } from 'yaml'
import { isRecord, PROTOCOL, sha256 } from './protocol.js'
import { aggregateSourceFingerprint, assertSourcePattern, MAX_FRONT_MATTER_BYTES, MAX_MARKDOWN_BYTES } from './repository.js'
import { compactJson, compareCodeUnits, stableJson } from './stable-json.js'

export const DOCUMENT_SCHEMA = 'plugydown.context.document/v1'
export const META_SCHEMA = 'plugydown.context.meta/v1'
export const FINGERPRINT_VERSION = '1'
export const TOOL_VERSION = '0.1.0'

export const DOCUMENT_KINDS = ['domain', 'architecture', 'decision', 'guide', 'reference', 'reflection'] as const
export type DocumentKind = typeof DOCUMENT_KINDS[number]

const DOMAIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DOCUMENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/
const FILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/
const SHA256 = /^[a-f0-9]{64}$/
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const FRONT_MATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/

export interface Relations {
  readonly requires: readonly string[]
  readonly related: readonly string[]
  readonly supersedes: readonly string[]
}

export interface ContextDocument {
  readonly schema: typeof DOCUMENT_SCHEMA
  readonly id: string
  readonly description: string
  readonly kind: DocumentKind
  readonly domain: string
  readonly relations: Relations
  readonly codePaths: readonly string[]
  readonly path: string
  readonly body: string
  readonly frontMatterBytes: number
  readonly bodyBytes: number
}

export interface KnowledgeIssue {
  readonly code: string
  readonly message: string
  readonly path: string
}

export type DocumentResult
  = | { readonly ok: true, readonly document: ContextDocument }
    | { readonly ok: false, readonly issues: readonly KnowledgeIssue[] }

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): readonly string[] {
  const known = new Set(allowed)
  return Object.keys(value).filter(key => !known.has(key)).sort(compareCodeUnits)
}

function parseNonEmptyList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || item.length === 0))
    return undefined
  if (new Set(value).size !== value.length)
    return undefined
  return [...value].sort(compareCodeUnits) as string[]
}

export function normalizeBody(body: string): string {
  const normalized = body
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n*$/, '')
  return `${normalized}\n`
}

function parseRelations(value: unknown, sourcePath: string, issues: KnowledgeIssue[]): Relations {
  const empty: Relations = { requires: [], related: [], supersedes: [] }
  if (value === undefined)
    return empty
  if (!isRecord(value) || Object.keys(value).length === 0) {
    issues.push({ code: 'DOCUMENT_RELATIONS_INVALID', message: 'relations must be a non-empty object.', path: sourcePath })
    return empty
  }
  for (const _key of unknownKeys(value, ['requires', 'related', 'supersedes']))
    issues.push({ code: 'DOCUMENT_RELATION_FIELD_UNKNOWN', message: 'relations contains an unknown field.', path: sourcePath })
  const parsed: Record<keyof Relations, readonly string[]> = { requires: [], related: [], supersedes: [] }
  for (const key of ['requires', 'related', 'supersedes'] as const) {
    if (value[key] === undefined)
      continue
    const list = parseNonEmptyList(value[key])
    if (list === undefined || list.some(id => !DOCUMENT_ID.test(id)))
      issues.push({ code: 'DOCUMENT_RELATION_INVALID', message: `${key} must contain unique valid Document IDs.`, path: sourcePath })
    else
      parsed[key] = list
  }
  return parsed
}

function parseCode(value: unknown, sourcePath: string, issues: KnowledgeIssue[]): readonly string[] {
  if (value === undefined)
    return []
  if (!isRecord(value) || Object.keys(value).length !== 1 || !('paths' in value)) {
    issues.push({ code: 'DOCUMENT_CODE_INVALID', message: 'code must contain only a non-empty paths list.', path: sourcePath })
    return []
  }
  const paths = parseNonEmptyList(value.paths)
  if (paths === undefined) {
    issues.push({ code: 'DOCUMENT_CODE_PATHS_INVALID', message: 'code.paths must contain unique non-empty patterns.', path: sourcePath })
    return []
  }
  for (const candidate of paths) {
    try {
      assertSourcePattern(candidate)
    }
    catch {
      issues.push({ code: 'DOCUMENT_CODE_PATH_UNSAFE', message: 'code.paths contains an unsafe source pattern.', path: sourcePath })
    }
  }
  return paths
}

/** Strictly parses a v1 formal Markdown document. */
export function parseDocument(sourcePath: string, source: string): DocumentResult {
  const issues: KnowledgeIssue[] = []
  if (Buffer.byteLength(source, 'utf8') > MAX_MARKDOWN_BYTES)
    return { ok: false, issues: [{ code: 'DOCUMENT_SIZE_EXCEEDED', message: 'The Markdown document exceeds 1 MiB.', path: sourcePath }] }
  const match = FRONT_MATTER.exec(source)
  if (match === null)
    return { ok: false, issues: [{ code: 'DOCUMENT_FRONT_MATTER_MISSING', message: 'A document must start with YAML front matter.', path: sourcePath }] }
  const frontMatter = match[1] as string
  const body = match[2] as string
  if (Buffer.byteLength(frontMatter, 'utf8') > MAX_FRONT_MATTER_BYTES)
    return { ok: false, issues: [{ code: 'DOCUMENT_FRONT_MATTER_SIZE_EXCEEDED', message: 'Document front matter exceeds 64 KiB.', path: sourcePath }] }

  let raw: unknown
  try {
    raw = parseYaml(frontMatter)
  }
  catch {
    return { ok: false, issues: [{ code: 'DOCUMENT_FRONT_MATTER_INVALID', message: 'Document front matter must be valid YAML.', path: sourcePath }] }
  }
  if (!isRecord(raw))
    return { ok: false, issues: [{ code: 'DOCUMENT_FRONT_MATTER_INVALID', message: 'Document front matter must be an object.', path: sourcePath }] }
  for (const _key of unknownKeys(raw, ['schema', 'id', 'description', 'kind', 'domain', 'relations', 'code']))
    issues.push({ code: 'DOCUMENT_FIELD_UNKNOWN', message: 'Document front matter contains an unknown field.', path: sourcePath })
  for (const key of ['schema', 'id', 'description', 'kind', 'domain']) {
    if (!(key in raw))
      issues.push({ code: 'DOCUMENT_FIELD_MISSING', message: `Document field "${key}" is required.`, path: sourcePath })
  }
  if (raw.schema !== DOCUMENT_SCHEMA)
    issues.push({ code: 'DOCUMENT_SCHEMA_INVALID', message: `Document schema must be ${DOCUMENT_SCHEMA}.`, path: sourcePath })
  if (typeof raw.id !== 'string' || !DOCUMENT_ID.test(raw.id))
    issues.push({ code: 'DOCUMENT_ID_INVALID', message: 'Document id must use dotted lowercase kebab-case.', path: sourcePath })
  if (typeof raw.description !== 'string' || raw.description.trim().length === 0)
    issues.push({ code: 'DOCUMENT_DESCRIPTION_INVALID', message: 'Document description must be non-empty.', path: sourcePath })
  if (typeof raw.kind !== 'string' || !(DOCUMENT_KINDS as readonly string[]).includes(raw.kind))
    issues.push({ code: 'DOCUMENT_KIND_INVALID', message: 'Document kind is unknown.', path: sourcePath })
  if (typeof raw.domain !== 'string' || !DOMAIN_ID.test(raw.domain))
    issues.push({ code: 'DOCUMENT_DOMAIN_INVALID', message: 'Document domain must use lowercase kebab-case.', path: sourcePath })
  if (body.trim().length === 0)
    issues.push({ code: 'DOCUMENT_BODY_EMPTY', message: 'Document body must be non-empty.', path: sourcePath })

  const relations = parseRelations(raw.relations, sourcePath, issues)
  const codePaths = parseCode(raw.code, sourcePath, issues)
  if (issues.length > 0)
    return { ok: false, issues }
  const normalized = normalizeBody(body)
  return {
    ok: true,
    document: {
      schema: DOCUMENT_SCHEMA,
      id: raw.id as string,
      description: (raw.description as string).trim(),
      kind: raw.kind as DocumentKind,
      domain: raw.domain as string,
      relations,
      codePaths,
      path: sourcePath,
      body: normalized,
      frontMatterBytes: Buffer.byteLength(frontMatter, 'utf8'),
      bodyBytes: Buffer.byteLength(normalized, 'utf8'),
    },
  }
}

/** Validates the canonical physical path, Domain, kind and stable ID relationship. */
export function placementIssues(document: ContextDocument): readonly KnowledgeIssue[] {
  const issues: KnowledgeIssue[] = []
  const parts = document.path.split('/')
  const domain = parts[1]
  if (parts[0] !== 'context' || domain === undefined || !DOMAIN_ID.test(domain) || document.domain !== domain)
    issues.push({ code: 'DOCUMENT_DOMAIN_MISMATCH', message: 'Document domain must equal its physical Domain directory.', path: document.path })
  const fileName = parts.at(-1) as string
  if (!FILE_NAME.test(fileName))
    issues.push({ code: 'DOCUMENT_FILENAME_INVALID', message: 'Document filenames must use lowercase kebab-case.', path: document.path })
  if (parts.length === 3) {
    if (fileName !== 'domain.md' || document.kind !== 'domain' || document.id !== domain || document.domain !== domain)
      issues.push({ code: 'DOCUMENT_PLACEMENT_INVALID', message: 'The Domain root may contain only its matching domain.md.', path: document.path })
  }
  else if (parts.length === 4) {
    const category = parts[2]
    const allowed = category === 'design'
      ? ['architecture', 'decision']
      : category === 'manual'
        ? ['guide', 'reference']
        : category === 'reflections'
          ? ['reflection']
          : []
    if (!allowed.includes(document.kind) || document.kind === 'domain')
      issues.push({ code: 'DOCUMENT_PLACEMENT_INVALID', message: 'Document kind does not match its category.', path: document.path })
    if (!document.id.startsWith(`${domain}.`))
      issues.push({ code: 'DOCUMENT_ID_DOMAIN_MISMATCH', message: 'A non-Domain Document id must begin with its Domain id.', path: document.path })
  }
  else {
    issues.push({ code: 'DOCUMENT_PLACEMENT_INVALID', message: 'Formal Documents must use the canonical two-level Domain layout.', path: document.path })
  }
  return issues
}

function frontMatterValue(document: ContextDocument): JsonObject {
  return {
    schema: document.schema,
    id: document.id,
    description: document.description,
    kind: document.kind,
    domain: document.domain,
    ...(document.relations.requires.length === 0 && document.relations.related.length === 0 && document.relations.supersedes.length === 0
      ? {}
      : {
          relations: {
            ...(document.relations.requires.length === 0 ? {} : { requires: [...document.relations.requires] }),
            ...(document.relations.related.length === 0 ? {} : { related: [...document.relations.related] }),
            ...(document.relations.supersedes.length === 0 ? {} : { supersedes: [...document.relations.supersedes] }),
          },
        }),
    ...(document.codePaths.length === 0 ? {} : { code: { paths: [...document.codePaths] } }),
  }
}

export function frontMatterFingerprint(document: ContextDocument): string {
  return sha256(compactJson(frontMatterValue(document)))
}

export function bodyFingerprint(document: ContextDocument): string {
  return sha256(document.body)
}

export function sourceFingerprint(document: ContextDocument, files: readonly SourceFile[]): string {
  return aggregateSourceFingerprint(document.codePaths, files)
}

export interface DocumentLedger {
  readonly frontMatterFingerprint: string
  readonly bodyFingerprint: string
  readonly sourceFingerprint: string
}

export interface Metrics {
  readonly documentCount: number
  readonly frontMatterBytes: number
  readonly bodyBytes: number
  readonly estimatedTokens: number
}

export interface ConvergenceBaseline extends Metrics {
  readonly source: 'init' | 'prune'
  readonly perDomain: Readonly<Record<string, Metrics>>
}

export interface Meta {
  readonly toolVersion: string
  readonly runtimeProtocol: typeof PROTOCOL
  readonly fingerprintVersion: typeof FINGERPRINT_VERSION
  readonly documents: Readonly<Record<string, DocumentLedger>>
  readonly repository?: { readonly baseline: { readonly revision: string, readonly sourceFingerprint: string } }
  readonly convergence?: ConvergenceBaseline
}

export type MetaResult
  = | { readonly ok: true, readonly meta: Meta }
    | { readonly ok: false, readonly issues: readonly KnowledgeIssue[] }

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function parseMetrics(value: unknown, exact = true): Metrics | undefined {
  if (!isRecord(value) || (exact && unknownKeys(value, ['documentCount', 'frontMatterBytes', 'bodyBytes', 'estimatedTokens']).length > 0)
    || !['documentCount', 'frontMatterBytes', 'bodyBytes', 'estimatedTokens'].every(key => validCount(value[key]))) {
    return undefined
  }
  return {
    documentCount: value.documentCount as number,
    frontMatterBytes: value.frontMatterBytes as number,
    bodyBytes: value.bodyBytes as number,
    estimatedTokens: value.estimatedTokens as number,
  }
}

/** Strictly parses the minimal v1 validity ledger. */
export function parseMeta(sourcePath: string, raw: unknown): MetaResult {
  const issues: KnowledgeIssue[] = []
  if (!isRecord(raw))
    return { ok: false, issues: [{ code: 'META_INVALID', message: 'Meta must be a JSON object.', path: sourcePath }] }
  for (const _key of unknownKeys(raw, ['$schema', 'toolVersion', 'runtimeProtocol', 'fingerprintVersion', 'documents', 'repository', 'convergence']))
    issues.push({ code: 'META_FIELD_UNKNOWN', message: 'Meta contains an unknown field.', path: sourcePath })
  for (const key of ['$schema', 'toolVersion', 'runtimeProtocol', 'fingerprintVersion', 'documents']) {
    if (!(key in raw))
      issues.push({ code: 'META_FIELD_MISSING', message: `Meta field "${key}" is required.`, path: sourcePath })
  }
  if (raw.$schema !== META_SCHEMA)
    issues.push({ code: 'META_SCHEMA_INVALID', message: `Meta schema must be ${META_SCHEMA}.`, path: sourcePath })
  if (typeof raw.toolVersion !== 'string' || raw.toolVersion.length === 0)
    issues.push({ code: 'META_TOOL_VERSION_INVALID', message: 'Meta toolVersion must be non-empty.', path: sourcePath })
  if (raw.runtimeProtocol !== PROTOCOL)
    issues.push({ code: 'META_RUNTIME_PROTOCOL_INVALID', message: `Meta runtimeProtocol must be ${PROTOCOL}.`, path: sourcePath })
  if (raw.fingerprintVersion !== FINGERPRINT_VERSION)
    issues.push({ code: 'META_FINGERPRINT_VERSION_INVALID', message: `Meta fingerprintVersion must be ${FINGERPRINT_VERSION}.`, path: sourcePath })

  const documents: Record<string, DocumentLedger> = {}
  if (!isRecord(raw.documents)) {
    issues.push({ code: 'META_DOCUMENTS_INVALID', message: 'Meta documents must be an object.', path: sourcePath })
  }
  else {
    for (const [id, value] of Object.entries(raw.documents).sort(([left], [right]) => compareCodeUnits(left, right))) {
      if (!DOCUMENT_ID.test(id) || !isRecord(value)
        || JSON.stringify(Object.keys(value).sort(compareCodeUnits)) !== JSON.stringify(['bodyFingerprint', 'frontMatterFingerprint', 'sourceFingerprint'])
        || ![value.frontMatterFingerprint, value.bodyFingerprint, value.sourceFingerprint].every(item => typeof item === 'string' && SHA256.test(item))) {
        issues.push({ code: 'META_DOCUMENT_INVALID', message: 'A Meta Document entry is invalid.', path: sourcePath })
      }
      else {
        documents[id] = {
          frontMatterFingerprint: value.frontMatterFingerprint as string,
          bodyFingerprint: value.bodyFingerprint as string,
          sourceFingerprint: value.sourceFingerprint as string,
        }
      }
    }
  }

  let repository: Meta['repository']
  if (raw.repository !== undefined) {
    if (!isRecord(raw.repository) || JSON.stringify(Object.keys(raw.repository)) !== JSON.stringify(['baseline']) || !isRecord(raw.repository.baseline)
      || JSON.stringify(Object.keys(raw.repository.baseline).sort(compareCodeUnits)) !== JSON.stringify(['revision', 'sourceFingerprint'])
      || typeof raw.repository.baseline.revision !== 'string' || !GIT_REVISION.test(raw.repository.baseline.revision)
      || typeof raw.repository.baseline.sourceFingerprint !== 'string' || !SHA256.test(raw.repository.baseline.sourceFingerprint)) {
      issues.push({ code: 'META_REPOSITORY_INVALID', message: 'Meta repository baseline is invalid.', path: sourcePath })
    }
    else {
      repository = { baseline: { revision: raw.repository.baseline.revision, sourceFingerprint: raw.repository.baseline.sourceFingerprint } }
    }
  }

  let convergence: ConvergenceBaseline | undefined
  if (raw.convergence !== undefined) {
    const value = raw.convergence
    const metric = parseMetrics(value, false)
    if (!isRecord(value)
      || JSON.stringify(Object.keys(value).sort(compareCodeUnits)) !== JSON.stringify(['bodyBytes', 'documentCount', 'estimatedTokens', 'frontMatterBytes', 'perDomain', 'source'])
      || (value.source !== 'init' && value.source !== 'prune')
      || metric === undefined
      || !isRecord(value.perDomain)) {
      issues.push({ code: 'META_CONVERGENCE_INVALID', message: 'Meta convergence baseline is invalid.', path: sourcePath })
    }
    else {
      const perDomain: Record<string, Metrics> = {}
      for (const [id, rawMetrics] of Object.entries(value.perDomain).sort(([left], [right]) => compareCodeUnits(left, right))) {
        const metrics = parseMetrics(rawMetrics)
        if (!DOMAIN_ID.test(id) || metrics === undefined)
          issues.push({ code: 'META_CONVERGENCE_DOMAIN_INVALID', message: 'A convergence Domain entry is invalid.', path: sourcePath })
        else
          perDomain[id] = metrics
      }
      convergence = { source: value.source, ...metric, perDomain }
    }
  }

  if (issues.length > 0)
    return { ok: false, issues }
  return {
    ok: true,
    meta: {
      toolVersion: raw.toolVersion as string,
      runtimeProtocol: PROTOCOL,
      fingerprintVersion: FINGERPRINT_VERSION,
      documents,
      ...(repository === undefined ? {} : { repository }),
      ...(convergence === undefined ? {} : { convergence }),
    },
  }
}

export function metaValue(meta: Meta): JsonObject {
  const documents: JsonObject = {}
  for (const [id, entry] of Object.entries(meta.documents).sort(([left], [right]) => compareCodeUnits(left, right)))
    documents[id] = { ...entry }
  const perDomain: JsonObject = {}
  if (meta.convergence !== undefined) {
    for (const [id, metrics] of Object.entries(meta.convergence.perDomain).sort(([left], [right]) => compareCodeUnits(left, right)))
      perDomain[id] = { ...metrics }
  }
  return {
    $schema: META_SCHEMA,
    toolVersion: meta.toolVersion,
    runtimeProtocol: PROTOCOL,
    fingerprintVersion: FINGERPRINT_VERSION,
    documents,
    ...(meta.repository === undefined ? {} : { repository: { baseline: { ...meta.repository.baseline } } }),
    ...(meta.convergence === undefined
      ? {}
      : {
          convergence: {
            source: meta.convergence.source,
            documentCount: meta.convergence.documentCount,
            frontMatterBytes: meta.convergence.frontMatterBytes,
            bodyBytes: meta.convergence.bodyBytes,
            estimatedTokens: meta.convergence.estimatedTokens,
            perDomain,
          },
        }),
  }
}

export function serializeMeta(meta: Meta): string {
  return stableJson(metaValue(meta) as JsonValue)
}
