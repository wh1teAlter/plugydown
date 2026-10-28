import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { parse } from 'yaml'
import deliveries from '../delivery.json' with { type: 'json' }
import runtimeSchema from '../public/schemas/runtime.schema.json' with { type: 'json' }

// 交付验收要求完整保留的三种内部角色身份。
const roleIds = ['investigator', 'recorder', 'reflector']
// 用于验证真实 Runtime 响应的公开协议 Schema 校验器。
const conforms = new Ajv2020({ strict: true }).compile(runtimeSchema)
// 交付验收使用的 Runtime 请求协议标识。
const protocol = 'plugydown.context.runtime'

/**
 * 只读生成交付目录的文件内容与权限快照，拒绝链接和特殊文件。
 *
 * @param root - 待生成快照的交付目录根路径。
 * @returns 以交付相对路径为键的权限位和内容哈希映射。
 * @throws 发现符号链接或特殊文件触发断言失败；读取错误继续抛出。
 * @remarks 调用阶段：aaplugin build 完成后的交付验收；只读访问已构建产物。
 */
export async function snapshot(root: string): Promise<Record<string, {
  /** 文件的 POSIX 权限位，仅保留低九位。 */
  mode: number
  /** 文件原始字节的 SHA-256 指纹。 */
  sha256: string
}>> {
  // 以交付相对路径为键的权限和内容哈希快照。
  const entries: Record<string, {
    /** 文件的 POSIX 权限位，仅保留低九位。 */
    mode: number
    /** 文件原始字节的 SHA-256 指纹。 */
    sha256: string
  }> = {}
  /** 递归收集交付目录中的文件，按稳定相对路径保存快照。 */
  async function walk(directory: string): Promise<void> {
    for (const name of (await fs.readdir(path.join(root, directory))).sort()) {
      // 当前文件相对所属根目录的稳定路径。
      const relative = path.posix.join(directory, name)
      // 当前受检文件的实际路径，仅用于内部读写操作。
      const file = path.join(root, relative)
      // 通过 lstat 取得的文件类型、权限和大小，避免隐式跟随链接。
      const info = await fs.lstat(file)
      assert(!info.isSymbolicLink(), `Unexpected symlink: ${relative}`)
      if (info.isDirectory()) {
        await walk(relative)
      }
      else {
        assert(info.isFile(), `Unexpected special file: ${relative}`)
        entries[relative] = { mode: info.mode & 0o777, sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') }
      }
    }
  }
  await walk('')
  return entries
}

/** 在业务仓库 cwd 启动已构建 Runtime，验证唯一响应且限制进程时间和输出大小。 */
function request(file: string, cwd: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // 当前目录下的实际子路径或受控启动的子进程。
    const child = execFile(process.execPath, [file], { cwd, timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(error)
        return
      }
      try {
        assert.equal(stderr, '')
        // 真实子进程返回并通过公开 Schema 校验的唯一 JSON 响应。
        const response: unknown = JSON.parse(stdout)
        assert(conforms(response), JSON.stringify(conforms.errors))
        resolve(response)
      }
      catch (error) {
        reject(error)
      }
    })
    child.stdin!.end(JSON.stringify({ protocol, format: 1, capability: 'repository.inspect', input: {} }))
  })
}

/**
 * 只读验证发布工作流选择的完整交付单元，包括角色、许可证和真实 Runtime 响应。
 *
 * @param packageRoot - 插件源码包根目录。
 * @param platform - 待验证或贡献资源的宿主平台标识。
 * @param businessRoot - 用于真实 Runtime 试运行的隔离业务仓库根目录。
 * @returns 真实 Runtime 文件和第三方许可证的原始字节，供跨平台等价比较。
 * @throws 缺失文件、权限、Schema 或字节不一致触发断言失败；进程和文件系统错误继续抛出。
 * @remarks 调用阶段：aaplugin build 完成后的交付验收；只读访问已构建产物。
 */
