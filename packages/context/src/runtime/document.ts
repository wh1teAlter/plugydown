import type { SourceFile } from './repository.js'
import type { JsonObject, JsonValue } from './stable-json.js'
import { Buffer } from 'node:buffer'
import { parse as parseYaml } from 'yaml'
import { FORMAT, isRecord, RuntimeFault, sha256 } from './protocol.js'
import { aggregateSourceFingerprint, assertSourcePattern, MAX_FRONT_MATTER_BYTES, MAX_JSON_TEXT_BYTES, MAX_MARKDOWN_BYTES } from './repository.js'
import { compactJson, compareCodeUnits, stableJson } from './stable-json.js'

// 正式 Markdown 文档当前使用的格式版本。
export const DOCUMENT_SCHEMA = 'plugydown.context.document/v1'
// 旧账本里的固定协议标签，仅用于迁移验证。
const LEGACY_RUNTIME_PROTOCOL = 'plugydown.context.runtime/v1'
// 历史账本的字段规则只用于显式迁移。
export const LEGACY_META_SCHEMA = 'plugydown.context.meta/v1'
// 旧 v2 账本允许未完成复核标记，迁移时必须排除。
export const META_SCHEMA = 'plugydown.context.meta/v2'
// 旧账本的固定算法标签，不是新格式的独立版本序列。
export const LEGACY_FINGERPRINT_VERSION = '1'

// 文档种类白名单，决定路由与物理存放位置。
export const DOCUMENT_KINDS = ['domain', 'architecture', 'decision', 'guide', 'reference', 'reflection'] as const
/** 正式文档允许使用的种类，决定其合法物理目录。 */
export type DocumentKind = typeof DOCUMENT_KINDS[number]

// 领域 ID 的小写 kebab-case 校验规则。
const DOMAIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// 允许点分层级的稳定文档 ID 校验规则。
const DOCUMENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/
// 正式文档文件名的小写 kebab-case 约束。
const FILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/
// 持久指纹必须满足的 64 位小写十六进制格式。
const SHA256 = /^[a-f0-9]{64}$/
// 允许 SHA-1 或 SHA-256 Git 对象 ID 的校验规则。
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
// 从 Markdown 起始位置分离 YAML front matter 与正文的匹配规则。
const FRONT_MATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/

/** 文档之间的依赖、关联和替代关系，保存稳定文档 ID。 */
export interface Relations {
  /** 必须先读取的前置文档 ID 集合。 */
  readonly requires: readonly string[]
  /** 可选关联文档 ID 集合，不自动作为前置依赖。 */
  readonly related: readonly string[]
  /** 被当前文档替代的文档 ID 集合。 */
  readonly supersedes: readonly string[]
}

/** 已解析并规范化的正式文档，供校验、路由和指纹计算共享。 */
export interface ContextDocument {
  /** 持久数据格式标识；升级需明确处理旧格式。 */
  readonly schema: typeof DOCUMENT_SCHEMA
  /** 当前对象的稳定 ID。 */
  readonly id: string
  /** 便于路由和选择的简短说明。 */
  readonly description: string
  /** 用于选择合法分支的种类判别值。 */
  readonly kind: DocumentKind
  /** 文档所属领域 ID，应与物理目录一致。 */
  readonly domain: string
  /** 该文档声明的依赖、关联和替代关系。 */
  readonly relations: Relations
  /** 文档引用的仓库相对源码声明，可包含受控 glob。 */
  readonly codePaths: readonly string[]
  /** 正式 context/ 下的规范文档相对路径，候选读取也映射为该形式。 */
  readonly path: string
  /** 已规范化的文档正文，不包含 front matter。 */
  readonly body: string
  /** 原始 front matter 的 UTF-8 字节数。 */
  readonly frontMatterBytes: number
  /** 规范化正文的 UTF-8 字节数。 */
  readonly bodyBytes: number
}

/** 正式知识解析或结构校验发现的问题，路径使用仓库相对形式。 */
export interface KnowledgeIssue {
  /** 稳定错误码，供调用方分支处理。 */
  readonly code: string
  /** 可公开的诊断文本，不应包含环境值或凭据。 */
  readonly message: string
  /** 仓库相对路径；正式知识诊断统一使用 context/ 前缀。 */
  readonly path: string
}

