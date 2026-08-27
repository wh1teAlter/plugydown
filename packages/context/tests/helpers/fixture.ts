import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** A document to materialize inside a fixture repository. */
export interface FixtureDocument {
  readonly domain: string
  /** Front matter domain, when it must differ from the directory it sits in. */
  readonly declaredDomain?: string
  readonly category?: 'design' | 'manual' | 'reflections'
  readonly name: string
  readonly id: string
  readonly kind: string
  readonly description?: string
  readonly requires?: readonly string[]
  readonly related?: readonly string[]
  readonly codePaths?: readonly string[]
  readonly body?: string
}

/** @returns the Markdown source for a fixture document. */
export function documentSource(document: FixtureDocument): string {
  const lines = [
    'schema: plugydown.context.document/v1',
    `id: ${document.id}`,
    `description: ${document.description ?? 'Fixture document.'}`,
    `kind: ${document.kind}`,
    `domain: ${document.declaredDomain ?? document.domain}`,
  ]

  if (document.requires !== undefined || document.related !== undefined) {
    lines.push('relations:')
    if (document.requires !== undefined) {
      lines.push('  requires:')
      document.requires.forEach(id => lines.push(`    - ${id}`))
    }
    if (document.related !== undefined) {
      lines.push('  related:')
      document.related.forEach(id => lines.push(`    - ${id}`))
    }
  }
  if (document.codePaths !== undefined) {
    lines.push('code:')
    lines.push('  paths:')
    document.codePaths.forEach(item => lines.push(`    - ${item}`))
  }

  return `---\n${lines.join('\n')}\n---\n\n${document.body ?? `# ${document.id}\n\nFixture body.\n`}`
}

/**
 * Creates a temporary repository containing the given documents.
 *
 * @param documents documents to materialize.
 * @returns the absolute repository root.
 */
export async function createFixture(documents: readonly FixtureDocument[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'plugydown-fixture-'))

  for (const document of documents) {
    const directory = document.category === undefined
      ? path.join(root, 'context', document.domain)
      : path.join(root, 'context', document.domain, document.category)
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, document.name), documentSource(document))
  }
  return root
}

/** Creates an empty temporary repository for command-workflow integration tests. */
export async function createEmptyFixture(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), 'plugydown-fixture-'))
}

/** Writes a ledger into a fixture repository. */
export async function writeLedger(root: string, ledger: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(root, 'context'), { recursive: true })
  await fs.writeFile(path.join(root, 'context', 'meta.json'), JSON.stringify({
    $schema: 'plugydown.context.meta/v1',
    toolVersion: '0.1.0',
    fingerprintVersion: '1',
    documents: {},
    ...ledger,
  }))
}

/** Removes a fixture repository. */
export async function removeFixture(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true })
}
