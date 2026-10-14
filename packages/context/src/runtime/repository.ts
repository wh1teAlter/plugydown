import type { Buffer } from 'node:buffer'
import type { Diagnostic } from './protocol.js'
import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { isRecord, RuntimeFault, sha256 } from './protocol.js'
import { compactJson, compareCodeUnits } from './stable-json.js'

export const CONTEXT_ROOT = 'context'
export const SCRATCH_ROOT = '.scratch'
export const EVIDENCE_ROOT = `${SCRATCH_ROOT}/evidence`
export const FEEDBACK_ROOT = `${SCRATCH_ROOT}/feedback`
export const RUNS_ROOT = `${SCRATCH_ROOT}/runs`
export const LOCK_ROOT = `${SCRATCH_ROOT}/locks/context-write`
export const LOCK_SCHEMA = 'plugydown.context.lock/v1'

export const MAX_MARKDOWN_BYTES = 1024 * 1024
export const MAX_FRONT_MATTER_BYTES = 64 * 1024
export const MAX_JSON_TEXT_BYTES = 4 * 1024 * 1024
export const MAX_GIT_EVIDENCE_BYTES = 16 * 1024 * 1024
export const MAX_SOURCE_FILES = 10_000
export const MAX_SOURCE_BYTES = 512 * 1024 * 1024

const VARIABLE = /\$|%[A-Z_]\w*%/i
const UNSUPPORTED_GLOB = /[?[\]{}!]/
const RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
// Only the repository-root `.git/`, `.scratch/` and `context/` are off limits — they hold Git, transaction
// and knowledge state, not source — whereas `node_modules/` is refused at any depth. Matching all four on
// every segment would reject legitimate monorepo paths such as `packages/context/**`.
const FORBIDDEN_SOURCE_ROOTS = new Set(['.git', '.scratch', 'context'])
const SCRATCH_LEAF_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const KNOWN_FILESYSTEM_CODES = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOTDIR',
  'EISDIR',
  'EEXIST',
  'ENOSPC',
  'EROFS',
  'EMFILE',
  'ENFILE',
  'EIO',
  'EBUSY',
  'EXDEV',
])

function isSafeDiagnosticPath(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > 1_024 || candidate.includes('\\')
    || path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || /^[A-Z]:/i.test(candidate)
    || [...candidate].some((character) => {
      const value = character.codePointAt(0) as number
      return value <= 0x1F || value === 0x7F
    })
    || VARIABLE.test(candidate)) {
    return false
  }
  const segments = candidate.split('/')
  return !segments.some(segment => segment.length === 0 || segment === '.' || segment === '..' || segment.includes('~'))
}

function pathFault(code: string, message: string, candidate: string, disclose = false): never {
  throw new RuntimeFault(code, message, disclose && isSafeDiagnosticPath(candidate) ? candidate : undefined)
}

export function isKnownFilesystemError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null
    && typeof (error as NodeJS.ErrnoException).code === 'string'
    && KNOWN_FILESYSTEM_CODES.has((error as NodeJS.ErrnoException).code as string)
}

export function throwFilesystemFault(error: unknown, candidate?: string): never {
  if (error instanceof RuntimeFault)
    throw error
  if (!isKnownFilesystemError(error))
    throw error
  throw new RuntimeFault(
    'REPOSITORY_IO_FAILED',
    `A repository filesystem operation failed with ${error.code}.`,
    candidate !== undefined && isSafeDiagnosticPath(candidate) ? candidate : undefined,
  )
}

/** Runs one filesystem call, converting only recognized errno failures into a safe fault. */
export async function filesystemOperation<T>(operation: () => Promise<T>, candidate?: string): Promise<T> {
  try {
    return await operation()
  }
  catch (error) {
    throwFilesystemFault(error, candidate)
  }
}

/** Strict lexical validation shared by repository-relative Runtime paths. */
export function assertSafeRelativePath(candidate: string): void {
  if (candidate.length === 0)
    pathFault('PATH_EMPTY', 'A repository-relative path must not be empty.', candidate)
  if (candidate.length > 1_024)
    pathFault('PATH_LENGTH_EXCEEDED', 'A repository-relative path exceeds the length limit.', candidate)
  if (candidate.includes('\\'))
    pathFault('PATH_SEPARATOR_INVALID', 'Repository paths must use forward slashes.', candidate)
  if (path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || /^[A-Z]:/i.test(candidate))
    pathFault('PATH_ABSOLUTE', 'A repository path must be relative.', candidate)
  if ([...candidate].some((character) => {
    const value = character.codePointAt(0) as number
    return value <= 0x1F || value === 0x7F
  })) {
    pathFault('PATH_CONTROL_CHARACTER', 'A repository path must not contain control characters.', candidate)
  }
  if (VARIABLE.test(candidate))
    pathFault('PATH_VARIABLE', 'A repository path must not contain variables.', candidate)
  const segments = candidate.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..' || segment.includes('~')))
    pathFault('PATH_SEGMENT_INVALID', 'A repository path contains an unsafe segment.', candidate)
}