/** 文档解析结果；失败时保留完整问题列表，不返回部分文档。 */
export type DocumentResult
  = | {
    readonly ok: true
    /** 已通过解析的文档，失败分支不提供部分结果。 */
    readonly document: ContextDocument
  }
  | {
    readonly ok: false
    /** 本次内部完整问题集合，不能用裁剪后的输出代替安全判断。 */
    readonly issues: readonly KnowledgeIssue[]
  }

/** 按确定顺序列出对象中不在允许集合内的字段。 */
function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): readonly string[] {
  // 当前阶段已登记的身份、字段或访问状态。
  const known = new Set(allowed)
  return Object.keys(value).filter(key => !known.has(key)).sort(compareCodeUnits)
}

/** 读取非空、无重复的字符串列表；格式不合法时返回 undefined。 */
function parseNonEmptyList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || item.length === 0))
    return undefined
  if (new Set(value).size !== value.length)
    return undefined
  return [...value].sort(compareCodeUnits) as string[]
}

/**
 * 统一正文 BOM、换行和行尾空白，为内容指纹提供稳定输入。
 *
 * @param body - 不含 front matter 的正文文本。
 * @returns 规范化后、末尾恰有一个 LF 的正文。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：文档读取、候选验证或确定性序列化；纯计算，不读写文件。
 */
export function normalizeBody(body: string): string {
  // 完成大小写、空白或正文规则处理的规范化内容。
  const normalized = body
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n*$/, '')
  return `${normalized}\n`
}

/** 解析文档关系，将非法字段和 ID 追加到调用方的问题集合。 */
function parseRelations(value: unknown, sourcePath: string, issues: KnowledgeIssue[]): Relations {
  // 解析缺省关系时使用的空关系集合。
  const empty: Relations = { requires: [], related: [], supersedes: [] }
  if (value === undefined)
    return empty
  if (!isRecord(value) || Object.keys(value).length === 0) {
    issues.push({ code: 'DOCUMENT_RELATIONS_INVALID', message: 'relations must be a non-empty object.', path: sourcePath })
    return empty
  }
  for (const _key of unknownKeys(value, ['requires', 'related', 'supersedes']))
    issues.push({ code: 'DOCUMENT_RELATION_FIELD_UNKNOWN', message: 'relations contains an unknown field.', path: sourcePath })
  // 经过当前层格式校验的数据，供后续语义判断使用。
  const parsed: Record<keyof Relations, readonly string[]> = { requires: [], related: [], supersedes: [] }
  for (const key of ['requires', 'related', 'supersedes'] as const) {
    if (value[key] === undefined)
      continue
    // 经过非空和去重检查的字段列表。
    const list = parseNonEmptyList(value[key])
    if (list === undefined || list.some(id => !DOCUMENT_ID.test(id)))
      issues.push({ code: 'DOCUMENT_RELATION_INVALID', message: `${key} must contain unique valid Document IDs.`, path: sourcePath })
    else
      parsed[key] = list
  }
  return parsed
}

/** 校验源码路径声明，将不安全的模式追加为文档问题。 */
function parseCode(value: unknown, sourcePath: string, issues: KnowledgeIssue[]): readonly string[] {
  if (value === undefined)
    return []
  if (!isRecord(value) || Object.keys(value).length !== 1 || !('paths' in value)) {
    issues.push({ code: 'DOCUMENT_CODE_INVALID', message: 'code must contain only a non-empty paths list.', path: sourcePath })
    return []
  }
  // 本次计算涉及的仓库相对路径集合。
  const paths = parseNonEmptyList(value.paths)
  if (paths === undefined) {
    issues.push({ code: 'DOCUMENT_CODE_PATHS_INVALID', message: 'code.paths must contain unique non-empty patterns.', path: sourcePath })
    return []
  }
  for (const candidate of paths) {
    try {
      assertSourcePattern(candidate)
    }
    catch {
      issues.push({ code: 'DOCUMENT_CODE_PATH_UNSAFE', message: 'code.paths contains an unsafe source pattern.', path: sourcePath })
    }
  }
  return paths
}

/**
 * 严格解析 v1 Markdown 文档，验证封闭字段集合并规范化正文。
 *
 * @param sourcePath - 用于标注问题的仓库相对文档路径。
 * @param source - 待解析的原始文本。
 * @returns 成功时返回完整文档，失败时返回 ok: false 和完整问题集合。
 * @throws 格式、字段或内容错误通过 ok: false 返回，不作为异常抛出。
 * @remarks 调用阶段：文档读取、候选验证或确定性序列化；纯计算，不读写文件。
 */
