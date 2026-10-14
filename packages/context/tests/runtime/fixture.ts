import type { RuntimeResponse, TransactionAction } from '../../src/runtime/protocol.js'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { handleRequest } from '../../src/runtime/handler.js'

export const PROTOCOL = 'plugydown.context.runtime/v1'
export const REVISION_A = 'a'.repeat(40)
export const REVISION_C = 'c'.repeat(40)

export interface FixtureDocument {
  readonly relativePath: string
  readonly id: string
  readonly description?: string
  readonly kind: 'domain' | 'architecture' | 'decision' | 'guide' | 'reference' | 'reflection'
  readonly domain: string
  readonly relations?: {
    readonly requires?: readonly string[]
    readonly related?: readonly string[]
    readonly supersedes?: readonly string[]
  }
  readonly codePaths?: readonly string[]
  readonly body?: string
}

export const SERVICE_DOMAIN: FixtureDocument = {
  relativePath: 'service/domain.md',
  id: 'service',
  kind: 'domain',
  domain: 'service',
  description: 'Service Domain boundaries and navigation.',
  codePaths: ['src/service.ts'],
  body: '# Service\n\nService behavior and boundaries.\n',
}

export const SERVICE_GUIDE: FixtureDocument = {
  relativePath: 'service/manual/retry.md',
  id: 'service.retry',
  kind: 'guide',
  domain: 'service',
  description: 'Retry behavior and constraints.',
  relations: { requires: ['service'] },
  codePaths: ['src/retry.ts'],
  body: '# Retry\n\nRetry only transient failures.\n',
}

export const CLIENT_DOMAIN: FixtureDocument = {
  relativePath: 'client/domain.md',
  id: 'client',
  kind: 'domain',
  domain: 'client',
  description: 'Client Domain boundaries and navigation.',
  codePaths: ['src/client.ts'],
  body: '# Client\n\nClient behavior and boundaries.\n',
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(sortValue)
  if (value === null || typeof value !== 'object')
    return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, sortValue(item)]))
}

function compact(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeBody(body: string): string {
  return `${body.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n*$/, '')}\n`
}

function metadata(document: FixtureDocument): Record<string, unknown> {
  const relations = document.relations === undefined
    ? undefined
    : Object.fromEntries(Object.entries(document.relations)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, [...(value as readonly string[])].sort()]))
  return {
    schema: 'plugydown.context.document/v1',
    id: document.id,
    description: document.description ?? `Description for ${document.id}.`,
    kind: document.kind,
    domain: document.domain,
    ...(relations === undefined || Object.keys(relations).length === 0 ? {} : { relations }),
    ...(document.codePaths === undefined ? {} : { code: { paths: [...document.codePaths].sort() } }),
  }
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

export function documentSource(document: FixtureDocument, lineEnding = '\n'): string {
  const fields = metadata(document)
  const lines = [
    '---',
    `schema: ${String(fields.schema)}`,
    `id: ${String(fields.id)}`,
    `description: ${yamlString(String(fields.description))}`,
    `kind: ${String(fields.kind)}`,
    `domain: ${String(fields.domain)}`,
  ]
  if (document.relations !== undefined) {
    lines.push('relations:')
    for (const key of ['requires', 'related', 'supersedes'] as const) {
      const values = document.relations[key]
      if (values === undefined)
        continue
      lines.push(`  ${key}:`)
      values.forEach(value => lines.push(`    - ${value}`))
    }
  }
  if (document.codePaths !== undefined) {
    lines.push('code:', '  paths:')
    document.codePaths.forEach(value => lines.push(`    - ${yamlString(value)}`))
  }
  lines.push('---', normalizeBody(document.body ?? `# ${document.id}\n\nBody for ${document.id}.\n`).replace(/\n$/, ''))
  return lines.join(lineEnding) + lineEnding
}

function globMatches(pattern: string, candidate: string): boolean {
  const patterns = pattern.split('/')
  const candidates = candidate.split('/')
  const segment = (source: string, value: string): boolean => new RegExp(`^${source.split('*').map(part => part.replace(/[|{}()[\]^$+?.]/g, '\\$&')).join('.*')}$`).test(value)
  const visit = (left: number, right: number): boolean => {
    if (left === patterns.length)
      return right === candidates.length
    if (patterns[left] === '**')
      return visit(left + 1, right) || (right < candidates.length && visit(left, right + 1))
    return right < candidates.length && segment(patterns[left] as string, candidates[right] as string) && visit(left + 1, right + 1)
  }
  return visit(0, 0)
}

