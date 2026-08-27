import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROTOCOL, ROLES_EXPECTED } from './role-constants.js'

const DIST = new URL('../../dist/', import.meta.url).pathname
const CLAUDE = path.join(DIST, 'claude-code/plugin')
const CODEX = path.join(DIST, 'codex/plugin')

/** @returns the runtime's response to one request. */
function invoke(request: unknown): Record<string, unknown> {
  const bundle = path.join(CODEX, 'runtime/context/main.mjs')
  const options = { input: JSON.stringify(request), encoding: 'utf8' as const }
  try {
    return JSON.parse(execFileSync(process.execPath, [bundle], options)) as Record<string, unknown>
  }
  catch (error) {
    const stdout = (error as { stdout?: string }).stdout
    if (typeof stdout !== 'string' || stdout.length === 0)
      throw error
    return JSON.parse(stdout) as Record<string, unknown>
  }
}

/** @returns the body of a Markdown file with front matter stripped. */
function body(file: string): string {
  const source = readFileSync(file, 'utf8')
  return (/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(source)?.[1] ?? source).trim()
}

describe('claude Code native Agents', () => {
  it('delivers exactly the three roles as native Agents', () => {
    expect(readdirSync(path.join(CLAUDE, 'agents')).sort())
      .toEqual(ROLES_EXPECTED.map(role => `${role}.md`))
  })

  it('lets the Platform declare the manifest field', () => {
    const manifest = JSON.parse(readFileSync(path.join(CLAUDE, '.claude-plugin/plugin.json'), 'utf8'))
    expect(manifest.agents).toBe('./agents/')
  })

  it('renders each Agent with a native name and description', () => {
    for (const role of ROLES_EXPECTED) {
      const source = readFileSync(path.join(CLAUDE, 'agents', `${role}.md`), 'utf8')
      expect(source).toMatch(new RegExp(`^---[\\s\\S]*\\bname: ${role}\\b`))
      expect(source).toMatch(/\bdescription: \S/)
    }
  })

  it('does not deliver role resources to Claude as runtime data', () => {
    expect(() => statSync(path.join(CLAUDE, 'runtime/agents'))).toThrow()
  })
})

describe('codex private runtime resources', () => {
  it('delivers exactly the three roles as runtime data', () => {
    expect(readdirSync(path.join(CODEX, 'runtime/agents')).sort())
      .toEqual(ROLES_EXPECTED.map(role => `${role}.md`))
  })

  it('marks each resource as a private runtime resource', () => {
    for (const role of ROLES_EXPECTED) {
      expect(readFileSync(path.join(CODEX, 'runtime/agents', `${role}.md`), 'utf8'))
        .toContain('delivery: private-runtime-resource')
    }
  })

  it('does not register Codex Agents', () => {
    expect(() => statSync(path.join(CODEX, 'agents'))).toThrow()
  })

  it('does not collide with the Core runtime entry', () => {
    expect(statSync(path.join(CODEX, 'runtime/context/main.mjs')).isFile()).toBe(true)
    expect(statSync(path.join(CODEX, 'runtime/agents')).isDirectory()).toBe(true)
  })
})

describe('no fallback Skill on either platform', () => {
  it.each([['claude-code', CLAUDE], ['codex', CODEX]])('%s emits no agent-* Skill', (_name, root) => {
    const skills = path.join(root, 'skills')
    expect(readdirSync(skills).filter(entry => entry.startsWith('agent-'))).toEqual([])
  })

  it('keeps the Codex Skill namespace to the Operating Skill and Commands', () => {
    expect(readdirSync(path.join(CODEX, 'skills')).sort())
      .toEqual(['context', 'context-init', 'context-prune', 'context-update'])
  })
})

describe('one authoritative role text', () => {
  it.each(ROLES_EXPECTED)('%s has the same body on both platforms', (role) => {
    expect(body(path.join(CODEX, 'runtime/agents', `${role}.md`)))
      .toBe(body(path.join(CLAUDE, 'agents', `${role}.md`)))
  })

  it('never leaks envelope-owned fields into the role text', () => {
    for (const role of ROLES_EXPECTED) {
      const text = body(path.join(CLAUDE, 'agents', `${role}.md`))
      expect(text).not.toMatch(/\.scratch\/runs\//)
      expect(text).not.toMatch(/estimatedTokens/)
      expect(text).not.toMatch(/plugydown\.context\.\w+\/v1/)
    }
  })
})

describe('task envelope parity', () => {
  /** @returns the envelope payload for one execution style. */
  function envelope(execution: 'native-agent' | 'inline'): Record<string, unknown> {
    const response = invoke({
      protocol: PROTOCOL,
      capability: 'role.envelope',
      params: {
        role: 'investigator',
        goal: 'Establish how retries are implemented.',
        execution,
        pluginRoot: CODEX,
      },
    })
    expect(response.status).toBe('success')
    return response.data as Record<string, unknown>
  }

  it('differs between hosts only by the carried role body', () => {
    const native = envelope('native-agent')
    const inline = envelope('inline')

    expect(native.roleBody).toBeUndefined()
    expect(typeof inline.roleBody).toBe('string')

    const { roleBody: _dropped, ...inlineRest } = inline
    expect(inlineRest).toEqual(native)
  })

  it('carries the authoritative role text when the host executes inline', () => {
    expect(envelope('inline').roleBody).toBe(body(path.join(CODEX, 'runtime/agents/investigator.md')))
  })

  it('states plainly that inline execution shares the caller context', () => {
    const response = invoke({
      protocol: PROTOCOL,
      capability: 'role.envelope',
      params: { role: 'investigator', goal: 'g', execution: 'inline', pluginRoot: CODEX },
    })
    expect(String(response.summary)).toContain('shares')
  })

  it('refuses an unknown role instead of inventing one', () => {
    const response = invoke({
      protocol: PROTOCOL,
      capability: 'role.envelope',
      params: { role: 'worker', goal: 'g' },
    })
    expect(response.status).toBe('incomplete')
  })

  it('refuses inline execution it cannot supply a body for', () => {
    const response = invoke({
      protocol: PROTOCOL,
      capability: 'role.envelope',
      params: { role: 'recorder', goal: 'g', execution: 'inline' },
    })
    expect(response.status).toBe('incomplete')
    expect(String(response.summary)).toContain('pluginRoot')
  })

  it.each(['investigator', 'reflector', 'recorder'])('scopes %s writes to its own area', (role) => {
    const response = invoke({
      protocol: PROTOCOL,
      capability: 'role.envelope',
      params: { role, goal: 'g', execution: 'native-agent' },
    })
    const data = response.data as { allowedWrites: string[] }
    expect(data.allowedWrites.every(target => target.startsWith('.scratch/'))).toBe(true)
    expect(data.allowedWrites.some(target => target.startsWith('context/'))).toBe(false)
  })
})