export function parseDocument(sourcePath: string, source: string): DocumentResult {
  // 当前读取过程收集的完整问题，保留到调用方统一处理。
  const issues: KnowledgeIssue[] = []
  if (Buffer.byteLength(source, 'utf8') > MAX_MARKDOWN_BYTES)
    return { ok: false, issues: [{ code: 'DOCUMENT_SIZE_EXCEEDED', message: 'The Markdown document exceeds 1 MiB.', path: sourcePath }] }
  // 将文档原文分离为 front matter 与正文的匹配结果。
  const match = FRONT_MATTER.exec(source)
  if (match === null)
    return { ok: false, issues: [{ code: 'DOCUMENT_FRONT_MATTER_MISSING', message: 'A document must start with YAML front matter.', path: sourcePath }] }
  // 尚未转换为规范字段投影的 front matter 文本。
  const frontMatter = match[1] as string
  // 当前文档正文，不包含 front matter。
  const body = match[2] as string
  if (Buffer.byteLength(frontMatter, 'utf8') > MAX_FRONT_MATTER_BYTES)
    return { ok: false, issues: [{ code: 'DOCUMENT_FRONT_MATTER_SIZE_EXCEEDED', message: 'Document front matter exceeds 64 KiB.', path: sourcePath }] }

  // 从持久文件或未校验输入取得的原始数据。
  let raw: unknown
  try {
    raw = parseYaml(frontMatter)
  }
  catch {
    return { ok: false, issues: [{ code: 'DOCUMENT_FRONT_MATTER_INVALID', message: 'Document front matter must be valid YAML.', path: sourcePath }] }
  }
  if (!isRecord(raw))
    return { ok: false, issues: [{ code: 'DOCUMENT_FRONT_MATTER_INVALID', message: 'Document front matter must be an object.', path: sourcePath }] }
  for (const _key of unknownKeys(raw, ['schema', 'id', 'description', 'kind', 'domain', 'relations', 'code']))
    issues.push({ code: 'DOCUMENT_FIELD_UNKNOWN', message: 'Document front matter contains an unknown field.', path: sourcePath })
  for (const key of ['schema', 'id', 'description', 'kind', 'domain']) {
    if (!(key in raw))
      issues.push({ code: 'DOCUMENT_FIELD_MISSING', message: `Document field "${key}" is required.`, path: sourcePath })
  }
  if (raw.schema !== DOCUMENT_SCHEMA)
    issues.push({ code: 'DOCUMENT_SCHEMA_INVALID', message: `Document schema must be ${DOCUMENT_SCHEMA}.`, path: sourcePath })
  if (typeof raw.id !== 'string' || !DOCUMENT_ID.test(raw.id))
    issues.push({ code: 'DOCUMENT_ID_INVALID', message: 'Document id must use dotted lowercase kebab-case.', path: sourcePath })
  if (typeof raw.description !== 'string' || raw.description.trim().length === 0)
    issues.push({ code: 'DOCUMENT_DESCRIPTION_INVALID', message: 'Document description must be non-empty.', path: sourcePath })
  if (typeof raw.kind !== 'string' || !(DOCUMENT_KINDS as readonly string[]).includes(raw.kind))
    issues.push({ code: 'DOCUMENT_KIND_INVALID', message: 'Document kind is unknown.', path: sourcePath })
  if (typeof raw.domain !== 'string' || !DOMAIN_ID.test(raw.domain))
    issues.push({ code: 'DOCUMENT_DOMAIN_INVALID', message: 'Document domain must use lowercase kebab-case.', path: sourcePath })
  if (body.trim().length === 0)
    issues.push({ code: 'DOCUMENT_BODY_EMPTY', message: 'Document body must be non-empty.', path: sourcePath })
  if (/^(?:<{7,}|>{7,}|\|{7,})(?:[\t ]|\r?$)/m.test(body))
    issues.push({ code: 'DOCUMENT_CONFLICT_MARKER', message: 'Resolve Git conflict markers before using this Document.', path: sourcePath })

  // 当前文档解析出的依赖、关联和替代关系。
  const relations = parseRelations(raw.relations, sourcePath, issues)
  // 当前文档声明的源码路径与受控 glob。
  const codePaths = parseCode(raw.code, sourcePath, issues)
  if (issues.length > 0)
    return { ok: false, issues }
  // 按统一换行与空白规则规范化后的正文。
  const normalized = normalizeBody(body)
  return {
    ok: true,
    document: {
      schema: DOCUMENT_SCHEMA,
      id: raw.id as string,
      description: (raw.description as string).trim(),
      kind: raw.kind as DocumentKind,
      domain: raw.domain as string,
      relations,
      codePaths,
      path: sourcePath,
      body: normalized,
      frontMatterBytes: Buffer.byteLength(frontMatter, 'utf8'),
      bodyBytes: Buffer.byteLength(normalized, 'utf8'),
    },
  }
}