async function allFiles(root: string, relative: string): Promise<readonly string[]> {
  const result: string[] = []
  const visit = async (current: string): Promise<void> => {
    // A fixture may declare a glob before its anchor exists; source health is not formal Meta validity.
    const entries = await fs.readdir(path.join(root, current), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const next = `${current}/${entry.name}`
      // Mirrors the Runtime: source expansion never enters node_modules at any depth.
      if (entry.isDirectory() && entry.name !== 'node_modules')
        await visit(next)
      else if (entry.isFile())
        result.push(next)
    }
  }
  await visit(relative)
  return result.sort()
}

async function sourceFingerprint(root: string, declarations: readonly string[]): Promise<string> {
  // The Runtime expands a glob under its first segment, so the fixture must walk the same anchors.
  const anchors = [...new Set(declarations.filter(item => item.includes('*')).map(item => item.split('/')[0] as string))]
  const repositoryFiles = (await Promise.all(anchors.map(anchor => allFiles(root, anchor)))).flat()
  const resolved = new Set<string>()
  for (const declaration of declarations) {
    if (declaration.includes('*'))
      repositoryFiles.filter(candidate => globMatches(declaration, candidate)).forEach(candidate => resolved.add(candidate))
    else
      resolved.add(declaration)
  }
  return hash(compact({
    declarations: [...declarations].sort(),
    files: await Promise.all([...resolved].sort().map(async (candidate) => {
      let contentHash = '0'.repeat(64)
      try {
        contentHash = hash(await fs.readFile(path.join(root, candidate)))
      }
      catch {
        // Fixtures may intentionally declare missing/special sources; source health is not formal Meta validity.
      }
      return { path: candidate, contentHash }
    })),
  }))
}

export async function writeMeta(
  root: string,
  documents: readonly FixtureDocument[],
  options: { readonly baselineRevision?: string, readonly convergence?: boolean } = {},
): Promise<void> {
  const ledger: Record<string, unknown> = {}
  let frontMatterBytes = 0
  let bodyBytes = 0
  const perDomain = new Map<string, { documentCount: number, frontMatterBytes: number, bodyBytes: number }>()
  for (const document of documents) {
    const source = documentSource(document)
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source)
    const frontMatter = match?.[1] ?? ''
    const body = normalizeBody(match?.[2] ?? '')
    const frontBytes = Buffer.byteLength(frontMatter)
    const bodySize = Buffer.byteLength(body)
    frontMatterBytes += frontBytes
    bodyBytes += bodySize
    const domain = perDomain.get(document.domain) ?? { documentCount: 0, frontMatterBytes: 0, bodyBytes: 0 }
    domain.documentCount += 1
    domain.frontMatterBytes += frontBytes
    domain.bodyBytes += bodySize
    perDomain.set(document.domain, domain)
    ledger[document.id] = {
      frontMatterFingerprint: hash(compact(metadata(document))),
      bodyFingerprint: hash(body),
      sourceFingerprint: await sourceFingerprint(root, document.codePaths ?? []),
    }
  }
  const perDomainValue = Object.fromEntries([...perDomain.entries()].sort(([left], [right]) => left < right ? -1 : 1).map(([id, value]) => [id, {
    ...value,
    estimatedTokens: Math.ceil((value.frontMatterBytes + value.bodyBytes) / 3),
  }]))
  const allDeclarations = documents.flatMap(document => document.codePaths ?? [])
  const meta = {
    $schema: 'plugydown.context.meta/v1',
    toolVersion: '0.1.0',
    runtimeProtocol: PROTOCOL,
    fingerprintVersion: '1',
    documents: ledger,
    ...(options.baselineRevision === undefined
      ? {}
      : {
          repository: { baseline: { revision: options.baselineRevision, sourceFingerprint: await sourceFingerprint(root, allDeclarations) } },
        }),
    ...(options.convergence === false
      ? {}
      : {
          convergence: {
            source: 'init',
            documentCount: documents.length,
            frontMatterBytes,
            bodyBytes,
            estimatedTokens: Math.ceil((frontMatterBytes + bodyBytes) / 3),
            perDomain: perDomainValue,
          },
        }),
  }
  await fs.writeFile(path.join(root, 'context/meta.json'), `${JSON.stringify(sortValue(meta), null, 2)}\n`)
}

