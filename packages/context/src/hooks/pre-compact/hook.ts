import type { Hook } from '@aaplugin/extension-hooks'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const STATE_KEY = 'PLUGYDOWN_CONTEXT_STATE'

/** Persists the compact state block without touching formal knowledge. */
export default {
  event: 'PreCompact',
  async run(input, _context) {
    try {
      const source = input.customInstructions ?? ''
      const marker = new RegExp(`${STATE_KEY}\\s*[:=]\\s*([\\s\\S]+)`).exec(source)?.[1]?.trim()
      if (marker === undefined || marker.length === 0)
        return { decision: 'continue' as const, reason: 'No Plugydown Context state block was present before compaction.' }
      const directory = path.join(input.cwd, '.scratch', 'cache')
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(path.join(directory, 'context-state.json'), marker)
      return { decision: 'continue' as const, reason: 'Plugydown Context state was preserved for compaction continuation.' }
    }
    catch {
      return { decision: 'continue' as const, reason: 'Plugydown Context state could not be preserved; continue normally.' }
    }
  },
} satisfies Hook<'PreCompact'>