/**
 * 校验物理目录、所属领域、文档种类与稳定 ID 是否一致。
 *
 * @param document - 已解析的文档对象。
 * @returns 全部位置与身份不一致问题；空数组表示通过。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：文档读取、候选验证或确定性序列化；纯计算，不读写文件。
 */
export function placementIssues(document: ContextDocument): readonly KnowledgeIssue[] {
  // 当前读取过程收集的完整问题，保留到调用方统一处理。
  const issues: KnowledgeIssue[] = []
  // 按路径分隔符拆分的层级，用于位置和模式校验。
  const parts = document.path.split('/')
  // 当前文档所属的领域或该领域的统计项。
  const domain = parts[1]
  if (parts[0] !== 'context' || domain === undefined || !DOMAIN_ID.test(domain) || document.domain !== domain)
    issues.push({ code: 'DOCUMENT_DOMAIN_MISMATCH', message: 'Document domain must equal its physical Domain directory.', path: document.path })
  // 用于校验物理位置的文档文件名。
  const fileName = parts.at(-1) as string
  if (!FILE_NAME.test(fileName))
    issues.push({ code: 'DOCUMENT_FILENAME_INVALID', message: 'Document filenames must use lowercase kebab-case.', path: document.path })
  if (parts.length === 3) {
    if (fileName !== 'domain.md' || document.kind !== 'domain' || document.id !== domain || document.domain !== domain)
      issues.push({ code: 'DOCUMENT_PLACEMENT_INVALID', message: 'The Domain root may contain only its matching domain.md.', path: document.path })
  }
  else if (parts.length === 4) {
    // 当前文档所在的 design/manual/reflections 分类。
    const category = parts[2]
    // 当前物理分类允许承载的文档种类。
    const allowed = category === 'design'
      ? ['architecture', 'decision']
      : category === 'manual'
        ? ['guide', 'reference']
        : category === 'reflections'
          ? ['reflection']
          : []
    if (!allowed.includes(document.kind) || document.kind === 'domain')
      issues.push({ code: 'DOCUMENT_PLACEMENT_INVALID', message: 'Document kind does not match its category.', path: document.path })
    if (!document.id.startsWith(`${domain}.`))
      issues.push({ code: 'DOCUMENT_ID_DOMAIN_MISMATCH', message: 'A non-Domain Document id must begin with its Domain id.', path: document.path })
  }
  else {
    issues.push({ code: 'DOCUMENT_PLACEMENT_INVALID', message: 'Formal Documents must use the canonical two-level Domain layout.', path: document.path })
  }
  return issues
}

/** 提取有业务意义的 front matter 字段，作为序列化与指纹的共同投影。 */
function frontMatterValue(document: ContextDocument): JsonObject {
  return {
    schema: document.schema,
    id: document.id,
    description: document.description,
    kind: document.kind,
    domain: document.domain,
    ...(document.relations.requires.length === 0 && document.relations.related.length === 0 && document.relations.supersedes.length === 0
      ? {}
      : {
          relations: {
            ...(document.relations.requires.length === 0 ? {} : { requires: [...document.relations.requires] }),
            ...(document.relations.related.length === 0 ? {} : { related: [...document.relations.related] }),
            ...(document.relations.supersedes.length === 0 ? {} : { supersedes: [...document.relations.supersedes] }),
          },
        }),
    ...(document.codePaths.length === 0 ? {} : { code: { paths: [...document.codePaths] } }),
  }
}

