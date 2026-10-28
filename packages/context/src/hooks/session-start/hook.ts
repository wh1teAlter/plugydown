import type { Hook } from '@aaplugin/extension-hooks'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** 尽力提示知识可用性，正式状态仍以 Runtime 检查结果为准。 */
export default {
  event: 'SessionStart',
  /**
   * 在会话开始时尽力提示 Context 可用；读取失败也允许宿主会话继续。
   *
   * @param input - 宿主 SessionStart 输入，使用其中的 cwd 查找业务仓库账本。
   * @param _context - 宿主提供的 Hook 上下文，当前实现不使用。
   * @returns 始终允许会话继续；发现正式账本时额外附带知识发现提示。
   * @throws 文件不存在或读取失败均被忽略，不阻断宿主会话。
   * @remarks 调用阶段：宿主 SessionStart；提示不能替代 repository.inspect。
   */
  async run(input, _context) {
    try {
      // 通过 lstat 取得的文件类型、权限和大小，避免隐式跟随链接。
      const info = await fs.lstat(path.join(input.cwd, 'context', 'meta.json'))
      if (info.isFile()) {
        return {
          decision: 'continue' as const,
          additionalContext: 'Plugydown Context may be available. Load the Context Operating Skill and call repository.inspect before using formal knowledge.',
        }
      }
    }
    catch {
      // 会话启动采用容错策略：文件缺失或读取失败均不阻断宿主会话。
    }
    return { decision: 'continue' as const }
  },
} satisfies Hook<'SessionStart'>
