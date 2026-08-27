import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import postCompact from '../../src/hooks/post-compact/hook.js'
import preCompact from '../../src/hooks/pre-compact/hook.js'
import sessionStart from '../../src/hooks/session-start/hook.js'
import { createEmptyFixture, removeFixture } from '../helpers/fixture.js'

const created: string[] = []
afterEach(async () => Promise.all(created.splice(0).map(removeFixture)))

describe('compact continuity hooks', () => {
  it('round-trips the state block through PreCompact and PostCompact', async () => {
    const root = await createEmptyFixture()
    created.push(root)
    const input = { event: 'PreCompact' as const, sessionId: 's', cwd: root, trigger: 'manual', customInstructions: 'PLUGYDOWN_CONTEXT_STATE: {"goal":"ship"}' }
    const context = { platform: 'codex', pluginRoot: root, pluginData: root }
    expect(await preCompact.run(input, context)).toMatchObject({ decision: 'continue' })
    const restored = await postCompact.run({ event: 'PostCompact', sessionId: 's', cwd: root, trigger: 'manual' }, context)
    expect(restored).toMatchObject({ additionalContext: 'PLUGYDOWN_CONTEXT_STATE: {"goal":"ship"}' })
  })

  it('fails open when state is absent or storage is unavailable', async () => {
    const root = await createEmptyFixture()
    created.push(root)
    const result = await postCompact.run({ event: 'PostCompact', sessionId: 's', cwd: path.join(root, 'missing'), trigger: 'automatic' }, { platform: 'codex', pluginRoot: root, pluginData: root })
    expect(result).toMatchObject({ decision: 'continue' })
  })

  it('sessionStart emits a short signal without reading document bodies', async () => {
    const root = await createEmptyFixture()
    created.push(root)
    await fs.mkdir(path.join(root, 'context'), { recursive: true })
    await fs.writeFile(path.join(root, 'context/meta.json'), JSON.stringify({ $schema: 'plugydown.context.meta/v1', toolVersion: '0.1.0' }))
    const result = await sessionStart.run({ event: 'SessionStart', sessionId: 's', cwd: root, source: 'startup' }, { platform: 'codex', pluginRoot: root, pluginData: root })
    expect(result).toMatchObject({ decision: 'continue' })
    expect(String(result.additionalContext)).toContain('recognized')
  })
})
