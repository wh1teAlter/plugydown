import type { ValidateFunction } from 'ajv/dist/2020.js'
import type { RuntimeResponse, TransactionAction } from '../../src/runtime/protocol.js'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { parse as parseYaml } from 'yaml'
import confirmationSchema from '../../public/schemas/confirmation.schema.json' with { type: 'json' }
import documentSchema from '../../public/schemas/document.schema.json' with { type: 'json' }
import metaSchema from '../../public/schemas/meta.schema.json' with { type: 'json' }
import runtimeSchema from '../../public/schemas/runtime.schema.json' with { type: 'json' }
import { handleRequest } from '../../src/runtime/handler.js'

// 单次 Runtime 请求与响应使用的固定协议标识。
export const PROTOCOL = 'plugydown.context.runtime'
// 测试使用的固定初始 Git 对象 ID。
export const REVISION_A = 'a'.repeat(40)
// 测试使用的固定后续 Git 对象 ID。
export const REVISION_C = 'c'.repeat(40)

/** 用于生成正式 Markdown 和独立预期账本的文档夹具。 */
export interface FixtureDocument {
  /** 相对 context/ 的测试文档位置。 */
  readonly relativePath: string
  /** 当前对象的稳定 ID。 */
  readonly id: string
  /** 便于路由和选择的简短说明。 */
  readonly description?: string
  /** 用于选择合法分支的种类判别值。 */
  readonly kind: 'domain' | 'architecture' | 'decision' | 'guide' | 'reference' | 'reflection'
  /** 文档所属领域 ID，应与物理目录一致。 */
  readonly domain: string
  /** 该文档声明的依赖、关联和替代关系。 */
  readonly relations?: {
    /** 必须先读取的前置文档 ID 集合。 */
    readonly requires?: readonly string[]
    /** 可选关联文档 ID 集合，不自动作为前置依赖。 */
    readonly related?: readonly string[]
    /** 被当前文档替代的文档 ID 集合。 */
    readonly supersedes?: readonly string[]
  }
  /** 文档引用的仓库相对源码声明，可包含受控 glob。 */
  readonly codePaths?: readonly string[]
  /** 用于生成文档原文的夹具正文，尚未执行规范化。 */
  readonly body?: string
}

// 服务领域的标准文档夹具，绑定固定源码路径。
export const SERVICE_DOMAIN: FixtureDocument = {
  relativePath: 'service/domain.md',
  id: 'service',
  kind: 'domain',
  domain: 'service',
  description: 'Service Domain boundaries and navigation.',
  codePaths: ['src/service.ts'],
  body: '# Service\n\nService behavior and boundaries.\n',
}

// 引用服务领域的指南夹具，用于关系和审查状态测试。
export const SERVICE_GUIDE: FixtureDocument = {
  relativePath: 'service/manual/retry.md',
  id: 'service.retry',
  kind: 'guide',
  domain: 'service',
  description: 'Retry behavior and constraints.',
  relations: { requires: ['service'] },
  codePaths: ['src/retry.ts'],
  body: '# Retry\n\nRetry only transient failures.\n',
}

// 独立客户端领域夹具，用于范围隔离测试。
export const CLIENT_DOMAIN: FixtureDocument = {
  relativePath: 'client/domain.md',
  id: 'client',
  kind: 'domain',
  domain: 'client',
  description: 'Client Domain boundaries and navigation.',
  codePaths: ['src/client.ts'],
  body: '# Client\n\nClient behavior and boundaries.\n',
}

/** 递归排序夹具对象键，保留数组顺序以独立构造确定性数据。 */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(sortValue)
  if (value === null || typeof value !== 'object')
    return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, sortValue(item)]))
}

