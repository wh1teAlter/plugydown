import type { DocumentKind } from './types.js'
import { parse as parseYaml } from 'yaml'
import { DOCUMENT_KINDS, DOCUMENT_SCHEMA, DOMAIN_CATEGORIES } from './constants.js'
import { assertBoundedGlob, assertSafeRelativePath } from './repository.js'

/** Lowercase kebab-case, optionally dotted, used for Domain and document IDs. */
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/

/** A single Domain segment, which may not contain a dot. */
const DOMAIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Front matter delimiters, tolerating a leading BOM and CRLF line endings. */
const FRONT_MATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/** Fields that may never be persisted in front matter. */
const FORBIDDEN = new Set([
  'commit',
  'hash',
  'validated_at',
  'validatedAt',
  'fingerprint',
  'fingerprints',
  'catalog',
  'paths',
  'backlinks',
  'batch',
  'cursor',
  'state',
  'session',
  'task',
  'score',
  'plan',
  'log',
])

/** Recognised top-level front matter fields. */
const ALLOWED = new Set(['schema', 'id', 'description', 'kind', 'domain', 'relations', 'code', 'loading'])

/** Declared relations between documents. */
export interface Relations {
  readonly requires: readonly string[]
  readonly related: readonly string[]
  readonly supersedes: readonly string[]
}

/** Declared association with source code. */
export interface CodeLinks {
  readonly paths: readonly string[]
  readonly symbols: readonly string[]
}

/** A parsed and validated formal document. */
export interface ContextDocument {
  readonly id: string
  readonly description: string
  readonly kind: DocumentKind
  readonly domain: string
  readonly relations: Relations
  readonly code: CodeLinks
  readonly path: string
  readonly frontMatter: string
  readonly body: string
}

/** One structural problem found while parsing or validating a document. */
export interface DocumentIssue {
  readonly code: string
  readonly message: string
  readonly path: string
}

/** Outcome of parsing one document. */
export type ParseResult
  = | { readonly ok: true, readonly document: ContextDocument }
    | { readonly ok: false, readonly issues: readonly DocumentIssue[] }

/** @returns a unique, ordered list of non-empty strings, or undefined when invalid. */
function stringList(value: unknown): readonly string[] | undefined {
  if (value === undefined)
    return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0))
    return undefined
  const list = value as string[]
  return new Set(list).size === list.length ? [...list] : undefined
}

/**
 * Splits a Markdown file into its front matter and body.
 *
 * @param source the raw file contents.
 * @returns the two halves, or undefined when the file has no front matter block.
 */
export function splitFrontMatter(source: string): { readonly frontMatter: string, readonly body: string } | undefined {
  const match = FRONT_MATTER.exec(source)
  if (match === null)
    return undefined
  return { frontMatter: match[1] ?? '', body: match[2] ?? '' }
}

/**
 * Parses and validates one formal document.
 *
 * Validation is structural only. Whether the content is *true* is a semantic question that
 * belongs to the roles, not to the runtime.
 *
 * @param path repository-relative path of the document.
 * @param source raw file contents.
 * @returns the parsed document, or the issues that prevented it.
 */
