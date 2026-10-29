import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { readConfirmationStore } from '../../src/runtime/confirmation.js'
import { createRepository, handle, PROTOCOL, removeRepository, SERVICE_DOMAIN, writeMeta } from './fixture.js'

// 动态载入原样交付的宿主 JS；该资源不经过第二套构建流程。
const integration = await import(new URL('../../public/integrations/retention.mjs', import.meta.url).href)
// 每个测试只清理自己创建的仓库与 worktree。
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRepository))
})

/** 在隔离仓库执行固定身份的 Git 命令，不写用户配置。 */
function git(root: string, args: string[]): string {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  return execFileSync('git', ['-c', 'user.name=Context Fixture', '-c', 'user.email=context@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...environment, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: '@1 +0000', GIT_COMMITTER_DATE: '@1 +0000' },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

/** 固定提交测试输入，禁止依赖工作站作者或时间。 */
function commit(root: string, message: string): string {
  git(root, ['add', '.'])
  git(root, ['commit', '-m', message])
  return git(root, ['rev-parse', 'HEAD'])
}

/** 使用真实 handler 验证宿主提交的协议，测试无需依赖个人插件路径。 */
function invoke(root: string, _runtime: string, capability: string, input = {}, action?: string, cursor?: string) {
  return handle(root, { protocol: PROTOCOL, format: 1, capability, input, ...(action === undefined ? {} : { action }), ...(cursor === undefined ? {} : { cursor }) })
}

/** 创建来源各异、真实可重现的二十五条确认，保存源码与 key 的对应关系。 */
async function repository() {
  const root = await createRepository({ documents: [SERVICE_DOMAIN], git: false })
  roots.push(root)
  git(root, ['init', '-b', 'main'])
  await fs.writeFile(path.join(root, '.gitignore'), '.scratch/\n')
  const sourceByKey = new Map<string, string>()
  for (let index = 0; index < 24; index++) {
    const source = `export const service = ${index}\n`
    await fs.writeFile(path.join(root, 'src/service.ts'), source)
    const before = new Set((await readConfirmationStore(root, 1)).records.get('service')!.keys())
    await writeMeta(root, [SERVICE_DOMAIN])
    const key = [...(await readConfirmationStore(root, 1)).records.get('service')!.keys()].find(key => !before.has(key))!
    sourceByKey.set(key, source)
  }
  const base = commit(root, 'fixture: confirmed history')
  return { root, base, sourceByKey, runtime: 'protocol-fixture', invoke }
}

describe('centralized retention host integration', () => {
  it('ships a disabled-by-default PR producer and an independent read-only merge-queue guard', async () => {
    const producerText = await fs.readFile(new URL('../../public/integrations/retention-proposal.yml', import.meta.url), 'utf8')
    const guardText = await fs.readFile(new URL('../../public/integrations/retention-guard.yml', import.meta.url), 'utf8')
    const producer = parseYaml(producerText)
    const guard = parseYaml(guardText)
    expect(producer.jobs.propose.if).toBe('vars.CONTEXT_RETENTION_ENABLED == \'true\'')
    expect(producer.concurrency).toEqual({ 'group': 'context-retention-proposal', 'cancel-in-progress': false })
    expect(producerText).toContain('git push origin "HEAD:refs/heads/$BRANCH"')
    expect(producerText).not.toMatch(/git push[^\n]*(?:--force|:main|:refs\/heads\/main)/)
    expect(producerText).toContain('--auto --squash')
    expect(guard.permissions).toEqual({ contents: 'read' })
    expect(guard.on.merge_group.types).toContain('checks_requested')
    expect(guardText).toContain('verifyRetentionMerge')
    expect(guardText).toContain('pr.user.login === process.env.EXPECTED_ACTOR')
    expect(guardText).not.toContain('CONTEXT_MAINTENANCE_TOKEN')
  })

  it('rebases an append-only development branch onto actual Runtime cleanup without record conflicts', async () => {
    const options = await repository()
    git(options.root, ['switch', '-c', 'topic'])
    await fs.writeFile(path.join(options.root, 'src/service.ts'), 'export const service = "topic"\n')
    await writeMeta(options.root, [SERVICE_DOMAIN])
    const topic = commit(options.root, 'fixture: topic confirmation')
    git(options.root, ['switch', 'main'])
    await integration.prepareRetention(options)
    const main = commit(options.root, 'fixture: centralized retention')
    expect(integration.auditContribution({ root: options.root, base: main, head: topic })).toMatchObject({ addedCount: 1 })
    git(options.root, ['switch', 'topic'])
    git(options.root, ['rebase', 'main'])
    expect((await readConfirmationStore(options.root, 1)).count).toBe(11)
    expect((await invoke(options.root, options.runtime, 'confirmation.check')).data!.items).toMatchObject([{ confirmationState: 'matched' }])
  })

  it('prepares only deletions and independently verifies the exact maintenance commit', async () => {
    const options = await repository()
    const prepared = await integration.prepareRetention(options)
    expect(prepared).toMatchObject({ status: 'prepared', base: options.base, retention: { afterCount: 10 } })
    const head = commit(options.root, 'fixture: compact')
    expect(() => integration.auditContribution({ ...options, head })).toThrow('only add')
    expect(await integration.verifyRetention({ ...options, root: path.relative(process.cwd(), options.root), head })).toMatchObject({ status: 'success', removedCount: 15 })
    expect(await integration.verifyRetentionMerge({ ...options, head })).toMatchObject({ status: 'success', removedCount: 15 })
    expect(git(options.root, ['status', '--porcelain'])).toBe('')
  })

  it('checks the actual merge result and refuses deletion of a now-current source basis', async () => {
    const options = await repository()
    const before = new Set((await readConfirmationStore(options.root, 1)).records.get('service')!.keys())
    await integration.prepareRetention(options)
    commit(options.root, 'fixture: compact')
    const after = new Set((await readConfirmationStore(options.root, 1)).records.get('service')!.keys())
    const removed = [...before].find(key => !after.has(key) && options.sourceByKey.has(key))!
    await fs.writeFile(path.join(options.root, 'src/service.ts'), options.sourceByKey.get(removed)!)
    const head = commit(options.root, 'fixture: source returns to discarded basis')
    await expect(integration.verifyRetentionMerge({ ...options, head })).rejects.toThrow('discarded confirmation')
    await expect(integration.verifyRetention({ ...options, head })).rejects.toThrow('based directly')
    expect(git(options.root, ['status', '--porcelain'])).toBe('')
  })

  it('allows a mixed merge result whose source-only drift was not worsened by retention', async () => {
    const options = await repository()
    await integration.prepareRetention(options)
    commit(options.root, 'fixture: compact')
    await fs.writeFile(path.join(options.root, 'src/service.ts'), 'export const service = "new source"\n')
    const head = commit(options.root, 'fixture: ordinary source change')
    expect(await integration.verifyRetentionMerge({ ...options, head })).toMatchObject({ status: 'success' })
  })

  it('leaves an uncertain begin result and its evidence available for recovery', async () => {
    const options = await repository()
    /** 模拟 Runtime 已成功 begin，但宿主丢失了响应的传输中断。 */
    const interrupted = async (...args: Parameters<typeof invoke>) => {
      const response = await invoke(...args)
      if (args[4] === 'begin')
        throw new Error('fixture lost response')
      return response
    }
    await expect(integration.prepareRetention({ ...options, invoke: interrupted })).rejects.toThrow('lost response')
    expect((await fs.readdir(path.join(options.root, '.scratch/evidence'))).length).toBe(1)
    expect((await fs.lstat(path.join(options.root, '.scratch/locks/context-write'))).isDirectory()).toBe(true)
    expect((await readConfirmationStore(options.root, 1)).count).toBe(25)
  })

  it('rejects dirty or moving checkouts before starting a write', async () => {
    const options = await repository()
    await fs.writeFile(path.join(options.root, 'untracked.txt'), 'user work\n')
    await expect(integration.prepareRetention(options)).rejects.toThrow('clean mainline')
    await expect(fs.access(path.join(options.root, '.scratch/locks/context-write'))).rejects.toThrow()
    expect((await readConfirmationStore(options.root, 1)).count).toBe(25)
  })
})