/** 将排序后的夹具数据序列化为紧凑 JSON。 */
function compact(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

/** 计算夹具独立使用的 SHA-256 指纹。 */
function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 按文档格式约定规范化夹具正文，避免换行差异干扰测试。 */
function normalizeBody(body: string): string {
  return `${body.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n*$/, '')}\n`
}

/** 根据文档夹具生成合法 front matter 数据。 */
function metadata(document: FixtureDocument): Record<string, unknown> {
  // 当前文档解析出的依赖、关联和替代关系。
  const relations = document.relations === undefined
    ? undefined
    : Object.fromEntries(Object.entries(document.relations)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, [...(value as readonly string[])].sort()]))
  return {
    schema: 'plugydown.context.document/v1',
    id: document.id,
    description: document.description ?? `Description for ${document.id}.`,
    kind: document.kind,
    domain: document.domain,
    ...(relations === undefined || Object.keys(relations).length === 0 ? {} : { relations }),
    ...(document.codePaths === undefined ? {} : { code: { paths: [...document.codePaths].sort() } }),
  }
}

/** 将夹具字符串转为兼容 YAML 的带引号字面量。 */
function yamlString(value: string): string {
  return JSON.stringify(value)
}

/** 生成指定换行形式的正式 Markdown 夹具。 */
export function documentSource(document: FixtureDocument, lineEnding = '\n'): string {
  // 当前协议对象需要校验的业务字段集合。
  const fields = metadata(document)
  // 待生成的 Markdown 或 YAML 文本行集合。
  const lines = [
    '---',
    `schema: ${String(fields.schema)}`,
    `id: ${String(fields.id)}`,
    `description: ${yamlString(String(fields.description))}`,
    `kind: ${String(fields.kind)}`,
    `domain: ${String(fields.domain)}`,
  ]
  if (document.relations !== undefined) {
    lines.push('relations:')
    for (const key of ['requires', 'related', 'supersedes'] as const) {
      // 当前关系字段保存的目标 ID 列表。
      const values = document.relations[key]
      if (values === undefined)
        continue
      lines.push(`  ${key}:`)
      values.forEach(value => lines.push(`    - ${value}`))
    }
  }
  if (document.codePaths !== undefined) {
    lines.push('code:', '  paths:')
    document.codePaths.forEach(value => lines.push(`    - ${yamlString(value)}`))
  }
  lines.push('---', normalizeBody(document.body ?? `# ${document.id}\n\nBody for ${document.id}.\n`).replace(/\n$/, ''))
  return lines.join(lineEnding) + lineEnding
}

/** 在测试夹具中独立匹配受控 glob，不调用 Runtime 匹配实现。 */
function globMatches(pattern: string, candidate: string): boolean {
  // 源码声明按斜杠拆分后的模式段。
  const patterns = pattern.split('/')
  // 夹具实际路径按斜杠拆分的路径段。
  const candidates = candidate.split('/')
  /** 匹配夹具中的单段星号模式，避免依赖 Runtime 的实现。 */
  const segment = (source: string, value: string): boolean => new RegExp(`^${source.split('*').map(part => part.replace(/[|{}()[\]^$+?.]/g, '\\$&')).join('.*')}$`).test(value)
  /** 递归访问当前节点，累积调用方需要的文件或关系结果。 */
  const visit = (left: number, right: number): boolean => {
    if (left === patterns.length)
      return right === candidates.length
    if (patterns[left] === '**')
      return visit(left + 1, right) || (right < candidates.length && visit(left, right + 1))
    return right < candidates.length && segment(patterns[left] as string, candidates[right] as string) && visit(left + 1, right + 1)
  }
  return visit(0, 0)
}

/** 递归列出测试仓库中的普通文件并稳定排序。 */
async function allFiles(root: string, relative: string): Promise<readonly string[]> {
  const result: string[] = []
  /** 递归访问当前节点，累积调用方需要的文件或关系结果。 */
  const visit = async (current: string): Promise<void> => {
    // 夹具允许在锚点目录出现前声明 glob；源码健康度与正式账本格式有效性分离。
    const entries = await fs.readdir(path.join(root, current), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      // 当前递归遍历将访问的子路径。
      const next = `${current}/${entry.name}`
      // 与 Runtime 一致，源码展开在任何深度都不进入 node_modules。
      if (entry.isDirectory() && entry.name !== 'node_modules')
        await visit(next)
      else if (entry.isFile())
        result.push(next)
    }
  }
  await visit(relative)
  return result.sort()
}