export function hasGlob(pattern: string): boolean {
  return pattern.includes('*') || UNSUPPORTED_GLOB.test(pattern)
}

/** Validates the exact controlled glob language used by code.paths and path scopes. */
export function assertSourcePattern(pattern: string): void {
  assertSafeRelativePath(pattern)
  const segments = pattern.split('/')
  if (pattern.includes('*') && (segments.length < 2 || segments[0]?.includes('*')))
    pathFault('GLOB_ANCHOR_INVALID', 'A source pattern must begin with a concrete directory.', pattern)
  if (UNSUPPORTED_GLOB.test(pattern))
    pathFault('GLOB_SYNTAX_INVALID', 'A source pattern uses unsupported glob syntax.', pattern)
  if (segments.filter(segment => segment === '**').length > 1 || segments.some(segment => segment.includes('**') && segment !== '**'))
    pathFault('GLOB_RECURSION_INVALID', 'A source pattern may contain one complete recursive segment.', pattern)
  if (FORBIDDEN_SOURCE_ROOTS.has(segments[0] ?? '') || segments.includes('node_modules'))
    pathFault('SOURCE_ROOT_FORBIDDEN', 'A source pattern points into a forbidden repository root.', pattern)
}

export type LockOwner
  = | { readonly state: 'absent' }
    | { readonly state: 'valid', readonly runId: string }
    | { readonly state: 'corrupt' }

/**
 * Single source of truth for write-lock owner validity. Both the transaction plane and
 * `repository.inspect` read the lock through here so the two cannot diverge on what counts
 * as a live owner.
 */
