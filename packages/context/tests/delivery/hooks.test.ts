import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DIST = new URL('../../dist/', import.meta.url).pathname

describe('hooks delivery contract', () => {
  it('ships exactly the three portable events on both platforms', () => {
    for (const platform of ['claude-code', 'codex']) {
      const root = path.join(DIST, platform, 'plugin', 'hooks')
      expect(readdirSync(root).filter(entry => entry !== 'hooks.json').sort()).toEqual(['post-compact', 'pre-compact', 'session-start'])
      const hooks = JSON.parse(readFileSync(path.join(root, 'hooks.json'), 'utf8')) as { hooks: Record<string, unknown> }
      expect(Object.keys(hooks.hooks).sort()).toEqual(['PostCompact', 'PreCompact', 'SessionStart'])
      expect(Object.keys(hooks.hooks)).not.toContain('Stop')
    }
  })

  it('does not contain a hand-authored hooks wire file in source', () => {
    expect(() => readFileSync(path.join(new URL('../../src/hooks/hooks.json', import.meta.url).pathname))).toThrow()
  })
})