/** 从测试源码文件和声明独立计算预期源码指纹。 */
async function sourceFingerprint(root: string, declarations: readonly string[]): Promise<string> {
  // Runtime 从模式的固定首段展开，夹具也必须遍历相同锚点。
  const anchors = [...new Set(declarations.filter(item => item.includes('*')).map(item => item.split('/')[0] as string))]
  // 全体文档引用源码去重后的文件集合。
  const repositoryFiles = (await Promise.all(anchors.map(anchor => allFiles(root, anchor)))).flat()
  // 根据夹具声明实际匹配的源码相对路径集合。
  const resolved = new Set<string>()
  for (const declaration of declarations) {
    if (declaration.includes('*'))
      repositoryFiles.filter(candidate => globMatches(declaration, candidate)).forEach(candidate => resolved.add(candidate))
    else
      resolved.add(declaration)
  }
  return hash(compact({
    declarations: [...declarations].sort(),
    files: await Promise.all([...resolved].sort().map(async (candidate) => {
      // 当前源码文件原始字节的独立预期指纹。
      let contentHash = '0'.repeat(64)
      try {
        contentHash = hash(await fs.readFile(path.join(root, candidate)))
      }
      catch {
        // 夹具可故意声明缺失或特殊源码；这不影响正式账本自身的格式有效性。
      }
      return { path: candidate, contentHash }
    })),
  }))
}

