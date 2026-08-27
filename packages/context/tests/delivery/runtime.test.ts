import { execFileSync } from 'node:child_process'
import { promises as fs, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PROTOCOL } from '../../src/runtime/constants.js'

const DIST = new URL('../../dist/', import.meta.url).pathname
const UNITS = ['claude-code/plugin', 'claude-code/marketplace', 'codex/plugin', 'codex/marketplace']

/** @returns the delivered runtime bundle path for a unit. */
function bundle(unit: string): string {
  return path.join(DIST, unit, 'runtime', 'context', 'main.mjs')
}

/** @returns the runtime's response to one request, executed in `cwd`. */
function invoke(unit: string, request: unknown, cwd: string): Record<string, unknown> {
  const options = { input: JSON.stringify(request), cwd, encoding: 'utf8' as const }
  try {
    return JSON.parse(execFileSync(process.execPath, [bundle(unit)], options)) as Record<string, unknown>
  }
  catch (error) {
    const stdout = (error as { stdout?: string }).stdout
    if (typeof stdout !== 'string' || stdout.length === 0)
      throw error
    return JSON.parse(stdout) as Record<string, unknown>
  }
}

let empty = ''

beforeAll(async () => {
  empty = await fs.mkdtemp(path.join(tmpdir(), 'plugydown-empty-'))
})

afterAll(async () => {
  if (empty !== '')
    await fs.rm(empty, { recursive: true, force: true })
})

describe('core-managed runtime delivery', () => {
  it.each(UNITS)('%s carries the runtime bundle', (unit) => {
    expect(statSync(bundle(unit)).isFile()).toBe(true)
  })

  it.each(UNITS)('%s marks the bundle executable', (unit) => {
    expect(statSync(bundle(unit)).mode & 0o777).toBe(0o755)
  })

  it('delivers byte-identical bytes to both platforms', async () => {
    const claude = await fs.readFile(bundle('claude-code/plugin'))
    const codex = await fs.readFile(bundle('codex/plugin'))
    expect(codex.equals(claude)).toBe(true)
  })

  it('bundles dependencies so only node: builtins remain external', async () => {
    const source = await fs.readFile(bundle('claude-code/plugin'), 'utf8')
    for (const specifier of source.matchAll(/\bfrom\s*'([^']+)'/g))
      expect(specifier[1]).toMatch(/^node:/)
  })
})

describe('runtime protocol over the delivered bundle', () => {
  it('answers --help without touching a repository', () => {
    const stdout = execFileSync(process.execPath, [bundle('codex/plugin'), '--help'], { encoding: 'utf8' })
    expect(JSON.parse(stdout)).toMatchObject({ protocol: PROTOCOL })
  })

  it('inspects a repository with no formal knowledge', () => {
    const response = invoke('codex/plugin', { protocol: PROTOCOL, capability: 'repository.inspect' }, empty)
    expect(response.status).toBe('success')
    expect(response.data).toMatchObject({ present: false, domains: [] })
  })

  it('rejects a foreign protocol with a stable code', () => {
    const response = invoke('codex/plugin', { protocol: 'llmdoc.runtime/v1', capability: 'repository.inspect' }, empty)
    expect(response.status).toBe('failed')
    expect(response.diagnostics).toMatchObject([{ code: 'PROTOCOL_MISMATCH' }])
  })

  it('reports incomplete when a transaction lacks its required candidate', () => {
    const response = invoke('codex/plugin', { protocol: PROTOCOL, capability: 'transaction.run' }, empty)
    expect(response.status).toBe('incomplete')
    expect(response.summary).toContain('Transaction command')
  })

  it('emits no absolute path, timestamp, or environment value', () => {
    const response = invoke('codex/plugin', { protocol: PROTOCOL, capability: 'repository.inspect' }, empty)
    const serialized = JSON.stringify(response)
    expect(serialized).not.toContain(empty)
    expect(serialized).not.toContain(tmpdir())
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/)
  })
})
