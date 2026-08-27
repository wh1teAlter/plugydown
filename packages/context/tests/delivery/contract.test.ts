import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const dist = new URL('../../dist/', import.meta.url).pathname
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

function regularFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory())
      files.push(...regularFiles(file).map(child => path.join(entry.name, child)))
    else files.push(entry.name)
  }
  return files.sort()
}

describe('full delivery contract', () => {
  it('ships platform units and marketplace adds only its platform manifest', () => {
    for (const [platform, manifest] of [['claude-code', '.claude-plugin/marketplace.json'], ['codex', '.agents/plugins/marketplace.json']] as const) {
      const plugin = path.join(dist, platform, 'plugin')
      const marketplace = path.join(dist, platform, 'marketplace')
      const pluginFiles = regularFiles(plugin)
      const marketplaceFiles = regularFiles(marketplace)
      expect(marketplaceFiles.filter(file => file !== manifest)).toEqual(pluginFiles)
      expect(marketplaceFiles).toContain(manifest)
      for (const file of pluginFiles) expect(digest(path.join(plugin, file))).toBe(digest(path.join(marketplace, file)))
    }
  })

  it('keeps the shared Core runtime byte-identical and executable', () => {
    const claude = path.join(dist, 'claude-code/plugin/runtime/context/main.mjs')
    const codex = path.join(dist, 'codex/plugin/runtime/context/main.mjs')
    expect(digest(claude)).toBe(digest(codex))
    expect(statSync(claude).mode & 0o777).toBe(0o755)
    expect(statSync(codex).mode & 0o777).toBe(0o755)
  })

  it('ships every static schema and expected Command transformations', () => {
    const schemas = readdirSync(path.join(dist, 'codex/plugin/schemas')).sort()
    expect(schemas).toEqual([
      'document.schema.json',
      'meta.schema.json',
      'runtime-request.schema.json',
      'runtime-response.schema.json',
      'task-envelope.schema.json',
      'transaction-journal.schema.json',
      'transaction-manifest.schema.json',
    ])
    expect(readdirSync(path.join(dist, 'codex/plugin/skills')).sort()).toEqual(['context', 'context-init', 'context-prune', 'context-update'])
  })
})