/** 写入由固定文档与源码生成的夹具账本，可构造基线与规模统计。 */
export async function writeMeta(
  root: string,
  documents: readonly FixtureDocument[],
  options: {
    /** 夹具中固定的全仓 Git 基线对象 ID。 */
    readonly baselineRevision?: string
    /** 仅历史迁移测试显式选择旧布局。 */
    readonly legacy?: boolean
    /** 由 Init/Prune 建立的规模基线，Update/Repair 应保留。 */
    readonly convergence?: boolean
  } = {},
): Promise<void> {
  // 当前文档应保留或新推导的持久记录。
  const ledger: Record<string, unknown> = {}
  // 累计 front matter 的 UTF-8 字节数。
  let frontMatterBytes = 0
  // 累计规范化正文的 UTF-8 字节数。
  let bodyBytes = 0
  // 按领域 ID 汇总的独立规模统计。
  const perDomain = new Map<string, {
    /** 参与统计或修复的文档数量。 */
    documentCount: number
    /** 原始 front matter 的 UTF-8 字节数。 */
    frontMatterBytes: number
    /** 规范化正文的 UTF-8 字节数。 */
    bodyBytes: number
  }>()
  for (const document of documents) {
    // 当前安全读取或待生成的资源文本。
    const source = documentSource(document)
    // 将文档原文分离为 front matter 与正文的匹配结果。
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source)
    // 尚未转换为规范字段投影的 front matter 文本。
    const frontMatter = match?.[1] ?? ''
    // 当前文档正文，不包含 front matter。
    const body = normalizeBody(match?.[2] ?? '')
    // 当前文档 front matter 的 UTF-8 字节数。
    const frontBytes = Buffer.byteLength(frontMatter)
    // 当前规范化正文的 UTF-8 字节数。
    const bodySize = Buffer.byteLength(body)
    frontMatterBytes += frontBytes
    bodyBytes += bodySize
    // 当前文档所属的领域或该领域的统计项。
    const domain = perDomain.get(document.domain) ?? { documentCount: 0, frontMatterBytes: 0, bodyBytes: 0 }
    domain.documentCount += 1
    domain.frontMatterBytes += frontBytes
    domain.bodyBytes += bodySize
    perDomain.set(document.domain, domain)
    ledger[document.id] = {
      frontMatterFingerprint: hash(compact(metadata(document))),
      bodyFingerprint: hash(body),
      sourceFingerprint: await sourceFingerprint(root, document.codePaths ?? []),
    }
  }
  // 可序列化的各领域规模基线集合。
  const perDomainValue = Object.fromEntries([...perDomain.entries()].sort(([left], [right]) => left < right ? -1 : 1).map(([id, value]) => [id, {
    ...value,
    estimatedTokens: Math.ceil((value.frontMatterBytes + value.bodyBytes) / 3),
  }]))
  // 所有文档源码路径声明的组合，用于独立计算全仓预期指纹。
  const allDeclarations = documents.flatMap(document => document.codePaths ?? [])
  // 已经解析或即将写出的持久账本。
  const meta = {
    $schema: 'plugydown.context.meta/v1',
    toolVersion: '0.1.0',
    runtimeProtocol: 'plugydown.context.runtime/v1',
    fingerprintVersion: '1',
    documents: ledger,
    ...(options.baselineRevision === undefined
      ? {}
      : {
          repository: { baseline: { revision: options.baselineRevision, sourceFingerprint: await sourceFingerprint(root, allDeclarations) } },
        }),
    ...(options.convergence === false
      ? {}
      : {
          convergence: {
            source: 'init',
            documentCount: documents.length,
            frontMatterBytes,
            bodyBytes,
            estimatedTokens: Math.ceil((frontMatterBytes + bodyBytes) / 3),
            perDomain: perDomainValue,
          },
        }),
  }
  if (options.legacy === true) {
    await fs.writeFile(path.join(root, 'context/meta.json'), `${JSON.stringify(sortValue(meta), null, 2)}\n`)
    return
  }
  await fs.mkdir(path.join(root, 'context/.meta'), { recursive: true })
  const manifest = { format: 1, ...(meta.repository === undefined ? {} : { repository: meta.repository }), ...(meta.convergence === undefined ? {} : { convergence: meta.convergence }) }
  await fs.writeFile(path.join(root, 'context/.meta/manifest.json'), `${JSON.stringify(sortValue(manifest), null, 2)}\n`)
  for (const [documentId, tuple] of Object.entries(ledger)) {
    const record = { documentId, ...tuple as object }
    const key = hash(compact({ format: 1, record }))
    const directory = path.join(root, 'context/.meta/confirmations', documentId)
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, `${key}.json`), `${JSON.stringify(sortValue(record), null, 2)}\n`)
  }
}

/** 创建完整正式知识夹具并写入对应账本。 */
export async function writeContext(root: string, documents: readonly FixtureDocument[], options: {
  /** 夹具中固定的全仓 Git 基线对象 ID。 */
  readonly baselineRevision?: string
  /** 仅历史迁移测试显式选择旧布局。 */
  readonly legacy?: boolean
  /** 由 Init/Prune 建立的规模基线，Update/Repair 应保留。 */
  readonly convergence?: boolean
} = {}): Promise<void> {
  await fs.mkdir(path.join(root, 'context'), { recursive: true })
  for (const document of documents) {
    // 当前事务或资源要写入的安全目标路径。
    const destination = path.join(root, 'context', document.relativePath)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.writeFile(destination, documentSource(document))
  }
  await writeMeta(root, documents, options)
}

