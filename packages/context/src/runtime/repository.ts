import type { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { RuntimeFault, sha256 } from './protocol.js'
import { compactJson, compareCodeUnits } from './stable-json.js'

export const CONTEXT_ROOT = 'context'
export const META_PATH = 'context/meta.json'
export const SCRATCH_ROOT = '.scratch'
export const EVIDENCE_ROOT = `${SCRATCH_ROOT}/evidence`
export const FEEDBACK_ROOT = `${SCRATCH_ROOT}/feedback`
export const INVESTIGATION_ROOT = `${SCRATCH_ROOT}/investigations`
export const RUNS_ROOT = `${SCRATCH_ROOT}/runs`
export const LOCK_ROOT = `${SCRATCH_ROOT}/locks/context-write`

export const MAX_MARKDOWN_BYTES = 1024 * 1024
export const MAX_FRONT_MATTER_BYTES = 64 * 1024
export const MAX_JSON_TEXT_BYTES = 4 * 1024 * 1024
export const MAX_GIT_EVIDENCE_BYTES = 16 * 1024 * 1024
export const MAX_SOURCE_FILES = 10_000
export const MAX_SOURCE_BYTES = 512 * 1024 * 1024

const VARIABLE = /\$|%[A-Z_]\w*%/i
const UNSUPPORTED_GLOB = /[?[\]{}!]/
const FORBIDDEN_SOURCE_SEGMENTS = new Set(['.git', '.scratch', 'context', 'node_modules'])
const SCRATCH_LEAF_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function isSafeDiagnosticPath(candidate: string): boolean {
  if (candidate.length === 0 || candidate.includes('\\')
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

function pathFault(code: string, message: string, candidate: string): never {
  throw new RuntimeFault(code, message, isSafeDiagnosticPath(candidate) ? candidate : undefined)
}

/** Strict lexical validation shared by repository-relative Runtime paths. */
export function assertSafeRelativePath(candidate: string): void {
  if (candidate.length === 0)
    pathFault('PATH_EMPTY', 'A repository-relative path must not be empty.', candidate)
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
  if (segments.some(segment => FORBIDDEN_SOURCE_SEGMENTS.has(segment)))
    pathFault('SOURCE_ROOT_FORBIDDEN', 'A source pattern points into a forbidden repository root.', pattern)
}

/** Validates an exact source path used as a selector rather than a declaration glob. */
export function assertSourcePath(candidate: string): void {
  assertSourcePattern(candidate)
  if (hasGlob(candidate))
    pathFault('PATH_GLOB_INVALID', 'A source path selector must not contain glob syntax.', candidate)
}

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${path.sep}`)
}

async function realRoot(root: string): Promise<string> {
  const resolved = await fs.realpath(root)
  const info = await fs.lstat(resolved)
  if (!info.isDirectory())
    throw new RuntimeFault('REPOSITORY_ROOT_INVALID', 'The Runtime root must be a directory.')
  return resolved
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
      throw error
    }
    if (info.isSymbolicLink())
      pathFault('PATH_SYMLINK', 'Repository paths must not traverse symlinks.', candidate)
    if (index < segments.length - 1 && !info.isDirectory())
      pathFault('PATH_PARENT_NOT_DIRECTORY', 'A repository path parent must be a directory.', candidate)
  }
  return absolute
}

export async function lstatRepositoryPath(root: string, candidate: string): Promise<import('node:fs').Stats | undefined> {
  try {
    return await fs.lstat(await resolveRepositoryPath(root, candidate))
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return undefined
    throw error
  }
}

export async function pathExists(root: string, candidate: string): Promise<boolean> {
  return (await lstatRepositoryPath(root, candidate)) !== undefined
}

export async function readRegularBytes(root: string, candidate: string, maximum: number): Promise<Buffer> {
  const absolute = await resolveRepositoryPath(root, candidate)
  const info = await fs.lstat(absolute)
  if (!info.isFile() || info.isSymbolicLink())
    pathFault('PATH_NOT_REGULAR_FILE', 'A repository path must reference a regular file.', candidate)
  if (info.size > maximum)
    pathFault('FILE_SIZE_EXCEEDED', 'A repository file exceeds its resource limit.', candidate)
  return fs.readFile(absolute)
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
  const info = await fs.lstat(absolute)
  if (!info.isDirectory())
    pathFault('PATH_NOT_DIRECTORY', 'A repository path must reference a directory.', candidate)
  return (await fs.readdir(absolute, { withFileTypes: true }))
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
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await readDirectory(root, relative)) {
      const child = `${relative}/${entry.name}`
      if (entry.kind === 'directory') {
        await visit(child)
      }
      else if (entry.kind === 'file') {
        const absolute = await resolveRepositoryPath(root, child)
        const info = await fs.lstat(absolute)
        if (info.size > maximumFileBytes)
          pathFault('FILE_SIZE_EXCEEDED', 'A repository file exceeds its resource limit.', child)
        files.push({ path: child, bytes: await fs.readFile(absolute), mode: info.mode & 0o777 })
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
  const info = await fs.lstat(absolute)
  if (!info.isFile() || info.isSymbolicLink())
    pathFault('SOURCE_NOT_REGULAR_FILE', 'A source declaration must resolve only to regular files.', candidate)
  if (info.size > remainingBytes)
    throw new RuntimeFault('SOURCE_BYTE_LIMIT_EXCEEDED', 'A source expansion exceeds the byte limit.')
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absolute)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return { hash: hash.digest('hex'), size: info.size }
}

async function listAnchorFiles(root: string, anchor: string): Promise<readonly string[]> {
  const files: string[] = []
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await readDirectory(root, relative)) {
      const child = `${relative}/${entry.name}`
      if (entry.kind === 'directory')
        await visit(child)
      else if (entry.kind === 'file')
        files.push(child)
      else
        pathFault(entry.kind === 'symlink' ? 'PATH_SYMLINK' : 'PATH_SPECIAL_FILE', 'A source expansion encountered a non-ordinary entry.', child)
    }
  }
  await visit(anchor)
  return files.sort(compareCodeUnits)
}

export interface SourceFile {
  readonly path: string
  readonly contentHash: string
  readonly bytes: number
}

/** Expands safe source declarations and hashes raw bytes with aggregate resource limits. */
export async function expandSourcePatterns(root: string, patterns: readonly string[]): Promise<readonly SourceFile[]> {
  const selected = new Set<string>()
  for (const pattern of patterns) {
    assertSourcePattern(pattern)
    if (!hasGlob(pattern)) {
      const info = await lstatRepositoryPath(root, pattern)
      if (info === undefined)
        pathFault('SOURCE_EXACT_MISSING', 'An exact source declaration does not exist.', pattern)
      if (!info.isFile())
        pathFault('SOURCE_NOT_REGULAR_FILE', 'An exact source declaration must identify a regular file.', pattern)
      selected.add(pattern)
      continue
    }
    const anchor = pattern.split('/')[0] as string
    const anchorInfo = await lstatRepositoryPath(root, anchor)
    if (anchorInfo === undefined || !anchorInfo.isDirectory())
      pathFault('SOURCE_GLOB_ZERO_MATCH', 'A source glob matched no regular files.', pattern)
    const matches = (await listAnchorFiles(root, anchor)).filter(candidate => controlledGlobMatches(pattern, candidate))
    if (matches.length === 0)
      pathFault('SOURCE_GLOB_ZERO_MATCH', 'A source glob matched no regular files.', pattern)
    matches.forEach(candidate => selected.add(candidate))
  }

  const ordered = [...selected].sort(compareCodeUnits)
  if (ordered.length > MAX_SOURCE_FILES)
    throw new RuntimeFault('SOURCE_FILE_LIMIT_EXCEEDED', 'A source expansion exceeds the file-count limit.')
  const files: SourceFile[] = []
  let total = 0
  for (const candidate of ordered) {
    const sample = await hashRegularFile(root, candidate, MAX_SOURCE_BYTES - total)
    total += sample.size
    if (total > MAX_SOURCE_BYTES)
      throw new RuntimeFault('SOURCE_BYTE_LIMIT_EXCEEDED', 'A source expansion exceeds the byte limit.')
    files.push({ path: candidate, contentHash: sample.hash, bytes: sample.size })
  }
  return files
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

export function parsePorcelainV2(bytes: Uint8Array): readonly GitChange[] {
  const text = decodeUtf8(bytes, 'status.bin')
  if (text.length > 0 && !text.endsWith('\0'))
    throw new RuntimeFault('GIT_STATUS_INVALID', 'Git status evidence must be NUL-delimited.', 'status.bin')
  const records = text.split('\0')
  const changes: GitChange[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as string
    if (record.length === 0 || record.startsWith('# '))
      continue
    if (record.startsWith('? ')) {
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
    const unmerged = /^u [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/su.exec(record)
    if (unmerged !== null) {
      changes.push({ path: validateGitPath(unmerged[1] as string), kind: 'modified' })
      continue
    }
    throw new RuntimeFault('GIT_STATUS_INVALID', 'Git status evidence contains an unknown record.', 'status.bin')
  }
  return changes
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
  let mid: unknown
  try {
    mid = JSON.parse(decodeUtf8(raw.get('mid-operation.json') as Buffer, `${evidencePath}/mid-operation.json`).replace(/^\uFEFF/, ''))
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

  const changes = [
    ...(raw.has('diff.bin') ? parseNameStatus(raw.get('diff.bin') as Buffer) : []),
    ...parsePorcelainV2(raw.get('status.bin') as Buffer),
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
