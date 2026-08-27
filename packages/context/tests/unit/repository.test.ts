import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RuntimeError } from '../../src/runtime/errors.js'
import {
  assertBoundedGlob,
  assertSafeRelativePath,
  listRepositoryDirectory,
  readRepositoryFile,
  repositoryPathExists,
  resolveInsideRepository,
} from '../../src/runtime/repository.js'

let root = ''
let outside = ''

beforeAll(async () => {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'plugydown-repo-'))
  root = path.join(base, 'repo')
  outside = path.join(base, 'outside')
  await fs.mkdir(path.join(root, 'context', 'billing'), { recursive: true })
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(path.join(root, 'context', 'billing', 'domain.md'), '# billing\n')
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret\n')
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'))
  await fs.symlink(outside, path.join(root, 'leak-dir'))
})

afterAll(async () => {
  if (root !== '')
    await fs.rm(path.dirname(root), { recursive: true, force: true })
})

/** @returns the stable code of the RuntimeError a call throws. */
async function codeOf(run: () => unknown | Promise<unknown>): Promise<string> {
  try {
    await run()
  }
  catch (error) {
    expect(error).toBeInstanceOf(RuntimeError)
    return (error as RuntimeError).code
  }
  throw new Error('expected the call to reject')
}

// The variable-reference cases are literal input the runtime must reject, not templates.
/* eslint-disable no-template-curly-in-string */
describe('lexical path rules', () => {
  it.each([
    ['', 'PATH_EMPTY'],
    ['con\0text/a.md', 'PATH_NUL_BYTE'],
    ['$HOME/a.md', 'PATH_UNEXPANDED_VARIABLE'],
    ['${HOME}/a.md', 'PATH_UNEXPANDED_VARIABLE'],
    ['%APPDATA%/a.md', 'PATH_UNEXPANDED_VARIABLE'],
    ['/etc/passwd', 'PATH_ABSOLUTE'],
    ['C:/Windows/a.md', 'PATH_ABSOLUTE'],
    ['../outside/a.md', 'PATH_TRAVERSAL'],
    ['context/../../a.md', 'PATH_TRAVERSAL'],
    ['context\\..\\a.md', 'PATH_TRAVERSAL'],
  ])('rejects %j with %s', async (candidate, code) => {
    expect(await codeOf(() => assertSafeRelativePath(candidate))).toBe(code)
  })

  it('accepts an ordinary repository-relative path', () => {
    expect(() => assertSafeRelativePath('context/billing/domain.md')).not.toThrow()
  })
})

/* eslint-enable no-template-curly-in-string */

describe('bounded globs', () => {
  it.each(['*.ts', '**/a.ts', '**', '{src,lib}/a.ts'])('rejects unanchored %j', async (pattern) => {
    expect(await codeOf(() => assertBoundedGlob(pattern))).toBe('GLOB_UNBOUNDED')
  })

  it('rejects more than one recursive segment', async () => {
    expect(await codeOf(() => assertBoundedGlob('src/**/nested/**/a.ts'))).toBe('GLOB_UNBOUNDED')
  })

  it.each(['src/**/*.ts', 'src/api/retry.ts', 'src/api/*.ts'])('accepts anchored %j', (pattern) => {
    expect(() => assertBoundedGlob(pattern)).not.toThrow()
  })
})

describe('symlink escape', () => {
  it('rejects a file symlink pointing outside the repository', async () => {
    expect(await codeOf(() => resolveInsideRepository(root, 'leak.txt'))).toBe('PATH_SYMLINK_ESCAPE')
  })

  it('rejects a path travelling through a directory symlink', async () => {
    expect(await codeOf(() => resolveInsideRepository(root, 'leak-dir/secret.txt'))).toBe('PATH_SYMLINK_ESCAPE')
  })

  it('refuses to read through a symlink even when it stays inside', async () => {
    await fs.symlink(path.join(root, 'context', 'billing', 'domain.md'), path.join(root, 'inside-link.md'))
    expect(await codeOf(() => readRepositoryFile(root, 'inside-link.md'))).toBe('PATH_SPECIAL_FILE')
  })

  it('resolves a path that does not exist yet', async () => {
    await expect(resolveInsideRepository(root, 'context/new/pending.md')).resolves.toContain('pending.md')
  })
})

describe('reads', () => {
  it('reads a regular file', async () => {
    await expect(readRepositoryFile(root, 'context/billing/domain.md')).resolves.toBe('# billing\n')
  })

  it('lists entries in code-unit order', async () => {
    const entries = await listRepositoryDirectory(root, 'context/billing')
    expect(entries).toEqual([{ name: 'domain.md', kind: 'file' }])
  })

  it('reports existence without throwing on unsafe input', async () => {
    await expect(repositoryPathExists(root, '../outside')).resolves.toBe(false)
    await expect(repositoryPathExists(root, 'context')).resolves.toBe(true)
  })
})