/** 创建隔离临时仓库和固定源码，调用方负责登记并清理。 */
export async function createRepository(options: {
  /** 以稳定文档 ID 为键的文档或账本集合。 */
  readonly documents?: readonly FixtureDocument[]
  /** 按文档归属组织的当前源码文件集合。 */
  readonly sources?: Readonly<Record<string, string>>
  /** 是否为夹具创建 .git 元数据入口。 */
  readonly git?: boolean
  /** 夹具中固定的全仓 Git 基线对象 ID。 */
  readonly baselineRevision?: string
  /** 仅历史迁移测试显式选择旧布局。 */
  readonly legacy?: boolean
} = {}): Promise<string> {
  // 当前测试拥有的隔离仓库根目录，由测试清理钩子回收。
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugydown-context-'))
  // 按文档或来源组织的当前证据集合。
  const sources = options.sources ?? {
    'src/service.ts': 'export const service = true\n',
    'src/retry.ts': 'export const retry = true\n',
    'src/client.ts': 'export const client = true\n',
  }
  for (const [candidate, contents] of Object.entries(sources)) {
    // 当前事务或资源要写入的安全目标路径。
    const destination = path.join(root, candidate)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.writeFile(destination, contents)
  }
  if (options.git !== false)
    await fs.mkdir(path.join(root, '.git'))
  if (options.documents !== undefined)
    await writeContext(root, options.documents, { ...(options.legacy === undefined ? {} : { legacy: options.legacy }), ...(options.baselineRevision === undefined ? {} : { baselineRevision: options.baselineRevision }) })
  return root
}

/** 删除当前测试拥有的临时仓库。 */
export async function removeRepository(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true })
}

/** 写入固定、NUL 分隔的宿主 Git 证据夹具。 */
export async function writeGitEvidence(root: string, options: {
  /** 当前对象的稳定 ID。 */
  readonly id?: string
  /** 完整 Git 提交对象 ID，不依赖分支名称。 */
  readonly revision?: string
  /** 产品级执行状态；success 不代表 Context 本身有效。 */
  readonly status?: string | Buffer
  /** 测试宿主提供的基线差异原始数据。 */
  readonly diff?: string | Buffer
  /** Git 是否仍处于合并、变基等未完成操作。 */
  readonly midOperation?: false | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'
} = {}): Promise<string> {
  // 当前文件相对所属根目录的稳定路径。
  const relative = `.scratch/evidence/${options.id ?? 'request'}`
  // 本次操作拥有或读取的目录路径。
  const directory = path.join(root, relative)
  // 状态证据中的 HEAD 对象 ID，用于与 head.txt 交叉校验。
  const revision = options.revision ?? REVISION_A
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'head.txt'), `${revision}\n`)
  await fs.writeFile(path.join(directory, 'mid-operation.json'), JSON.stringify(options.midOperation === undefined || options.midOperation === false
    ? { active: false }
    : { active: true, kind: options.midOperation }))
  await fs.writeFile(path.join(directory, 'status.bin'), `# branch.oid ${revision}\0# branch.head main\0${String(options.status ?? '')}`)
  if (options.diff !== undefined) {
    await fs.writeFile(path.join(directory, 'diff.bin'), options.diff)
    await fs.writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ kind: 'two-tree', base: REVISION_A, head: revision }))
  }
  return relative
}

/** 生成一条固定形状的 porcelain v2 未暂存修改记录。 */
export function porcelainModified(candidate: string): string {
  // Git 测试记录使用的全零对象 ID 占位值。
  const zero = '0'.repeat(40)
  return `1 .M N... 100644 100644 100644 ${zero} ${zero} ${candidate}\0`
}

/** 生成 NUL 分隔的 name-status 夹具字节文本。 */
export function nameStatus(changes: readonly {
  /** 产品级执行状态；success 不代表 Context 本身有效。 */
  readonly status: string
  /** 仓库相对路径；正式知识诊断统一使用 context/ 前缀。 */
  readonly path: string
  /** 重命名或复制之前的仓库相对路径。 */
  readonly previousPath?: string
}[]): string {
  return changes.map(change => change.previousPath === undefined
    ? `${change.status}\0${change.path}\0`
    : `${change.status}\0${change.previousPath}\0${change.path}\0`).join('')
}

