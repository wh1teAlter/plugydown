import type { BuildReport } from '@aaplugin/kit'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProject } from '@aaplugin/kit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import deliveries from '../../delivery.json' with { type: 'json' }
import { snapshot, verifyDelivery } from '../../scripts/verify-delivery.js'

// 待验收的插件源码包根目录。
const packageRoot = path.resolve(import.meta.dirname, '../..')
// 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
let root: string
// 交付测试独占的临时业务仓库，在 finally 中清理。
let business: string
// 本轮构建返回的完整结果，供平台交付断言复用。
let build: BuildReport
// 当前测试使用的完整 AAPlugin 配置文本。
let config: string
// 只包含初始平台集合的配置，供验证扩展平台后字节不变。
let twoPlatforms: Awaited<ReturnType<typeof snapshot>>

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugydown-platforms-'))
  for (const entry of ['src', 'public', 'extension', 'aaplugin.config.ts', 'package.json'])
    await fs.cp(path.join(packageRoot, entry), path.join(root, entry), { recursive: true })
  // 使用注册表实际安装的依赖路径，不导入上游源码或私有 Core。
  await fs.symlink(path.join(packageRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  config = await fs.readFile(path.join(root, 'aaplugin.config.ts'), 'utf8')
  business = path.join(root, 'business')
  await fs.mkdir(path.join(business, '.git'), { recursive: true })
  const original = await runProject({ cwd: root, command: 'build', platforms: ['claude-code', 'codex'] })
  expect(original.success, JSON.stringify(original.diagnostics)).toBe(true)
  twoPlatforms = await snapshot(path.join(root, 'dist'))
  build = await runProject({ cwd: root, command: 'build' })
  expect(build.success, JSON.stringify(build.diagnostics)).toBe(true)
}, 60_000)

afterAll(async () => {
  if (root !== undefined)
    await fs.rm(root, { recursive: true, force: true })
})