/**
 * 计算规范化 front matter 的 SHA-256 指纹。
 *
 * @param document - 已解析的文档对象。
 * @returns 64 位小写十六进制 SHA-256 指纹。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：文档读取、候选验证或确定性序列化；纯计算，不读写文件。
 */
export function frontMatterFingerprint(document: ContextDocument): string {
  return sha256(compactJson(frontMatterValue(document)))
}

/**
 * 计算规范化正文的 SHA-256 指纹。
 *
 * @param document - 已解析的文档对象。
 * @returns 64 位小写十六进制 SHA-256 指纹。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：文档读取、候选验证或确定性序列化；纯计算，不读写文件。
 */
export function bodyFingerprint(document: ContextDocument): string {
  return sha256(document.body)
}

/**
 * 根据源码声明及实际文件集合计算审查依据指纹。
 *
 * @param document - 已解析的文档对象。
 * @param files - 已读取的源码文件路径和内容哈希集合。
 * @returns 绑定声明、文件集合和内容的 64 位小写十六进制指纹。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：文档读取、候选验证或确定性序列化；纯计算，不读写文件。
 */
export function sourceFingerprint(document: ContextDocument, files: readonly SourceFile[]): string {
  return aggregateSourceFingerprint(document.codePaths, files)
}

/** 文档与来源的三个摘要；当前计算结果不含持久待审状态。 */
export interface DocumentLedger {
  /** 规范化文档元数据的 SHA-256 指纹。 */
  readonly frontMatterFingerprint: string
  /** 规范化文档正文的 SHA-256 指纹。 */
  readonly bodyFingerprint: string
  /** 源码声明与文件内容的指纹；持久账本中的值表示上次审查依据。 */
  readonly sourceFingerprint: string
}

/** 仅迁移解析使用的旧账本记录，不能作为当前确认载荷。 */
export interface LegacyDocumentLedger extends DocumentLedger {
  /** 内容经过指纹修复但尚未语义复核；只能由正式 Update 结清。 */
  readonly reviewRequired?: true
}

/** 知识规模统计，字节数按 UTF-8 计算，token 数为估算值。 */
export interface Metrics {
  /** 参与统计或修复的文档数量。 */
  readonly documentCount: number
  /** 原始 front matter 的 UTF-8 字节数。 */
  readonly frontMatterBytes: number
  /** 规范化正文的 UTF-8 字节数。 */
  readonly bodyBytes: number
  /** front matter 与正文总字节数除以三后向上取整。 */
  readonly estimatedTokens: number
}

/** 由 Init 或 Prune 建立的规模基线，供后续增长分析使用。 */
export interface ConvergenceBaseline extends Metrics {
  /** 建立规模基线的工作流，只能为 init 或 prune。 */
  readonly source: 'init' | 'prune'
  /** 以领域 ID 为键的规模统计。 */
  readonly perDomain: Readonly<Record<string, Metrics>>
}

/** 仅迁移读取的旧账本，普通写入不再生成此结构。 */
export interface Meta {
  /** 持久数据格式标识；升级需明确处理旧格式。 */
  readonly schema: typeof META_SCHEMA | typeof LEGACY_META_SCHEMA
  /** 账本工具格式版本，不直接等同于插件发布版本。 */
  readonly toolVersion: string
  /** 生成账本时使用的 Runtime 协议标识。 */
  readonly runtimeProtocol: typeof LEGACY_RUNTIME_PROTOCOL
  /** 指纹算法版本；算法变化必须显式升级。 */
  readonly fingerprintVersion: typeof LEGACY_FINGERPRINT_VERSION
  /** 以稳定文档 ID 为键的文档或账本集合。 */
  readonly documents: Readonly<Record<string, LegacyDocumentLedger>>
  /** 上次可证明全仓审查完成时记录的源码基线。 */
  readonly repository?: {
    /** 特定用途的持久基线，不能因局部修复自动推进。 */
    readonly baseline: {
      /** 完整 Git 提交对象 ID，不依赖分支名称。 */
      readonly revision: string
      /** 源码声明与文件内容的指纹；持久账本中的值表示上次审查依据。 */
      readonly sourceFingerprint: string
    }
  }
  /** 由 Init/Prune 建立的规模基线，Update/Repair 应保留。 */
  readonly convergence?: ConvergenceBaseline
}