/** 根据四个匹配字段独立推导预期反馈身份。 */
export function feedbackId(fields: {
  /** 反馈可复用时适用的情境。 */
  readonly context: string
  /** 已观察到的具体行为，用于反馈身份和匹配。 */
  readonly observedBehavior: string
  /** 行为结果或可复用的修正方式。 */
  readonly outcomeOrCorrection: string
  /** 反馈可以再次适用的边界。 */
  readonly reuseBoundary: string
}): string {
  /** 按反馈身份规则规范化测试输入，保持预期结果稳定。 */
  const normalize = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
  // 从反馈情境和观察行为中提取的 ASCII 词列表。
  const ascii = normalize(`${fields.context} ${fields.observedBehavior}`)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .match(/[a-z0-9]+/g) ?? []
  // 不含唯一性信息的可读 ASCII 短名。
  const slug = ascii.slice(0, 4).join('-').slice(0, 48).replace(/-+$/g, '') || 'feedback'
  return `${slug}-${hash(compact({
    context: normalize(fields.context),
    observedBehavior: normalize(fields.observedBehavior),
    outcomeOrCorrection: normalize(fields.outcomeOrCorrection),
    reuseBoundary: normalize(fields.reuseBoundary),
  })).slice(0, 8)}`
}

/** 构造测试使用的 Runtime 请求封套。 */
export function runtimeRequest(capability: string, input: unknown, options: {
  /** 本次响应预算，缺省时使用 Runtime 默认值。 */
  readonly budget?: unknown
  /** 绑定查询与快照的续读令牌，不是写入授权。 */
  readonly cursor?: string
} = {}): Record<string, unknown> {
  return { protocol: PROTOCOL, format: 1, capability, input, ...options }
}

// 所有测试响应均校验公开 Runtime Schema，提交后的账本和 front matter 也校验对应 Schema，使实现与交付契约的偏差直接失败。
const ajv = new Ajv2020({ allErrors: true, strict: true })
ajv.addSchema(runtimeSchema, 'runtime')
// 校验请求和响应封套的公开 Runtime Schema。
const conformsToRuntime = ajv.getSchema('runtime') as ValidateFunction
// 按版本判别字段校验 v1/v2 持久账本的统一 Schema。
const conformsToMeta = ajv.compile(metaSchema)
// 校验正式文档 front matter 的公开 Schema。
const conformsToDocument = ajv.compile(documentSchema)
// 已提交的不可变凭据也必须符合公开合同。
const conformsToConfirmation = ajv.compile(confirmationSchema)

/** 用公开 JSON Schema 校验夹具或响应，失败时报告具体契约错误。 */
function conform(validate: ValidateFunction, value: unknown, subject: string): void {
  if (!validate(value))
    throw new Error(`${subject} violates its published schema:\n${ajv.errorsText(validate.errors, { separator: '\n' })}\n${JSON.stringify(value).slice(0, 600)}`)
}

/** 用于定位协议响应最接近分支的能力和状态约束投影。 */
interface ResponseVariant {
  /** 公开 JSON Schema 中用于筛选响应分支的属性约束。 */
  readonly properties?: {
    /** 请求分派目标或响应所属能力。 */
    readonly capability?: {
      /** Schema 分支要求的固定值。 */
      readonly const?: string
      /** Schema 分支接受的值集合。 */
      readonly enum?: readonly string[]
    }
    /** 产品级执行状态；success 不代表 Context 本身有效。 */
    readonly status?: {
      /** Schema 分支要求的固定值。 */
      readonly const?: string
      /** Schema 分支接受的值集合。 */
      readonly enum?: readonly string[]
    }
  }
}