export async function readLockOwner(root: string): Promise<LockOwner> {
  try {
    const info = await lstatRepositoryPath(root, LOCK_ROOT)
    if (info === undefined)
      return { state: 'absent' }
    if (!info.isDirectory())
      return { state: 'corrupt' }
    const raw = JSON.parse(await readUtf8File(root, `${LOCK_ROOT}/owner.json`, MAX_JSON_TEXT_BYTES)) as unknown
    if (!isRecord(raw) || Object.keys(raw).length !== 2 || raw.schema !== LOCK_SCHEMA
      || typeof raw.runId !== 'string' || !RUN_ID.test(raw.runId)) {
      return { state: 'corrupt' }
    }
    return { state: 'valid', runId: raw.runId }
  }
  catch (error) {
    if (error instanceof RuntimeFault || error instanceof SyntaxError)
      return { state: 'corrupt' }
    throw error
  }
}

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${path.sep}`)
}

async function realRoot(root: string): Promise<string> {
  const resolved = await filesystemOperation(() => fs.realpath(root))
  const info = await filesystemOperation(() => fs.lstat(resolved))
  if (!info.isDirectory())
    throw new RuntimeFault('REPOSITORY_ROOT_INVALID', 'The Runtime root must be a directory.')
  return resolved
}

export async function resolveRepositoryRoot(root: string): Promise<string> {
  return realRoot(root)
}

/** Resolves a path while rejecting every symlink parent, even one that stays inside the root. */
export async function resolveRepositoryPath(root: string, candidate: string, allowMissingTail = false): Promise<string> {
  assertSafeRelativePath(candidate)
  const base = await realRoot(root)
  const absolute = path.resolve(base, ...candidate.split('/'))
  if (!isInside(base, absolute))
    pathFault('PATH_ESCAPE', 'A repository path resolves outside the Runtime root.', candidate)

  const segments = candidate.split('/')
  let current = base
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index] as string)
    let info
    try {
      info = await fs.lstat(current)
    }
    catch (error) {
      if (allowMissingTail && (error as NodeJS.ErrnoException).code === 'ENOENT')
        return absolute
      throwFilesystemFault(error, candidate)
    }
    if (info.isSymbolicLink())
      pathFault('PATH_SYMLINK', 'Repository paths must not traverse symlinks.', candidate)
    if (index < segments.length - 1 && !info.isDirectory())
      pathFault('PATH_PARENT_NOT_DIRECTORY', 'A repository path parent must be a directory.', candidate)
  }
  return absolute
}

export async function lstatRepositoryPath(root: string, candidate: string): Promise<import('node:fs').Stats | undefined> {
  const absolute = await resolveRepositoryPath(root, candidate, true)
  try {
    return await fs.lstat(absolute)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return undefined
    throwFilesystemFault(error, candidate)
  }
}

export async function pathExists(root: string, candidate: string): Promise<boolean> {
  return (await lstatRepositoryPath(root, candidate)) !== undefined
}

export async function readRegularBytes(root: string, candidate: string, maximum: number): Promise<Buffer> {
  const absolute = await resolveRepositoryPath(root, candidate)
  const info = await filesystemOperation(() => fs.lstat(absolute), candidate)
  if (!info.isFile() || info.isSymbolicLink())
    pathFault('PATH_NOT_REGULAR_FILE', 'A repository path must reference a regular file.', candidate)
  if (info.size > maximum)
    pathFault('FILE_SIZE_EXCEEDED', 'A repository file exceeds its resource limit.', candidate)
  return filesystemOperation(() => fs.readFile(absolute), candidate)
}

export function decodeUtf8(bytes: Uint8Array, candidate: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch {
    pathFault('FILE_ENCODING_INVALID', 'A Runtime text file must be valid UTF-8.', candidate)
  }
}

export async function readUtf8File(root: string, candidate: string, maximum: number): Promise<string> {
  return decodeUtf8(await readRegularBytes(root, candidate, maximum), candidate)
}

export interface DirectoryEntry {
  readonly name: string
  readonly kind: 'directory' | 'file' | 'symlink' | 'special'
}

export async function readDirectory(root: string, candidate: string): Promise<readonly DirectoryEntry[]> {
  const absolute = await resolveRepositoryPath(root, candidate)
  const info = await filesystemOperation(() => fs.lstat(absolute), candidate)
  if (!info.isDirectory())
    pathFault('PATH_NOT_DIRECTORY', 'A repository path must reference a directory.', candidate)
  return (await filesystemOperation(() => fs.readdir(absolute, { withFileTypes: true }), candidate))
    .map((entry) => {
      const kind = entry.isSymbolicLink()
        ? 'symlink' as const
        : entry.isDirectory()
          ? 'directory' as const
          : entry.isFile()
            ? 'file' as const
            : 'special' as const
      return { name: entry.name, kind }
    })
    .sort((left, right) => compareCodeUnits(left.name, right.name))
}

export interface TreeFile {
  readonly path: string
  readonly bytes: Buffer
  readonly mode: number
}

/** Walks a strict ordinary directory tree without following or dropping unsafe entries. */
export async function readTree(root: string, treePath: string, maximumFileBytes = MAX_JSON_TEXT_BYTES): Promise<readonly TreeFile[]> {
  const files: TreeFile[] = []
  let totalBytes = 0
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await readDirectory(root, relative)) {
      const child = `${relative}/${entry.name}`
      if (entry.kind === 'directory') {
        await visit(child)
      }
      else if (entry.kind === 'file') {
        const absolute = await resolveRepositoryPath(root, child)
        const info = await filesystemOperation(() => fs.lstat(absolute), child)
        if (info.size > maximumFileBytes)
          pathFault('FILE_SIZE_EXCEEDED', 'A repository file exceeds its resource limit.', child, true)
        if (files.length + 1 > MAX_SOURCE_FILES)
          throw new RuntimeFault('FORMAL_FILE_LIMIT_EXCEEDED', 'The formal Context tree exceeds the file-count limit.')
        totalBytes += info.size
        if (totalBytes > MAX_SOURCE_BYTES)
          throw new RuntimeFault('FORMAL_BYTE_LIMIT_EXCEEDED', 'The formal Context tree exceeds the byte limit.')
        files.push({ path: child, bytes: await filesystemOperation(() => fs.readFile(absolute), child), mode: info.mode & 0o777 })
      }
      else {
        pathFault(entry.kind === 'symlink' ? 'PATH_SYMLINK' : 'PATH_SPECIAL_FILE', 'A strict repository tree contains a non-ordinary entry.', child)
      }
    }
  }
  await visit(treePath)
  return files.sort((left, right) => compareCodeUnits(left.path, right.path))
}

export async function fingerprintTree(root: string, treePath: string, canonicalRoot = CONTEXT_ROOT): Promise<string> {
  const files = await readTree(root, treePath, MAX_JSON_TEXT_BYTES)
  const prefix = `${treePath}/`
  return sha256(compactJson(files.map(file => ({
    path: `${canonicalRoot}/${file.path.slice(prefix.length)}`,
    hash: sha256(file.bytes),
  }))))
}

function segmentMatches(pattern: string, candidate: string): boolean {
  let expression = '^'
  for (const character of pattern)
    expression += character === '*' ? '.*' : character.replace(/[|{}()[\]^$+?.]/g, '\\$&')
  return new RegExp(`${expression}$`, 'u').test(candidate)
}

/** Matches one source declaration, exact or controlled glob, against a concrete repository path. */
export function declarationMatches(declaration: string, candidate: string): boolean {
  return declaration === candidate || (declaration.includes('*') && controlledGlobMatches(declaration, candidate))
}

export function controlledGlobMatches(pattern: string, candidate: string): boolean {
  const patterns = pattern.split('/')
  const candidates = candidate.split('/')
  const visit = (patternIndex: number, candidateIndex: number): boolean => {
    if (patternIndex === patterns.length)
      return candidateIndex === candidates.length
    const part = patterns[patternIndex] as string
    if (part === '**')
      return visit(patternIndex + 1, candidateIndex) || (candidateIndex < candidates.length && visit(patternIndex, candidateIndex + 1))
    return candidateIndex < candidates.length
      && segmentMatches(part, candidates[candidateIndex] as string)
      && visit(patternIndex + 1, candidateIndex + 1)
  }
  return visit(0, 0)
}

async function hashRegularFile(root: string, candidate: string, remainingBytes: number): Promise<{ readonly hash: string, readonly size: number }> {
  const absolute = await resolveRepositoryPath(root, candidate)
  const info = await filesystemOperation(() => fs.lstat(absolute), candidate)
  if (!info.isFile() || info.isSymbolicLink())
    pathFault('SOURCE_NOT_REGULAR_FILE', 'A source declaration must resolve only to regular files.', candidate, true)
  if (info.size > remainingBytes)
    throw new RuntimeFault('SOURCE_BYTE_LIMIT_EXCEEDED', 'A source expansion exceeds the byte limit.')
  const hash = createHash('sha256')
  try {
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(absolute)
      stream.on('data', chunk => hash.update(chunk))
      stream.on('error', reject)
      stream.on('end', resolve)
    })
  }
  catch (error) {
    throwFilesystemFault(error, candidate)
  }
  return { hash: hash.digest('hex'), size: info.size }
}

/** True while some path below `segments` could still match `parts`. */
function couldContainMatch(parts: readonly string[], segments: readonly string[]): boolean {
  const visit = (part: number, segment: number): boolean => {
    if (segment === segments.length)
      return part < parts.length
    if (part === parts.length)
      return false
    if (parts[part] === '**')
      return visit(part + 1, segment) || visit(part, segment + 1)
    return segmentMatches(parts[part] as string, segments[segment] as string) && visit(part + 1, segment + 1)
  }
  return visit(0, 0)
}

/**
 * Walks only the directories a controlled glob can still match. Unrelated siblings — another
 * package's symlinked `node_modules`, a build output tree — are never opened, so they can neither
 * fail the glob nor count against the file ceiling. `node_modules` is never entered at any depth:
 * a pattern may not name it, so `**` must not reach into it either.
 * A symlink or special entry is refused only where it could be a result or must be descended
 * through; one the pattern can never reach is left unopened rather than followed.
 */
async function expandGlob(root: string, pattern: string, visitedFiles: Set<string>): Promise<readonly string[]> {
  const parts = pattern.split('/')
  // The first segment is always literal (GLOB_ANCHOR_INVALID); pruning narrows everything below it.
  const base = parts[0] as string
  const info = await lstatRepositoryPath(root, base)
  if (info === undefined || !info.isDirectory())
    return []
  const matches: string[] = []
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await readDirectory(root, relative)) {
      if (entry.name === 'node_modules')
        continue
      const child = `${relative}/${entry.name}`
      const descends = couldContainMatch(parts, child.split('/'))
      const selected = controlledGlobMatches(pattern, child)
      if (entry.kind === 'directory') {
        if (descends)
          await visit(child)
      }
      else if (entry.kind === 'file') {
        if (!selected)
          continue
        visitedFiles.add(child)
        if (visitedFiles.size > MAX_SOURCE_FILES)
          throw new RuntimeFault('SOURCE_FILE_LIMIT_EXCEEDED', 'A source expansion exceeds the file-count limit.')
        matches.push(child)
      }
      else if (selected || descends) {
        pathFault(entry.kind === 'symlink' ? 'PATH_SYMLINK' : 'PATH_SPECIAL_FILE', 'A source expansion encountered a non-ordinary entry.', child, true)
      }
    }
  }
  await visit(base)
  return matches.sort(compareCodeUnits)
}

export interface SourceFile {
  readonly path: string
  readonly contentHash: string
  readonly bytes: number
}

export interface SourcePatternSet {
  readonly owner: string
  readonly patterns: readonly string[]
}

export interface SourceExpansionIssue {
  readonly owner: string
  readonly pattern: string
  readonly diagnostic: Diagnostic
}

export interface SourceExpansionResult {
  readonly filesByOwner: ReadonlyMap<string, readonly SourceFile[]>
  readonly issues: readonly SourceExpansionIssue[]
  readonly fingerprint: string
}

const SOURCE_RESOURCE_FAILURES = new Set(['SOURCE_FILE_LIMIT_EXCEEDED', 'SOURCE_BYTE_LIMIT_EXCEEDED'])

function sourceDiagnostic(error: unknown): Diagnostic {
  if (!(error instanceof RuntimeFault))
    throw error
  if (SOURCE_RESOURCE_FAILURES.has(error.code))
    throw error
  return error.diagnostics[0] as Diagnostic
}

/** Expands all requested Documents as one bounded source dataset and hashes each unique file once. */
export async function expandSourcePatternSets(root: string, sets: readonly SourcePatternSet[]): Promise<SourceExpansionResult> {
  const orderedSets = [...sets].sort((left, right) => compareCodeUnits(left.owner, right.owner))
  const selectedByOwner = new Map<string, Set<string>>()
  const issues: SourceExpansionIssue[] = []
  const visitedFiles = new Set<string>()
  const globCache = new Map<string, Promise<readonly string[]>>()

  for (const set of orderedSets) {
    const selected = selectedByOwner.get(set.owner) ?? new Set<string>()
    selectedByOwner.set(set.owner, selected)
    for (const pattern of set.patterns) {
      try {
        assertSourcePattern(pattern)
        if (!hasGlob(pattern)) {
          const info = await lstatRepositoryPath(root, pattern)
          if (info === undefined)
            pathFault('SOURCE_EXACT_MISSING', 'An exact source declaration does not exist.', pattern, true)
          if (!info.isFile())
            pathFault('SOURCE_NOT_REGULAR_FILE', 'An exact source declaration must identify a regular file.', pattern, true)
          visitedFiles.add(pattern)
          if (visitedFiles.size > MAX_SOURCE_FILES)
            throw new RuntimeFault('SOURCE_FILE_LIMIT_EXCEEDED', 'A source expansion exceeds the file-count limit.')
          selected.add(pattern)
          continue
        }
        // ponytail: cached per pattern, so two overlapping globs walk their shared directories twice;
        // file hashing is still once per path. Share walks by literal prefix if that ever shows up.
        let expansion = globCache.get(pattern)
        if (expansion === undefined) {
          expansion = expandGlob(root, pattern, visitedFiles)
          globCache.set(pattern, expansion)
        }
        const matches = await expansion
        if (matches.length === 0)
          pathFault('SOURCE_GLOB_ZERO_MATCH', 'A source glob matched no regular files.', pattern, true)
        matches.forEach(candidate => selected.add(candidate))
      }
      catch (error) {
        issues.push({ owner: set.owner, pattern, diagnostic: sourceDiagnostic(error) })
      }
    }
  }

  const allSelected = [...new Set([...selectedByOwner.values()].flatMap(paths => [...paths]))].sort(compareCodeUnits)
  const hashed = new Map<string, SourceFile>()
  let totalBytes = 0
  for (const candidate of allSelected) {
    try {
      const sample = await hashRegularFile(root, candidate, MAX_SOURCE_BYTES - totalBytes)
      totalBytes += sample.size
      hashed.set(candidate, { path: candidate, contentHash: sample.hash, bytes: sample.size })
    }
    catch (error) {
      const problem = sourceDiagnostic(error)
      for (const [owner, paths] of selectedByOwner) {
        if (paths.has(candidate))
          issues.push({ owner, pattern: candidate, diagnostic: problem })
      }
    }
  }

  const filesByOwner = new Map<string, readonly SourceFile[]>()
  for (const set of orderedSets) {
    filesByOwner.set(set.owner, [...(selectedByOwner.get(set.owner) ?? [])]
      .sort(compareCodeUnits)
      .flatMap(candidate => hashed.has(candidate) ? [hashed.get(candidate) as SourceFile] : []))
  }
  const orderedIssues = issues.sort((left, right) => compareCodeUnits(
    `${left.owner}\0${left.pattern}\0${left.diagnostic.code}`,
    `${right.owner}\0${right.pattern}\0${right.diagnostic.code}`,
  ))
  const fingerprint = sha256(compactJson(orderedSets.map(set => ({
    owner: set.owner,
    declarations: [...set.patterns].sort(compareCodeUnits),
    files: (filesByOwner.get(set.owner) ?? []).map(file => ({ path: file.path, contentHash: file.contentHash })),
    issues: orderedIssues.filter(item => item.owner === set.owner).map(item => ({
      pattern: item.pattern,
      code: item.diagnostic.code,
      path: item.diagnostic.path ?? '',
    })),
  }))))
  return { filesByOwner, issues: orderedIssues, fingerprint }
}

export function aggregateSourceFingerprint(patterns: readonly string[], files: readonly SourceFile[]): string {
  return sha256(compactJson({
    declarations: [...patterns].sort(compareCodeUnits),
    files: [...files].sort((left, right) => compareCodeUnits(left.path, right.path)).map(file => ({
      path: file.path,
      contentHash: file.contentHash,
    })),
  }))
}

export type GitChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

export interface GitChange {
  readonly path: string
  readonly kind: GitChangeKind
  readonly previousPath?: string
}

export interface GitEvidence {
  readonly currentRevision: string
  readonly midOperation: boolean
  readonly midOperationKind?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'
  readonly changes: readonly GitChange[]
  readonly hasDiff: boolean
  readonly fingerprint: string
}

function changeKind(code: string): GitChangeKind {
  if (code === 'A')
    return 'added'
  if (code === 'D')
    return 'deleted'
  if (code === 'R' || code === 'C')
    return 'renamed'
  return 'modified'
}

function validateGitPath(candidate: string): string {
  assertSafeRelativePath(candidate)
  return candidate
}

interface PorcelainEvidence {
  readonly revision: string
  readonly changes: readonly GitChange[]
}

function parsePorcelainEvidence(bytes: Uint8Array): PorcelainEvidence {
  const text = decodeUtf8(bytes, 'status.bin')
  if (text.length === 0 || !text.endsWith('\0'))
    throw new RuntimeFault('GIT_STATUS_INVALID', 'Git status evidence must be NUL-delimited.', 'status.bin')
  const records = text.split('\0')
  const changes: GitChange[] = []
  let revision: string | undefined
  let branchHead: string | undefined
  let upstreamSeen = false
  let aheadBehindSeen = false
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as string
    if (record.length === 0)
      continue
    if (record.startsWith('# ')) {
      if (record.startsWith('# branch.oid ')) {
        if (revision !== undefined || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(record.slice(13)))
          throw new RuntimeFault('GIT_STATUS_INVALID', 'Git status evidence has an invalid or duplicate branch.oid header.', 'status.bin')
        revision = record.slice(13)
        continue
      }
      if (record.startsWith('# branch.head ')) {
        if (branchHead !== undefined || record.slice(14).length === 0)
          throw new RuntimeFault('GIT_STATUS_INVALID', 'Git status evidence has an invalid or duplicate branch.head header.', 'status.bin')
        branchHead = record.slice(14)
        continue
      }
      if (record.startsWith('# branch.upstream ')) {
        if (upstreamSeen || record.slice(18).length === 0)
          throw new RuntimeFault('GIT_STATUS_INVALID', 'Git status evidence has an invalid or duplicate branch.upstream header.', 'status.bin')
        upstreamSeen = true
        continue
      }
      if (record.startsWith('# branch.ab ')) {
        if (aheadBehindSeen || !/^\+\d+ -\d+$/.test(record.slice(12)))
          throw new RuntimeFault('GIT_STATUS_INVALID', 'Git status evidence has an invalid or duplicate branch.ab header.', 'status.bin')
        aheadBehindSeen = true
        continue
      }
      throw new RuntimeFault('GIT_STATUS_INVALID', 'Git status evidence contains an unknown header.', 'status.bin')
    }
    if (record.startsWith('? ')) {
      // Git's default untracked mode collapses a new directory to `dir/`, hiding which files are new;
      // delta must map files, so name the fix rather than failing on the trailing slash as unsafe.
      if (record.endsWith('/'))
        throw new RuntimeFault('GIT_STATUS_UNTRACKED_COLLAPSED', 'Git status evidence lists an untracked directory instead of its files; collect it with --untracked-files=all.', 'status.bin')
      changes.push({ path: validateGitPath(record.slice(2)), kind: 'untracked' })
      continue
    }
    if (record.startsWith('! '))
      continue
    const ordinary = /^1 ([^ ]+) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/su.exec(record)
    if (ordinary !== null) {
      const xy = ordinary[1] as string
      const code = xy[0] !== '.' ? xy[0] as string : xy[1] as string
      changes.push({ path: validateGitPath(ordinary[2] as string), kind: changeKind(code) })
      continue
    }
    const renamed = /^2 ([^ ]+) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/su.exec(record)
    if (renamed !== null) {
      const previous = records[index + 1]
      if (previous === undefined || previous.length === 0)
        throw new RuntimeFault('GIT_STATUS_INVALID', 'A rename record is missing its previous path.', 'status.bin')
      index += 1
      changes.push({
        path: validateGitPath(renamed[2] as string),
        kind: 'renamed',
        previousPath: validateGitPath(previous),
      })
      continue
    }
    const unmerged = /^u [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/su.exec(record)
    if (unmerged !== null) {
      changes.push({ path: validateGitPath(unmerged[1] as string), kind: 'modified' })
      continue
    }
    throw new RuntimeFault('GIT_STATUS_INVALID', 'Git status evidence contains an unknown record.', 'status.bin')
  }
  if (revision === undefined || branchHead === undefined)
    throw new RuntimeFault('GIT_STATUS_INVALID', 'Git status evidence requires exactly one branch.oid and branch.head header.', 'status.bin')
  return { revision, changes }
}

export function parseNameStatus(bytes: Uint8Array): readonly GitChange[] {
  const text = decodeUtf8(bytes, 'diff.bin')
  if (text.length > 0 && !text.endsWith('\0'))
    throw new RuntimeFault('GIT_DIFF_INVALID', 'Git diff evidence must be NUL-delimited.', 'diff.bin')
  const fields = text.split('\0')
  const changes: GitChange[] = []
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++] as string
    if (!/^[ACDMRTUXB]\d*$/.test(status))
      throw new RuntimeFault('GIT_DIFF_INVALID', 'Git diff evidence contains an unknown status.', 'diff.bin')
    if (status.startsWith('R') || status.startsWith('C')) {
      const previous = fields[index++]
      const current = fields[index++]
      if (!previous || !current)
        throw new RuntimeFault('GIT_DIFF_INVALID', 'Git diff rename evidence is incomplete.', 'diff.bin')
      changes.push({ path: validateGitPath(current), previousPath: validateGitPath(previous), kind: 'renamed' })
    }
    else {
      const candidate = fields[index++]
      if (!candidate)
        throw new RuntimeFault('GIT_DIFF_INVALID', 'Git diff evidence is incomplete.', 'diff.bin')
      changes.push({ path: validateGitPath(candidate), kind: changeKind(status[0] as string) })
    }
  }
  return changes
}

async function assertGitRepository(root: string): Promise<void> {
  const info = await lstatRepositoryPath(root, '.git')
  if (info === undefined || (!info.isDirectory() && !info.isFile()))
    throw new RuntimeFault('GIT_REPOSITORY_REQUIRED', 'This capability requires Git metadata in the Runtime root.', '.git')
}

/** Loads and strictly validates one host-collected Git evidence directory. */
export async function readGitEvidence(root: string, evidencePath: string): Promise<GitEvidence> {
  await assertGitRepository(root)
  assertGitEvidencePath(evidencePath)
  const info = await lstatRepositoryPath(root, evidencePath)
  if (info === undefined || !info.isDirectory())
    throw new RuntimeFault('GIT_EVIDENCE_PATH_INVALID', 'Git evidence path must be a regular directory.', evidencePath)
  const entries = await readDirectory(root, evidencePath)
  const names = entries.map(entry => entry.name)
  const allowed = new Set(['head.txt', 'mid-operation.json', 'status.bin', 'diff.bin'])
  if (entries.some(entry => entry.kind !== 'file' || !allowed.has(entry.name)))
    throw new RuntimeFault('GIT_EVIDENCE_UNKNOWN_FILE', 'Git evidence contains an unknown or non-regular entry.', evidencePath)
  for (const required of ['head.txt', 'mid-operation.json', 'status.bin']) {
    if (!names.includes(required))
      throw new RuntimeFault('GIT_EVIDENCE_FILE_MISSING', `Git evidence is missing ${required}.`, evidencePath)
  }
  const raw = new Map<string, Buffer>()
  for (const name of names)
    raw.set(name, await readRegularBytes(root, `${evidencePath}/${name}`, MAX_GIT_EVIDENCE_BYTES))
  const head = decodeUtf8(raw.get('head.txt') as Buffer, `${evidencePath}/head.txt`)
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?\n$/.test(head))
    throw new RuntimeFault('GIT_HEAD_INVALID', 'Git HEAD evidence must contain one full lowercase revision.', `${evidencePath}/head.txt`)
  const midText = decodeUtf8(raw.get('mid-operation.json') as Buffer, `${evidencePath}/mid-operation.json`).replace(/^\uFEFF/, '')
  let mid: unknown
  try {
    mid = JSON.parse(midText)
  }
  catch {
    throw new RuntimeFault('GIT_MID_OPERATION_INVALID', 'Git mid-operation evidence must be valid JSON.', `${evidencePath}/mid-operation.json`)
  }
  if (typeof mid !== 'object' || mid === null || Array.isArray(mid))
    throw new RuntimeFault('GIT_MID_OPERATION_INVALID', 'Git mid-operation evidence must be an object.', `${evidencePath}/mid-operation.json`)
  const object = mid as Record<string, unknown>
  const keys = Object.keys(object).sort(compareCodeUnits)
  const expected = object.active === true ? ['active', 'kind'] : ['active']
  if (JSON.stringify(keys) !== JSON.stringify(expected) || typeof object.active !== 'boolean'
    || (object.active === true && !['merge', 'rebase', 'cherry-pick', 'revert', 'bisect'].includes(String(object.kind)))) {
    throw new RuntimeFault('GIT_MID_OPERATION_INVALID', 'Git mid-operation evidence has an invalid shape.', `${evidencePath}/mid-operation.json`)
  }

  const porcelain = parsePorcelainEvidence(raw.get('status.bin') as Buffer)
  if (porcelain.revision !== head.trim())
    throw new RuntimeFault('GIT_STATUS_HEAD_MISMATCH', 'Git status branch.oid must equal head.txt.', `${evidencePath}/status.bin`)
  const changes = [
    ...(raw.has('diff.bin') ? parseNameStatus(raw.get('diff.bin') as Buffer) : []),
    ...porcelain.changes,
  ].sort((left, right) => compareCodeUnits(`${left.path}\0${left.kind}\0${left.previousPath ?? ''}`, `${right.path}\0${right.kind}\0${right.previousPath ?? ''}`))
  const unique = changes.filter((change, index) => index === 0
    || compactJson(change as unknown as import('./stable-json.js').JsonValue)
    !== compactJson(changes[index - 1] as unknown as import('./stable-json.js').JsonValue))
  const fingerprint = sha256(compactJson([...raw.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([name, bytes]) => ({ name, hash: sha256(bytes) }))))
  return {
    currentRevision: head.trim(),
    midOperation: object.active as boolean,
    ...(object.active === true ? { midOperationKind: object.kind as NonNullable<GitEvidence['midOperationKind']> } : {}),
    changes: unique,
    hasDiff: raw.has('diff.bin'),
    fingerprint,
  }
}

/** Restricts disposable Git evidence to one directly owned leaf. */
export function assertGitEvidencePath(evidencePath: string): void {
  assertSafeRelativePath(evidencePath)
  const segments = evidencePath.split('/')
  if (segments.length !== 3 || `${segments[0]}/${segments[1]}` !== EVIDENCE_ROOT || !SCRATCH_LEAF_ID.test(segments[2] as string))
    throw new RuntimeFault('GIT_EVIDENCE_PATH_INVALID', 'Git evidence must be one named leaf under .scratch/evidence/.', evidencePath)
}
