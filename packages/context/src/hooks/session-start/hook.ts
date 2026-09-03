import type { Hook } from '@aaplugin/extension-hooks'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Best-effort discovery hint; Runtime inspection remains authoritative. */
export default {
  event: 'SessionStart',
  async run(input, _context) {
    try {
      const info = await fs.lstat(path.join(input.cwd, 'context', 'meta.json'))
      if (info.isFile()) {
        return {
          decision: 'continue' as const,
          additionalContext: 'Plugydown Context may be available. Load the Context Operating Skill and call repository.inspect before using formal knowledge.',
        }
      }
    }
    catch {
      // SessionStart is fail-open; absence and inspection errors do not affect the host session.
    }
    return { decision: 'continue' as const }
  },
} satisfies Hook<'SessionStart'>