export async function writeContext(root: string, documents: readonly FixtureDocument[], options: { readonly baselineRevision?: string, readonly convergence?: boolean } = {}): Promise<void> {
  await fs.mkdir(path.join(root, 'context'), { recursive: true })
  for (const document of documents) {
    const destination = path.join(root, 'context', document.relativePath)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.writeFile(destination, documentSource(document))
  }
  await writeMeta(root, documents, options)
}

export async function createRepository(options: {
  readonly documents?: readonly FixtureDocument[]
  readonly sources?: Readonly<Record<string, string>>
  readonly git?: boolean
  readonly baselineRevision?: string
} = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugydown-context-'))
  const sources = options.sources ?? {
    'src/service.ts': 'export const service = true\n',
    'src/retry.ts': 'export const retry = true\n',
    'src/client.ts': 'export const client = true\n',
  }
  for (const [candidate, contents] of Object.entries(sources)) {
    const destination = path.join(root, candidate)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.writeFile(destination, contents)
  }
  if (options.git !== false)
    await fs.mkdir(path.join(root, '.git'))
  if (options.documents !== undefined)
    await writeContext(root, options.documents, options.baselineRevision === undefined ? {} : { baselineRevision: options.baselineRevision })
  return root
}

export async function removeRepository(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true })
}

export async function writeGitEvidence(root: string, options: {
  readonly id?: string
  readonly revision?: string
  readonly status?: string | Buffer
  readonly diff?: string | Buffer
  readonly midOperation?: false | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'
} = {}): Promise<string> {
  const relative = `.scratch/evidence/${options.id ?? 'request'}`
  const directory = path.join(root, relative)
  const revision = options.revision ?? REVISION_A
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'head.txt'), `${revision}\n`)
  await fs.writeFile(path.join(directory, 'mid-operation.json'), JSON.stringify(options.midOperation === undefined || options.midOperation === false
    ? { active: false }
    : { active: true, kind: options.midOperation }))
  await fs.writeFile(path.join(directory, 'status.bin'), `# branch.oid ${revision}\0# branch.head main\0${String(options.status ?? '')}`)
  if (options.diff !== undefined)
    await fs.writeFile(path.join(directory, 'diff.bin'), options.diff)
  return relative
}

export function porcelainModified(candidate: string): string {
  const zero = '0'.repeat(40)
  return `1 .M N... 100644 100644 100644 ${zero} ${zero} ${candidate}\0`
}

export function nameStatus(changes: readonly { readonly status: string, readonly path: string, readonly previousPath?: string }[]): string {
  return changes.map(change => change.previousPath === undefined
    ? `${change.status}\0${change.path}\0`
    : `${change.status}\0${change.previousPath}\0${change.path}\0`).join('')
}

export function feedbackId(fields: {
  readonly context: string
  readonly observedBehavior: string
  readonly outcomeOrCorrection: string
  readonly reuseBoundary: string
}): string {
  const normalize = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
  const ascii = normalize(`${fields.context} ${fields.observedBehavior}`)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .match(/[a-z0-9]+/g) ?? []
  const slug = ascii.slice(0, 4).join('-').slice(0, 48).replace(/-+$/g, '') || 'feedback'
  return `${slug}-${hash(compact({
    context: normalize(fields.context),
    observedBehavior: normalize(fields.observedBehavior),
    outcomeOrCorrection: normalize(fields.outcomeOrCorrection),
    reuseBoundary: normalize(fields.reuseBoundary),
  })).slice(0, 8)}`
}

export function runtimeRequest(capability: string, input: unknown, options: { readonly budget?: unknown, readonly cursor?: string } = {}): Record<string, unknown> {
  return { protocol: PROTOCOL, capability, input, ...options }
}

export async function call(root: string, capability: string, input: unknown, options: { readonly budget?: unknown, readonly cursor?: string } = {}): Promise<RuntimeResponse> {
  return handleRequest(root, runtimeRequest(capability, input, options))
}

export async function transactionCall(root: string, action: TransactionAction, input: unknown): Promise<RuntimeResponse> {
  return handleRequest(root, { protocol: PROTOCOL, capability: 'transaction', action, input })
}