describe('published six-platform Context delivery', () => {
  it.each(Object.keys(deliveries) as (keyof typeof deliveries)[])('%s ships usable Runtime, roles, Skills and licenses', async (platform) => {
    const result = await verifyDelivery(root, platform, business)
    const original = await verifyDelivery(root, 'claude-code', business)
    expect(result).toEqual(original)
    // 当前平台对应的能力兼容性说明。
    const compatibility = build.compatibility.filter(entry => entry.platform === platform)
    expect(compatibility.find(entry => entry.subject === 'runtime:context')?.level).toBe('native')
    for (const id of ['investigator', 'recorder', 'reflector']) {
      expect(compatibility.find(entry => entry.subject === `internal-role:${id}` && entry.capability === 'role-delivery')?.level)
        .toBe(['claude-code', 'cursor', 'opencode'].includes(platform) ? 'native' : 'transform')
    }
    expect(compatibility.every(entry => entry.level === 'native' || entry.level === 'transform')).toBe(true)
  })

  it('validates and preserves bytes, modes and reports on repeated builds and platform expansion', async () => {
    const first = await snapshot(path.join(root, 'dist'))
    const repeated = await runProject({ cwd: root, command: 'build' })
    expect(repeated).toEqual(build)
    expect(await snapshot(path.join(root, 'dist'))).toEqual(first)
    expect((await runProject({ cwd: root, command: 'validate' })).success).toBe(true)
    expect(twoPlatforms).toEqual(Object.fromEntries(Object.entries(first).filter(([file]) => file.startsWith('claude-code/') || file.startsWith('codex/'))))
  })

  it('fails explicitly for missing Contributors and preserves the last complete output', async () => {
    const before = await snapshot(path.join(root, 'dist'))
    // 移除 Cursor 角色贡献器的故障配置，用于验证 strict 构建失败。
    const noCursor = `import { defineExtension } from '@aaplugin/kit/sdk'
${config.replace('internalRoles()]', 'withoutCursorRoles()]')}
function withoutCursorRoles() {
  const extension = internalRoles()
  return defineExtension({ ...extension, async createSession(context) {
    const session = await extension.createSession(context)
    return { ...session, contributors: session.contributors.filter(item => item.platform !== 'cursor') }
  } })
}
`
    await fs.writeFile(path.join(root, 'aaplugin.config.ts'), noCursor)
    try {
      const report = await runProject({ cwd: root, command: 'build' })
      expect(report.success).toBe(false)
      expect(report.compatibility).toEqual(expect.arrayContaining([
        expect.objectContaining({ platform: 'cursor', subject: 'internal-role:recorder', level: 'unsupported' }),
      ]))
      expect(report.compatibility.find(entry => entry.platform === 'cursor' && entry.subject === 'internal-role:recorder')?.reason).toMatch(/no compatible contributor/i)
      expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'COMPATIBILITY_STRICT_FAILURE', platform: 'cursor' })]))
      expect(await snapshot(path.join(root, 'dist'))).toEqual(before)
    }
    finally {
      await fs.writeFile(path.join(root, 'aaplugin.config.ts'), config)
    }
  })

  it('delivers the real SessionStart hint through OpenCode and Pi host callbacks using business cwd', async () => {
    // 专门验证会话启动 Hook 的隔离业务仓库。
    const startupBusiness = path.join(root, 'startup-business')
    await fs.mkdir(path.join(startupBusiness, 'context'), { recursive: true })
    await fs.writeFile(path.join(startupBusiness, 'context/meta.json'), '{}')
    // 宿主会话应收到的固定知识发现提示。
    const hint = 'Plugydown Context may be available. Load the Context Operating Skill and call repository.inspect before using formal knowledge.'
    // 从构建产物加载的真实 OpenCode Hook 模块。
    const openCodeModule = await import(pathToFileURL(path.join(root, 'dist/opencode/workspace/.opencode/plugins/aaplugin-hooks.mjs')).href)
    // 模拟宿主在当前业务仓库注册的 Hook 回调。
    const callbacks = await openCodeModule.default({ directory: startupBusiness })
    // 模拟宿主收集的系统提示数组。
    const output = { system: [] as string[] }
    await callbacks['experimental.chat.system.transform']({ sessionID: 'context-session' }, output)
    await callbacks['experimental.chat.system.transform']({ sessionID: 'context-session' }, output)
    expect(output.system).toEqual([hint])
    await callbacks.event({ event: { type: 'server.instance.disposed' } })
    // 未安装正式 Context 的仓库对应的 Hook 回调。
    const absentCallbacks = await openCodeModule.default({ directory: business })
    // 缺失 Context 时模拟宿主收集的系统提示。
    const absentOutput = { system: [] as string[] }
    await absentCallbacks['experimental.chat.system.transform']({ sessionID: 'empty-session' }, absentOutput)
    expect(absentOutput.system).toEqual([])
    await absentCallbacks.event({ event: { type: 'server.instance.disposed' } })

    // 从构建产物加载的真实 Pi Hook 模块。
    const piModule = await import(pathToFileURL(path.join(root, 'dist/pi/package/extensions/aaplugin-hooks.mjs')).href)
    // 模拟 Pi 事件总线注册的异步处理器。
    const events = new Map<string, (event: unknown, context: unknown) => Promise<unknown>>()
    // 模拟宿主实际收到的会话提示内容。
    const messages: unknown[][] = []
    piModule.default({
      /** 登记模拟宿主接收的事件处理器，供测试主动触发。 */
      on: (name: string, callback: (event: unknown, context: unknown) => Promise<unknown>) => events.set(name, callback),
      /** 收集插件向模拟宿主发送的全部消息参数。 */
      sendMessage: (...args: unknown[]) => messages.push(args),
    })
    /** 构造模拟的 Pi 会话上下文，记录系统提示追加结果。 */
    const context = (cwd: string) => ({ cwd, sessionManager: {
      /** 提供固定会话身份，使 Hook 测试不依赖真实宿主会话。 */
      getSessionId: () => 'context-session',
    } })
    await events.get('session_start')!({}, context(startupBusiness))
    expect(messages).toEqual([[{ customType: 'aaplugin-hook', content: hint, display: false }, { triggerTurn: false }]])
    messages.length = 0
    await events.get('session_start')!({}, context(business))
    expect(messages).toEqual([])
  })

  it('rejects a canonical Agent collision before publishing', async () => {
    const before = await snapshot(path.join(root, 'dist'))
    await fs.mkdir(path.join(root, 'src/agents'), { recursive: true })
    await fs.writeFile(path.join(root, 'src/agents/recorder.md'), '---\ndescription: Conflicting canonical Agent.\n---\nCollision fixture.\n')
    try {
      const report = await runProject({ cwd: root, command: 'build' })
      expect(report.success).toBe(false)
      expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CONTEXT_ROLE_AGENT_COLLISION' })]))
      expect(await snapshot(path.join(root, 'dist'))).toEqual(before)
    }
    finally {
      await fs.rm(path.join(root, 'src/agents/recorder.md'))
    }
  })
})
