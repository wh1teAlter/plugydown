import { promises as fs } from 'node:fs'
import path from 'node:path'
import { CODES, RuntimeError } from './errors.js'

/** Shell and Windows style variable references that must already have been expanded. */
const UNEXPANDED_VARIABLE = /\$\{?[A-Z_]\w*\}?|%[A-Z_]\w*%/i

/** Glob metacharacters recognised by the bounded-glob rule. */
const GLOB_META = /[*?[\]{}]/

/** @returns whether `child` is `parent` itself or lies beneath it. */
function contains(parent: string, child: string): boolean {
  if (child === parent)
    return true
  return child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`)
}

/**
 * Resolves the deepest existing ancestor of a path, then re-appends the missing tail.
 *
 * A path that does not exist yet still has to be proven safe, and `realpath` refuses to
 * resolve it. Resolving the existing prefix catches a symlinked parent, which is the case
 * that actually escapes.
 *
 * @param absolute an absolute path that may not exist.
 * @returns the absolute path with every existing component fully resolved.
 */
async function realpathOfNearestExisting(absolute: string): Promise<string> {
  const missing: string[] = []
  let current = absolute

  for (;;) {
    try {
      const resolved = await fs.realpath(current)
      return missing.length === 0 ? resolved : path.join(resolved, ...missing.reverse())
    }
    catch {
      const parent = path.dirname(current)
      if (parent === current)
        return absolute
      missing.push(path.basename(current))
      current = parent
    }
  }
}

/**
 * Rejects a repository-relative path that is unsafe on its own terms.
 *
 * These checks are purely lexical, so they hold even for paths that do not exist yet — which
 * matters because candidate staging names paths before it creates them.
 *
 * @param candidate the repository-relative path.
 * @throws RuntimeError when the path is absolute, escapes, or is otherwise unusable.
 */
export function assertSafeRelativePath(candidate: string): void {
  if (candidate.length === 0)
    throw new RuntimeError(CODES.PATH_EMPTY, 'A repository path must not be empty.')
  if (candidate.includes('\0'))
    throw new RuntimeError(CODES.PATH_NUL_BYTE, 'A repository path must not contain a NUL byte.')
  if (UNEXPANDED_VARIABLE.test(candidate))
    throw new RuntimeError(CODES.PATH_UNEXPANDED_VARIABLE, 'A repository path must not contain an unexpanded variable reference.')
  if (path.isAbsolute(candidate) || /^[a-z]:/i.test(candidate))
    throw new RuntimeError(CODES.PATH_ABSOLUTE, 'A repository path must be relative to the repository root.')

  if (candidate.split(/[/\\]/).includes('..'))
    throw new RuntimeError(CODES.PATH_TRAVERSAL, 'A repository path must not contain a parent segment.')
}

/**
 * Rejects a glob that is not anchored to a concrete directory.
 *
 * An unanchored pattern such as `**` or `*.ts` makes the impact set unbounded, which turns a
 * document's `code.paths` declaration into something neither reviewable nor fingerprintable.
 *
 * @param pattern the repository-relative glob.
 * @throws RuntimeError when the glob is unsafe or unbounded.
 */
export function assertBoundedGlob(pattern: string): void {
  assertSafeRelativePath(pattern)

  const segments = pattern.split('/')
  if (GLOB_META.test(segments[0] ?? ''))
    throw new RuntimeError(CODES.GLOB_UNBOUNDED, 'A glob must be anchored to a concrete first directory segment.')
  if (segments.filter(segment => segment === '**').length > 1)
    throw new RuntimeError(CODES.GLOB_UNBOUNDED, 'A glob must not contain more than one recursive segment.')
}

/**
 * Resolves a repository-relative path and proves it stays inside the repository.
 *
 * The lexical checks run first, then the resolved path is compared against the real repository
 * root so that a symlink cannot carry a legal-looking path outside the tree.
 *
 * @param root absolute repository root.
 * @param candidate repository-relative path.
 * @returns the absolute resolved path.
 * @throws RuntimeError when the path is unsafe or escapes the repository.
 */
export async function resolveInsideRepository(root: string, candidate: string): Promise<string> {
  assertSafeRelativePath(candidate)

  const realRoot = await fs.realpath(root)
  const absolute = path.resolve(realRoot, candidate)
  if (!contains(realRoot, absolute))
    throw new RuntimeError(CODES.PATH_TRAVERSAL, 'A repository path must resolve inside the repository.')

  if (!contains(realRoot, await realpathOfNearestExisting(absolute)))
    throw new RuntimeError(CODES.PATH_SYMLINK_ESCAPE, 'A repository path must not resolve outside the repository through a symlink.')

  return absolute
}

/**
 * Reads a repository-relative regular file.
 *
 * @param root absolute repository root.
 * @param candidate repository-relative path.
 * @returns the file contents as UTF-8.
 * @throws RuntimeError when the path is unsafe or is not a regular file.
 */
export async function readRepositoryFile(root: string, candidate: string): Promise<string> {
  const absolute = await resolveInsideRepository(root, candidate)
  const stats = await fs.lstat(absolute)
  if (stats.isSymbolicLink() || !stats.isFile())
    throw new RuntimeError(CODES.PATH_SPECIAL_FILE, 'A repository path must reference a regular file.')
  return fs.readFile(absolute, 'utf8')
}

/** One immediate child of a repository directory. */
export interface DirectoryEntry {
  readonly name: string
  readonly kind: 'directory' | 'file'
}

/**
 * Lists the immediate entries of a repository-relative directory.
 *
 * Symlinks and special files are dropped rather than followed: the knowledge tree is defined
 * by real files, and following a link would reintroduce the escape the path rules just closed.
 *
 * @param root absolute repository root.
 * @param candidate repository-relative directory.
 * @returns directory and regular-file entries, ordered by code unit.
 */
export async function listRepositoryDirectory(root: string, candidate: string): Promise<readonly DirectoryEntry[]> {
  const absolute = await resolveInsideRepository(root, candidate)

  return (await fs.readdir(absolute, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() || entry.isFile())
    .map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' as const : 'file' as const }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
}

/** @returns whether a repository-relative path exists at all. */
export async function repositoryPathExists(root: string, candidate: string): Promise<boolean> {
  try {
    await fs.lstat(await resolveInsideRepository(root, candidate))
    return true
  }
  catch {
    return false
  }
}
