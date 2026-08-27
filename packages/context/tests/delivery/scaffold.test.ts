import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIST = new URL('../../dist/', import.meta.url).pathname

function unit(platform: string, kind: 'plugin' | 'marketplace'): string {
  return join(DIST, platform, kind)
}

function files(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory())
        walk(join(dir, entry.name), rel)
      else
        out.push(rel)
    }
  }
  walk(root, '')
  return out
}

const SCHEMAS = [
  'document',
  'meta',
  'runtime-request',
  'runtime-response',
  'task-envelope',
  'transaction-journal',
  'transaction-manifest',
]

describe('delivery units', () => {
  it.each(['claude-code', 'codex'])('%s emits a plugin and a marketplace unit', (platform) => {
    expect(existsSync(unit(platform, 'plugin'))).toBe(true)
    expect(existsSync(unit(platform, 'marketplace'))).toBe(true)
  })

  it.each(['claude-code', 'codex'])('%s marketplace is the plugin plus exactly one manifest', (platform) => {
    const plugin = files(unit(platform, 'plugin'))
    const marketplace = files(unit(platform, 'marketplace'))
    const extra = marketplace.filter(path => !plugin.includes(path))

    expect(marketplace).toEqual(expect.arrayContaining(plugin))
    expect(extra).toHaveLength(1)
    expect(extra[0]).toMatch(/marketplace\.json$/)
  })

  it.each(['claude-code', 'codex'])('%s inherits every plugin asset byte-for-byte', (platform) => {
    for (const path of files(unit(platform, 'plugin'))) {
      expect(readFileSync(join(unit(platform, 'marketplace'), path)))
        .toEqual(readFileSync(join(unit(platform, 'plugin'), path)))
    }
  })
})

describe('canonical components', () => {
  it('emits native Commands and the Operating Skill for Claude Code', () => {
    const emitted = files(unit('claude-code', 'plugin'))
    expect(emitted).toContain('commands/init.md')
    expect(emitted).toContain('commands/update.md')
    expect(emitted).toContain('commands/prune.md')
    expect(emitted).toContain('skills/context/SKILL.md')
  })

  it('emits plugin-prefixed Codex Command Skills under the new brand', () => {
    const skills = readdirSync(join(unit('codex', 'plugin'), 'skills')).sort()
    expect(skills).toEqual(['context', 'context-init', 'context-prune', 'context-update'])
  })

  it('copies Skill auxiliary references to both platforms', () => {
    for (const platform of ['claude-code', 'codex']) {
      const emitted = files(unit(platform, 'plugin'))
      expect(emitted).toContain('skills/context/references/frontier.md')
      expect(emitted).toContain('skills/context/references/context-continuation.md')
      expect(emitted).toContain('skills/context/references/task-completion.md')
    }
  })
})

describe('public schemas', () => {
  it.each(['claude-code', 'codex'])('%s receives all seven schemas at the plugin root', (platform) => {
    const emitted = files(unit(platform, 'plugin'))
    for (const name of SCHEMAS)
      expect(emitted).toContain(`schemas/${name}.schema.json`)
  })

  it.each(['claude-code', 'codex'])('%s schemas declare the Plugydown Context namespace', (platform) => {
    for (const name of SCHEMAS) {
      const schema = JSON.parse(readFileSync(join(unit(platform, 'plugin'), 'schemas', `${name}.schema.json`), 'utf8'))
      expect(schema.$id).toBe(`https://plugydown.dev/schemas/context/${name}/v1.json`)
    }
  })
})

describe('forbidden output', () => {
  it.each(['claude-code', 'codex'])('%s emits no agent fallback Skill', (platform) => {
    expect(files(unit(platform, 'plugin')).filter(path => path.startsWith('skills/agent-'))).toEqual([])
  })

  it.each(['claude-code', 'codex'])('%s emits no migration surface and no retired brand', (platform) => {
    for (const path of files(unit(platform, 'plugin'))) {
      expect(path).not.toMatch(new RegExp(['^upgrade', 'upgrade', 'migrate'].join('|'), 'i'))
      const body = readFileSync(join(unit(platform, 'plugin'), path), 'utf8')
      expect(body).not.toMatch(new RegExp([
        '@tokenroll',
        'ac' + 'plugin',
        'LLM' + 'DOC_STATE',
        `${'llm' + 'doc'}\\.(document|meta)/v1`,
        `\\.${'llm' + 'doc'}-tmp`,
      ].join('|')))
    }
  })
})
