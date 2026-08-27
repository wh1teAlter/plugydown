import type { Hook } from '@aaplugin/extension-hooks'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Returns a short, path-free cold-start signal for the Operating Skill. */
export default {
  event: 'SessionStart',
  async run(input, _context) {
    try {
      let recognized = false
      try {
        const raw = JSON.parse(await fs.readFile(path.join(input.cwd, 'context', 'meta.json'), 'utf8')) as Record<string, unknown>
        recognized = raw.$schema === 'plugydown.context.meta/v1' && typeof raw.toolVersion === 'string'
      }
      catch {
        recognized = false
      }
      return {
        decision: 'continue' as const,
        additionalContext: recognized
          ? 'Plugydown Context is available; formal knowledge is recognized. Continue with a targeted cold-start read.'
          : 'Plugydown Context is available; formal knowledge is not recognized. Continue with a cold-start inventory.',
      }
    }
    catch {
      return { decision: 'continue' as const, reason: 'Plugydown Context status signal unavailable; continue normally.' }
    }
  },
} satisfies Hook<'SessionStart'>
