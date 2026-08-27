import type { ContextDocument } from './document.js'
import { createHash } from 'node:crypto'
import { stableJson } from './stable-json.js'

/**
 * Fingerprint algorithm version.
 *
 * Any change to normalization or hashing must bump this. The ledger records it so a stored
 * fingerprint is never compared against one computed by different rules.
 */
export const FINGERPRINT_VERSION = '1'

/** @returns the hex SHA-256 of a string. */
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Normalizes body text without touching its meaning.
 *
 * Only encoding-level noise is removed — a BOM, CRLF line endings, and trailing blank space.
 * Rewriting anything semantic would make the fingerprint disagree with what a reader sees.
 *
 * @param body raw body text.
 * @returns normalized body text.
 */
export function normalizeBody(body: string): string {
  return body
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n+$/, '\n')
}

/**
 * Fingerprints the semantic content of front matter.
 *
 * The parsed fields are re-serialized deterministically rather than hashed as text, so
 * reordering keys or reflowing YAML does not invalidate a document.
 *
 * @param document the parsed document.
 * @returns the front matter fingerprint.
 */
export function frontMatterFingerprint(document: ContextDocument): string {
  return sha256(stableJson({
    version: FINGERPRINT_VERSION,
    id: document.id,
    description: document.description,
    kind: document.kind,
    domain: document.domain,
    relations: {
      requires: [...document.relations.requires].sort(),
      related: [...document.relations.related].sort(),
      supersedes: [...document.relations.supersedes].sort(),
    },
    code: {
      paths: [...document.code.paths].sort(),
      symbols: [...document.code.symbols].sort(),
    },
  }))
}

/**
 * Fingerprints a document body.
 *
 * The path is deliberately excluded: a document keeps its identity when it moves, and only
 * its ID changing counts as a delete plus a create.
 *
 * @param document the parsed document.
 * @returns the body fingerprint.
 */
export function bodyFingerprint(document: ContextDocument): string {
  return sha256(`${FINGERPRINT_VERSION}\n${normalizeBody(document.body)}`)
}

/** One resolved source file contributing to a document's source fingerprint. */
export interface SourceSample {
  readonly path: string
  readonly contentHash: string
}

/**
 * Fingerprints the source a document claims to describe.
 *
 * The declaration itself is hashed alongside the resolved contents, so narrowing or widening
 * `code.paths` is visible even when no file changed.
 *
 * @param declared the document's declared paths and globs.
 * @param resolved the files those declarations currently resolve to.
 * @returns the source fingerprint.
 */
export function sourceFingerprint(declared: readonly string[], resolved: readonly SourceSample[]): string {
  return sha256(stableJson({
    version: FINGERPRINT_VERSION,
    declared: [...declared].sort(),
    resolved: [...resolved]
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
      .map(sample => ({ path: sample.path, contentHash: sample.contentHash })),
  }))
}

/** @returns the content hash of one source file. */
export function contentHash(contents: string): string {
  return sha256(contents)
}