/** 定位最接近的响应分支，避免 oneOf 错误淹没实际契约差异。 */
function conformResponse(response: RuntimeResponse): void {
  // 使用 unknown 视图调用类型守卫，避免失败分支把原响应缩窄为 never。
  if (conformsToRuntime(response as unknown))
    return
  // 公开响应 Schema 中可供匹配的 oneOf 分支。
  const variants = (runtimeSchema as unknown as {
    /** 公开 Schema 中互斥的响应形状分支。 */
    oneOf: readonly [unknown, {
      /** 公开 Schema 中互斥的响应形状分支。 */
      oneOf: readonly ResponseVariant[]
    }]
  }).oneOf[1].oneOf
  /** 判断响应分支是否接受指定能力或状态。 */
  const accepts = (rule: {
    /** Schema 分支要求的固定值。 */
    readonly const?: string
    /** Schema 分支接受的值集合。 */
    readonly enum?: readonly string[]
  } | undefined, value: string): boolean =>
    rule === undefined || rule.const === value || (rule.enum?.includes(value) ?? false)
  // 根据当前条件选出的业务候选集合。
  const candidates = variants
    .map((variant, index) => ({ variant, index }))
    .filter(({ variant }) => accepts(variant.properties?.capability, response.capability) && accepts(variant.properties?.status, response.status))
    .map(({ index }) => {
      // 当前公开 Schema 的校验函数。
      const validate = ajv.getSchema(`runtime#/oneOf/1/oneOf/${index}`) as ValidateFunction
      validate(response)
      return { index, errors: validate.errors ?? [] }
    })
    .sort((left, right) => left.errors.length - right.errors.length)
  // 与响应能力和状态最接近、错误数量最少的 Schema 分支。
  const closest = candidates[0]
  // 用于测试失败报告的具体 Schema 差异。
  const detail = closest === undefined
    ? 'no response variant accepts this capability and status'
    : `closest variant oneOf[1].oneOf[${closest.index}]:\n${ajv.errorsText(closest.errors, { separator: '\n' })}`
  throw new Error(`Runtime response violates its published schema; ${detail}\n${JSON.stringify(response).slice(0, 600)}`)
}

/** 调用 Runtime 并核对公开协议 Schema，同时验证所有被接受的请求。 */
export async function handle(root: string, request: unknown): Promise<RuntimeResponse> {
  const response = await handleRequest(root, request)
  conformResponse(response)
  if (response.status !== 'failed')
    conform(conformsToRuntime, request, 'Accepted Runtime request')
  return response
}

/** 检查已提交账本与各文档 front matter 是否符合公开 Schema。 */
async function conformCommittedContext(root: string): Promise<void> {
  const meta = JSON.parse(await fs.readFile(path.join(root, 'context/.meta/manifest.json'), 'utf8'))
  conform(conformsToMeta, meta, 'Committed manifest.json')
  for (const file of (await allFiles(root, 'context/.meta/confirmations')).filter(item => item.endsWith('.json')))
    conform(conformsToConfirmation, JSON.parse(await fs.readFile(path.join(root, file), 'utf8')), 'Committed confirmation')
  for (const file of (await allFiles(root, 'context')).filter(item => item.endsWith('.md'))) {
    const frontMatter = /^---\n([\s\S]*?)\n---\n/.exec((await fs.readFile(path.join(root, file), 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'))
    conform(conformsToDocument, parseYaml(frontMatter?.[1] ?? '') as unknown, `Committed ${file} front matter`)
  }
}

/** 构造只读请求并通过公共测试入口校验其响应。 */
export async function call(root: string, capability: string, input: unknown, options: {
  /** 本次响应预算，缺省时使用 Runtime 默认值。 */
  readonly budget?: unknown
  /** 绑定查询与快照的续读令牌，不是写入授权。 */
  readonly cursor?: string
} = {}): Promise<RuntimeResponse> {
  return handle(root, runtimeRequest(capability, input, options))
}

/** 执行事务测试请求，并在提交成功后校验真实正式文件。 */
export async function transactionCall(root: string, action: TransactionAction, input: unknown): Promise<RuntimeResponse> {
  const response = await handle(root, { protocol: PROTOCOL, format: 1, capability: 'transaction', action, input })
  if (action === 'commit' && response.status === 'success')
    await conformCommittedContext(root)
  return response
}
