import type { Hook } from '@aaplugin/extension-hooks'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const STATE_KEY = 'PLUGYDOWN_CONTEXT_STATE'

/** Restores the preserved state block so the first post-compact action can continue directly. */
export default {
  event: 'PostCompact',
  async run(input, _context) {
    try {
      const state = (await fs.readFile(path.join(input.cwd, '.scratch', 'cache', 'context-state.json'), 'utf8')).trim()
      if (state.length === 0)
        return { decision: 'continue' as const, reason: 'No Plugydown Context continuation state was available.' }
      return {
        decision: 'continue' as const,
        additionalContext: `${STATE_KEY}: ${state}`,
      }
    }
    catch {
      return { decision: 'continue' as const, reason: 'Plugydown Context continuation state was unavailable; perform a targeted refresh.' }
    }
  },
} satisfies Hook<'PostCompact'>