/** 新布局的唯一格式入口；不保存当前文档索引或确认状态。 */
export interface MetadataManifest {
  /** 入口、确认身份及后续 Runtime 调用共用的兼容代号。 */
  readonly format: typeof FORMAT
  /** 仅保留的历史源码基线，不由普通确认更新推进。 */
  readonly repository?: NonNullable<Meta['repository']>
  /** 与文档新鲜度独立的低频规模基线。 */
  readonly convergence?: ConvergenceBaseline
}

/** 账本解析结果；不合法的账本仅返回问题，不能部分采信。 */
export type MetaResult
  = | {
    readonly ok: true
    /** 已通过格式校验的持久账本。 */
    readonly meta: Meta
  }
  | {
    readonly ok: false
    /** 本次内部完整问题集合，不能用裁剪后的输出代替安全判断。 */
    readonly issues: readonly KnowledgeIssue[]
  }

/** 严格读取旧 JSON 并拒绝重复键；仅供显式迁移使用。 */
export function parseLegacyMetaJson(text: string): unknown {
  const raw: unknown = JSON.parse(text)
  try {
    parseYaml(text, { uniqueKeys: true })
  }
  catch {
    throw new SyntaxError('Legacy metadata contains duplicate keys.')
  }
  return raw
}

/** 判断计数是否为非负安全整数。 */
function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/** 校验规模统计字段，按调用方式决定是否拒绝额外字段。 */
function parseMetrics(value: unknown, exact = true): Metrics | undefined {
  if (!isRecord(value) || (exact && unknownKeys(value, ['documentCount', 'frontMatterBytes', 'bodyBytes', 'estimatedTokens']).length > 0)
    || !['documentCount', 'frontMatterBytes', 'bodyBytes', 'estimatedTokens'].every(key => validCount(value[key]))) {
    return undefined
  }
  return {
    documentCount: value.documentCount as number,
    frontMatterBytes: value.frontMatterBytes as number,
    bodyBytes: value.bodyBytes as number,
    estimatedTokens: value.estimatedTokens as number,
  }
}

/** 校验并复制可选的历史仓库基线，不计算或推进其内容。 */
function parseRepositoryBaseline(value: unknown, sourcePath: string, issues: KnowledgeIssue[]): Meta['repository'] {
  // 允许保留或推进的全仓源码审查基线。
  let repository: Meta['repository']
  if (value !== undefined) {
    if (!isRecord(value) || JSON.stringify(Object.keys(value)) !== JSON.stringify(['baseline']) || !isRecord(value.baseline)
      || JSON.stringify(Object.keys(value.baseline).sort(compareCodeUnits)) !== JSON.stringify(['revision', 'sourceFingerprint'])
      || typeof value.baseline.revision !== 'string' || !GIT_REVISION.test(value.baseline.revision)
      || typeof value.baseline.sourceFingerprint !== 'string' || !SHA256.test(value.baseline.sourceFingerprint)) {
      issues.push({ code: 'META_REPOSITORY_INVALID', message: 'Meta repository baseline is invalid.', path: sourcePath })
    }
    else {
      repository = { baseline: { revision: value.baseline.revision, sourceFingerprint: value.baseline.sourceFingerprint } }
    }
  }

  return repository
}

/** 校验并复制可选的规模基线，复用所有层级的严格计数规则。 */
function parseConvergenceBaseline(value: unknown, sourcePath: string, issues: KnowledgeIssue[]): ConvergenceBaseline | undefined {
  // Init/Prune 建立的规模基线，其他流程应保持不变。
  let convergence: ConvergenceBaseline | undefined
  if (value !== undefined) {
    // 单个规模统计对象的校验结果。
    const metric = parseMetrics(value, false)
    if (!isRecord(value)
      || JSON.stringify(Object.keys(value).sort(compareCodeUnits)) !== JSON.stringify(['bodyBytes', 'documentCount', 'estimatedTokens', 'frontMatterBytes', 'perDomain', 'source'])
      || (value.source !== 'init' && value.source !== 'prune')
      || metric === undefined
      || !isRecord(value.perDomain)) {
      issues.push({ code: 'META_CONVERGENCE_INVALID', message: 'Meta convergence baseline is invalid.', path: sourcePath })
    }
    else {
      // 按领域 ID 汇总的独立规模统计。
      const perDomain: Record<string, Metrics> = {}
      for (const [id, rawMetrics] of Object.entries(value.perDomain).sort(([left], [right]) => compareCodeUnits(left, right))) {
        // 当前知识集合的规模统计。
        const metrics = parseMetrics(rawMetrics)
        if (!DOMAIN_ID.test(id) || metrics === undefined)
          issues.push({ code: 'META_CONVERGENCE_DOMAIN_INVALID', message: 'A convergence Domain entry is invalid.', path: sourcePath })
        else
          perDomain[id] = metrics
      }
      convergence = { source: value.source, ...metric, perDomain }
    }
  }

  return convergence
}