export function parseDocument(path: string, source: string): ParseResult {
  const issues: DocumentIssue[] = []
  const fail = (code: string, message: string): void => void issues.push({ code, message, path })

  const split = splitFrontMatter(source)
  if (split === undefined)
    return { ok: false, issues: [{ code: 'DOCUMENT_FRONT_MATTER_MISSING', message: 'A document must begin with a YAML front matter block.', path }] }

  let parsed: unknown
  try {
    parsed = parseYaml(split.frontMatter) ?? {}
  }
  catch {
    return { ok: false, issues: [{ code: 'DOCUMENT_FRONT_MATTER_INVALID', message: 'Front matter must be valid YAML.', path }] }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return { ok: false, issues: [{ code: 'DOCUMENT_FRONT_MATTER_INVALID', message: 'Front matter must be a mapping.', path }] }

  const fields = parsed as Record<string, unknown>
  if (split.body.trim().length === 0)
    fail('DOCUMENT_BODY_EMPTY', 'A document must have a non-empty body.')

  for (const field of Object.keys(fields)) {
    if (FORBIDDEN.has(field))
      fail('DOCUMENT_FIELD_FORBIDDEN', `Front matter must not persist "${field}".`)
    else if (!ALLOWED.has(field))
      fail('DOCUMENT_FIELD_UNKNOWN', `Unknown front matter field "${field}".`)
  }

  if (fields.schema !== DOCUMENT_SCHEMA)
    fail('DOCUMENT_SCHEMA_INVALID', `Front matter must declare schema "${DOCUMENT_SCHEMA}".`)
  if (typeof fields.id !== 'string' || !ID.test(fields.id))
    fail('DOCUMENT_ID_INVALID', 'Front matter id must be dotted lowercase kebab-case.')
  if (typeof fields.description !== 'string' || fields.description.trim().length === 0)
    fail('DOCUMENT_DESCRIPTION_INVALID', 'Front matter description must be a non-empty string.')
  if (typeof fields.kind !== 'string' || !(DOCUMENT_KINDS as readonly string[]).includes(fields.kind))
    fail('DOCUMENT_KIND_INVALID', 'Front matter kind must be a known document kind.')
  if (typeof fields.domain !== 'string' || !DOMAIN_ID.test(fields.domain))
    fail('DOCUMENT_DOMAIN_INVALID', 'Front matter domain must be lowercase kebab-case.')

  const relations = fields.relations
  const relationLists: Record<string, readonly string[]> = { requires: [], related: [], supersedes: [] }
  if (relations !== undefined) {
    if (typeof relations !== 'object' || relations === null || Array.isArray(relations)) {
      fail('DOCUMENT_RELATIONS_INVALID', 'Front matter relations must be a mapping.')
    }
    else {
      for (const [name, value] of Object.entries(relations as Record<string, unknown>)) {
        if (!(name in relationLists)) {
          fail('DOCUMENT_RELATIONS_INVALID', `Unknown relation "${name}".`)
          continue
        }
        const list = stringList(value)
        if (list === undefined)
          fail('DOCUMENT_RELATIONS_INVALID', `Relation "${name}" must contain unique non-empty IDs.`)
        else
          relationLists[name] = list
      }
    }
  }

  const code = fields.code
  let paths: readonly string[] = []
  let symbols: readonly string[] = []
  if (code !== undefined) {
    if (typeof code !== 'object' || code === null || Array.isArray(code)) {
      fail('DOCUMENT_CODE_INVALID', 'Front matter code must be a mapping.')
    }
    else {
      const declared = code as Record<string, unknown>
      for (const field of Object.keys(declared)) {
        if (field !== 'paths' && field !== 'symbols')
          fail('DOCUMENT_CODE_INVALID', `Unknown code field "${field}".`)
      }
      const declaredPaths = stringList(declared.paths)
      const declaredSymbols = stringList(declared.symbols)
      if (declaredPaths === undefined)
        fail('DOCUMENT_CODE_INVALID', 'code.paths must contain unique non-empty strings.')
      else
        paths = declaredPaths
      if (declaredSymbols === undefined)
        fail('DOCUMENT_CODE_INVALID', 'code.symbols must contain unique non-empty strings.')
      else
        symbols = declaredSymbols

      for (const candidate of paths) {
        try {
          if (/[*?[\]{}]/.test(candidate))
            assertBoundedGlob(candidate)
          else
            assertSafeRelativePath(candidate)
        }
        catch (error) {
          fail('DOCUMENT_CODE_PATH_UNSAFE', `code.paths entry "${candidate}" is unsafe: ${(error as Error).message}`)
        }
      }
    }
  }

  if (issues.length > 0)
    return { ok: false, issues }

  return {
    ok: true,
    document: {
      id: fields.id as string,
      description: fields.description as string,
      kind: fields.kind as DocumentKind,
      domain: fields.domain as string,
      relations: {
        requires: relationLists.requires ?? [],
        related: relationLists.related ?? [],
        supersedes: relationLists.supersedes ?? [],
      },
      code: { paths, symbols },
      path,
      frontMatter: split.frontMatter,
      body: split.body,
    },
  }
}

/**
 * Checks that a document's kind is legal for the directory it sits in.
 *
 * @param document the parsed document.
 * @param category the Domain sub-directory, or undefined for `domain.md`.
 * @returns the issue found, or undefined when the placement is legal.
 */
export function checkPlacement(document: ContextDocument, category: string | undefined): DocumentIssue | undefined {
  if (category === undefined) {
    return document.kind === 'domain'
      ? undefined
      : { code: 'DOCUMENT_PLACEMENT_INVALID', message: 'Only a domain document may sit at the Domain root.', path: document.path }
  }

  const allowed = (DOMAIN_CATEGORIES as Record<string, readonly string[]>)[category]
  if (allowed === undefined)
    return { code: 'DOCUMENT_PLACEMENT_INVALID', message: `Unknown Domain category "${category}".`, path: document.path }
  if (!allowed.includes(document.kind))
    return { code: 'DOCUMENT_PLACEMENT_INVALID', message: `A ${document.kind} document may not sit in "${category}".`, path: document.path }
  return undefined
}