export async function verifyDelivery(packageRoot: string, platform: keyof typeof deliveries, businessRoot: string) {
  // 发布工作流实际选择的完整交付单元目录。
  const unit = path.join(packageRoot, 'dist', platform, deliveries[platform])
  // 当前平台放置 Runtime 与 Skill 的内容根目录。
  const content = platform === 'opencode' ? path.join(unit, '.opencode') : unit
  // 当前文档或交付单元实际包含的文件快照。
  const files = await snapshot(unit)
  // 交付单元中唯一可执行 Runtime 入口的绝对路径。
  const main = path.join(content, 'runtime/context/main.mjs')
  assert.equal((await fs.lstat(main)).mode & 0o777, 0o755)
  // 必须随 Runtime 保留的第三方许可证原始文本。
  const license = await fs.readFile(path.join(content, 'runtime/context/THIRD_PARTY_LICENSES.txt'), 'utf8')
  assert.match(license, /yaml/)
  for (const name of ['runtime', 'document', 'meta', 'confirmation']) {
    assert.deepEqual(await fs.readFile(path.join(unit, `schemas/${name}.schema.json`)), await fs.readFile(path.join(packageRoot, `public/schemas/${name}.schema.json`)))
  }
  // 交付单元公开的 Skill 目录集合。
  const skills = Object.keys(files).filter(file => file.endsWith('/SKILL.md'))
  assert(skills.length > 0)
  for (const skill of skills) {
    assert.equal(path.resolve(unit, path.dirname(skill), '../../runtime/context/main.mjs'), main)
    assert.equal((await fs.lstat(path.resolve(unit, path.dirname(skill), '../../runtime/agents/index.md'))).isFile(), true)
  }
  // 已构建的 Context Operating Skill 正文。
  const operatingSkill = await fs.readFile(path.join(content, 'skills/context/SKILL.md'), 'utf8')
  assert(operatingSkill.includes('../../runtime/agents/index.md'))
  // 已构建的内部角色调用索引文本。
  const index = await fs.readFile(path.join(content, 'runtime/agents/index.md'), 'utf8')
  assert(index.includes(`Platform: ${platform}.`))
  // 当前宿主是否使用原生 Agent 而非私有 Markdown 资源。
  const native = ['claude-code', 'cursor', 'opencode'].includes(platform)
  for (const id of roleIds) {
    // 当前文件相对所属根目录的稳定路径。
    const relative = native ? `../../agents/${id}.md` : `./${id}.md`
    assert(index.includes(`[${id}](${relative})`))
    // 当前角色在交付目录中的实际资源路径。
    const roleFile = path.resolve(content, 'runtime/agents', relative)
    // 当前角色的已构建 Markdown 正文或元数据对象。
    const role = await fs.readFile(roleFile, 'utf8')
    // 当前安全读取或待生成的资源文本。
    const source = await fs.readFile(path.join(packageRoot, `src/internal-roles/${id}.md`), 'utf8')
    assert.equal(role.slice(role.indexOf('\n---\n') + 5).trim(), source.trim())
    // 从规范角色文件名或 front matter 取得的交付元数据。
    const metadata = parse(role.split('\n---\n')[0]!.slice(4))
    if (!native) {
      assert.equal(metadata.delivery, 'private-runtime-resource')
      assert(!skills.some(skill => skill.includes(id)), 'Private roles must not become public Skills')
    }
    if (platform === 'opencode') {
      assert.equal(metadata.mode, 'subagent')
      assert.deepEqual(metadata.permission, { edit: id === 'investigator' ? 'deny' : 'allow', bash: id === 'investigator' ? 'allow' : 'deny', task: 'deny', webfetch: 'deny' })
    }
    if (platform === 'cursor')
      assert.deepEqual(Object.keys(metadata).sort(), ['description', 'name'])
  }
  if (platform === 'claude-code') {
    // 已解析的事务阶段、冻结输入和恢复事实。
    const manifest = JSON.parse(await fs.readFile(path.join(unit, '.claude-plugin/plugin.json'), 'utf8'))
    assert.deepEqual(manifest.agents, roleIds.map(id => `./agents/${id}.md`))
    assert.equal(JSON.parse(await fs.readFile(path.join(unit, '.claude-plugin/marketplace.json'), 'utf8')).plugins[0].source, './')
  }
  if (platform === 'cursor') {
    // 已解析的事务阶段、冻结输入和恢复事实。
    const manifest = JSON.parse(await fs.readFile(path.join(unit, '.cursor-plugin/plugin.json'), 'utf8'))
    assert.equal(manifest.agents, './agents/*.md')
  }
  if (platform === 'pi') {
    // 已解析的事务阶段、冻结输入和恢复事实。
    const manifest = JSON.parse(await fs.readFile(path.join(unit, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.pi, { skills: ['./skills'], prompts: ['./prompts'], extensions: ['./extensions/aaplugin-hooks.mjs'] })
  }
  // 真实子进程返回并通过公开 Schema 校验的唯一 JSON 响应。
  const response = await request(main, businessRoot)
  assert.deepEqual(response, {
    protocol,
    format: 1,
    capability: 'repository.inspect',
    status: 'success',
    data: { context: { state: 'absent', sourceState: 'unchecked' }, meta: { state: 'absent', layout: 'absent' } },
  })
  return { main: await fs.readFile(main), license }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // 待验收的插件源码包根目录。
  const packageRoot = path.resolve(import.meta.dirname, '..')
  if (process.argv[2] === '--snapshot') {
    process.stdout.write(`${JSON.stringify(await snapshot(path.join(packageRoot, 'dist')))}\n`)
  }
  else {
    const { tmpdir } = await import('node:os')
    // 交付测试独占的临时业务仓库，在 finally 中清理。
    const business = await fs.mkdtemp(path.join(tmpdir(), 'plugydown-delivery-business-'))
    try {
      await fs.mkdir(path.join(business, '.git'))
      // 首个平台验收返回的 Runtime 与许可证字节，作为跨平台比较基准。
      let first: Awaited<ReturnType<typeof verifyDelivery>> | undefined
      for (const platform of Object.keys(deliveries) as (keyof typeof deliveries)[]) {
        // 本次处理累积的结果集合。
        const result = await verifyDelivery(packageRoot, platform, business)
        if (first !== undefined)
          assert.deepEqual(result, first, 'Runtime and license bytes must agree across Platforms')
        first = result
        process.stdout.write(`${platform}: delivery verified\n`)
      }
    }
    finally {
      await fs.rm(business, { recursive: true, force: true })
    }
  }
}