/**
 * 解析统一格式入口并验证规范字节，禁止重复字段与隐式降级。
 *
 * @param sourcePath - 入口的仓库相对路径，用于安全诊断。
 * @param source - 已严格解码的完整 JSON 文本。
 * @returns 已复制且通过检查的格式入口，不包含文档当前状态。
 * @throws 格式未知、字段/基线无效、字节超限或不是规范 JSON 时抛出 RuntimeFault。
 * @remarks 调用阶段：新布局读取或候选验证；不读写文件，也不迁移旧账本。
 */
export function parseMetadataManifest(sourcePath: string, source: string): MetadataManifest {
  if (Buffer.byteLength(source, 'utf8') > MAX_JSON_TEXT_BYTES)
    throw new RuntimeFault('METADATA_SIZE_EXCEEDED', 'The metadata manifest exceeds its byte limit.', sourcePath)
  // JSON.parse 后仍要比较规范字节，避免重复键被解析器静默覆盖。
  let raw: unknown
  try {
    raw = JSON.parse(source) as unknown
  }
  catch (error) {
    if (!(error instanceof SyntaxError))
      throw error
    throw new RuntimeFault('METADATA_JSON_INVALID', 'The metadata manifest must be valid JSON.', sourcePath)
  }
  if (!isRecord(raw) || unknownKeys(raw, ['format', 'repository', 'convergence']).length > 0)
    throw new RuntimeFault('METADATA_INVALID', 'The metadata manifest has an invalid shape.', sourcePath)
  if (raw.format !== FORMAT)
    throw new RuntimeFault('FORMAT_UNSUPPORTED', 'The metadata compatibility format is missing or unsupported.', sourcePath)

  // 基线沿用旧格式的严格校验，验证期间不更新历史值。
  const issues: KnowledgeIssue[] = []
  // 原样保留的历史源码基线。
  const repository = parseRepositoryBaseline(raw.repository, sourcePath, issues)
  // 独立于确认状态的规模基线。
  const convergence = parseConvergenceBaseline(raw.convergence, sourcePath, issues)
  // 首个稳定问题决定失败原因，不输出半有效的入口。
  const first = issues[0]
  if (first !== undefined)
    throw new RuntimeFault(first.code, first.message, first.path)
  // 只保留统一入口允许承载的字段。
  const metadata: MetadataManifest = {
    format: FORMAT,
    ...(repository === undefined ? {} : { repository }),
    ...(convergence === undefined ? {} : { convergence }),
  }
  if (source !== serializeMetadataManifest(metadata))
    throw new RuntimeFault('METADATA_NON_CANONICAL', 'The metadata manifest must use canonical JSON without duplicate keys.', sourcePath)
  return metadata
}

/**
 * 序列化新元数据入口，供事务写入或只读校验复用。
 *
 * @param metadata - 已通过类型及内容验证的格式入口。
 * @returns 按码元排序、缩进两空格且末尾一个 LF 的 JSON 文本。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：候选推导和规范字节校验；纯计算，不写入正式目录。
 */
export function serializeMetadataManifest(metadata: MetadataManifest): string {
  return stableJson(metadata as unknown as JsonValue)
}

/**
 * 严格解析 v1/v2 账本；仅 v2 允许持久保存内容待复核义务。
 *
 * @param sourcePath - 用于标注问题的仓库相对文档路径。
 * @param raw - 未经格式校验的原始输入。
 * @returns 成功时返回内部账本，失败时返回 ok: false 和问题集合。
 * @throws 格式版本、字段或指纹形状错误通过 ok: false 返回。
 * @remarks 调用阶段：文档读取、候选验证或确定性序列化；纯计算，不读写文件。
 */
export function parseMeta(sourcePath: string, raw: unknown): MetaResult {
  // 当前读取过程收集的完整问题，保留到调用方统一处理。
  const issues: KnowledgeIssue[] = []
  if (!isRecord(raw))
    return { ok: false, issues: [{ code: 'META_INVALID', message: 'Meta must be a JSON object.', path: sourcePath }] }
  for (const _key of unknownKeys(raw, ['$schema', 'toolVersion', 'runtimeProtocol', 'fingerprintVersion', 'documents', 'repository', 'convergence']))
    issues.push({ code: 'META_FIELD_UNKNOWN', message: 'Meta contains an unknown field.', path: sourcePath })
  for (const key of ['$schema', 'toolVersion', 'runtimeProtocol', 'fingerprintVersion', 'documents']) {
    if (!(key in raw))
      issues.push({ code: 'META_FIELD_MISSING', message: `Meta field "${key}" is required.`, path: sourcePath })
  }
  if (raw.$schema !== META_SCHEMA && raw.$schema !== LEGACY_META_SCHEMA)
    issues.push({ code: 'META_SCHEMA_INVALID', message: `Meta schema must be ${LEGACY_META_SCHEMA} or ${META_SCHEMA}.`, path: sourcePath })
  if (typeof raw.toolVersion !== 'string' || raw.toolVersion.length === 0)
    issues.push({ code: 'META_TOOL_VERSION_INVALID', message: 'Meta toolVersion must be non-empty.', path: sourcePath })
  if (raw.runtimeProtocol !== LEGACY_RUNTIME_PROTOCOL)
    issues.push({ code: 'META_RUNTIME_PROTOCOL_INVALID', message: `Meta runtimeProtocol must be ${LEGACY_RUNTIME_PROTOCOL}.`, path: sourcePath })
  if (raw.fingerprintVersion !== LEGACY_FINGERPRINT_VERSION)
    issues.push({ code: 'META_LEGACY_FINGERPRINT_VERSION_INVALID', message: `Meta fingerprintVersion must be ${LEGACY_FINGERPRINT_VERSION}.`, path: sourcePath })

  // 以稳定文档 ID 为键的知识或账本映射。
  const documents: Record<string, LegacyDocumentLedger> = {}
  if (!isRecord(raw.documents)) {
    issues.push({ code: 'META_DOCUMENTS_INVALID', message: 'Meta documents must be an object.', path: sourcePath })
  }
  else {
    for (const [id, value] of Object.entries(raw.documents).sort(([left], [right]) => compareCodeUnits(left, right))) {
      if (!DOCUMENT_ID.test(id) || !isRecord(value)
        || unknownKeys(value, ['bodyFingerprint', 'frontMatterFingerprint', 'sourceFingerprint', ...(raw.$schema === META_SCHEMA ? ['reviewRequired'] : [])]).length > 0
        || ('reviewRequired' in value && value.reviewRequired !== true)
        || ![value.frontMatterFingerprint, value.bodyFingerprint, value.sourceFingerprint].every(item => typeof item === 'string' && SHA256.test(item))) {
        issues.push({ code: 'META_DOCUMENT_INVALID', message: 'A Meta Document entry is invalid.', path: sourcePath })
      }
      else {
        documents[id] = {
          frontMatterFingerprint: value.frontMatterFingerprint as string,
          bodyFingerprint: value.bodyFingerprint as string,
          sourceFingerprint: value.sourceFingerprint as string,
          ...(value.reviewRequired === true ? { reviewRequired: true as const } : {}),
        }
      }
    }
  }

  // 两种布局共用同一组只读基线校验，不为格式迁移创建新语义。
  const repository = parseRepositoryBaseline(raw.repository, sourcePath, issues)
  // 使用与新入口一致的规模字段校验。
  const convergence = parseConvergenceBaseline(raw.convergence, sourcePath, issues)

  if (issues.length > 0)
    return { ok: false, issues }
  return {
    ok: true,
    meta: {
      schema: raw.$schema as Meta['schema'],
      toolVersion: raw.toolVersion as string,
      runtimeProtocol: LEGACY_RUNTIME_PROTOCOL,
      fingerprintVersion: LEGACY_FINGERPRINT_VERSION,
      documents,
      ...(repository === undefined ? {} : { repository }),
      ...(convergence === undefined ? {} : { convergence }),
    },
  }
}
