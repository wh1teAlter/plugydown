import type { ContextDocument, DocumentLedger, KnowledgeIssue, Meta, MetadataManifest, Metrics } from './document.js'
import type { SourceFile } from './repository.js'
import type { JsonObject } from './stable-json.js'
import { bodyFingerprint, frontMatterFingerprint, parseDocument, parseLegacyMetaJson, parseMeta, parseMetadataManifest, placementIssues, sourceFingerprint } from './document.js'
import { FORMAT, RuntimeFault } from './protocol.js'
import {
  CONTEXT_ROOT,
  expandSourcePatternSets,
  fingerprintTree,
  inspectMetadataLayout,
  lstatRepositoryPath,
  MAX_JSON_TEXT_BYTES,
  MAX_MARKDOWN_BYTES,
  METADATA_DIRECTORY,
  readDirectory,
  readUtf8File,
} from './repository.js'
import { compareCodeUnits } from './stable-json.js'

/** 按领域索引的文档集合，领域入口文档单独标识。 */
export interface DomainNode {
  /** 当前对象的稳定 ID。 */
  readonly id: string
  /** 当前领域或选择器包含的文档 ID。 */
  readonly documentIds: readonly string[]
  /** 领域入口 domain.md 对应的文档 ID。 */
  readonly domainDocumentId?: string
}

/** 调用能力选择的源码读取策略，控制读取范围而非正式知识有效性。 */
export type SourcePolicy = 'formal-only' | 'selected' | 'all-strict' | 'all-tolerant'

/** 带文档所有者和路径声明的源码证据问题。 */
export interface SourceKnowledgeIssue extends KnowledgeIssue {
  /** 当前条目所属的稳定文档 ID。 */
  readonly documentId: string
  /** 出现证据问题的仓库相对源码声明。 */
  readonly sourcePattern: string
}

/** 单次读取建立的知识快照，区分正式结构、源码证据和账本状态。 */
export interface KnowledgeGraph {
  /** 本次读取的正式或候选 Context 根目录，相对业务仓库。 */
  readonly contextPath: string
  /** 正式结构状态：缺失、完整可用或损坏。 */
  readonly formalState: 'absent' | 'ready' | 'invalid'
  /** 源码证据状态：未检查、可读或降级；不表示语义审查完成。 */
  readonly sourceState: 'unchecked' | 'ready' | 'degraded'
  /** 账本文件的缺失或格式校验状态。 */
  readonly metaState: 'absent' | 'valid' | 'invalid'
  /** 完整正式或候选 Context 文件树的 SHA-256 指纹。 */
  readonly contextFingerprint?: string
  /** 源码声明与文件内容的指纹；持久账本中的值表示上次审查依据。 */
  readonly sourceFingerprint?: string
  /** 以稳定文档 ID 为键的文档或账本集合。 */
  readonly documents: ReadonlyMap<string, ContextDocument>
  /** 以稳定领域 ID 为键的领域索引。 */
  readonly domains: ReadonlyMap<string, DomainNode>
  /** 按文档归属组织的当前源码文件集合。 */
  readonly sources: ReadonlyMap<string, readonly SourceFile[]>
  /** 本次源码读取计算出的当前指纹，与持久 meta 中的审查依据分离。 */
  readonly ledgers: ReadonlyMap<string, DocumentLedger>
  /** 已通过格式校验的持久账本。 */
  readonly meta?: Meta
  /** 新布局的统一入口；普通读取使用当前格式时填充。 */
  readonly metadata?: MetadataManifest
  /** 本次内部完整问题集合，不能用裁剪后的输出代替安全判断。 */
  readonly issues: readonly KnowledgeIssue[]
  /** 包含文档所有权的源码证据问题。 */
  readonly sourceIssues: readonly SourceKnowledgeIssue[]
  /** 当前知识树的分类数量。 */
  readonly counts: {
    /** 以稳定领域 ID 为键的领域索引。 */
    readonly domains: number
    /** 设计类文档的数量。 */
    readonly design: number
    /** 手册类文档的数量。 */
    readonly manual: number
    /** 复盘类文档的数量。 */
    readonly reflections: number
    /** 以稳定文档 ID 为键的文档或账本集合。 */
    readonly documents: number
  }
  /** 所有文档声明的关系边数量。 */
  readonly relationCount: number
  /** 全部 code.paths 声明的数量，未去重文件。 */
  readonly sourceDeclarationCount: number
}

// 领域 ID 的小写 kebab-case 校验规则。
const DOMAIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// 正式领域目录允许的三个文档分类子目录。
const CATEGORIES = new Set(['design', 'manual', 'reflections'])
// 账本诊断对外使用的规范仓库相对路径。
const META_PATH_FOR_ISSUE = 'context/meta.json'

/** 构造带规范路径的知识问题。 */
function issue(code: string, message: string, issuePath: string): KnowledgeIssue {
  return { code, message, path: issuePath }
}

/** 将可预期的 Runtime 故障转换为知识问题，未知异常继续抛出。 */
function faultIssues(error: unknown, fallbackPath: string): readonly KnowledgeIssue[] {
  if (!(error instanceof RuntimeFault))
    throw error
  return error.diagnostics.map(item => issue(item.code, item.message, item.path ?? fallbackPath))
}

/** 把候选目录中的路径映射回正式 context/ 路径用于诊断。 */
function canonicalPath(contextPath: string, actualPath: string): string {
  return actualPath === contextPath ? CONTEXT_ROOT : `${CONTEXT_ROOT}/${actualPath.slice(contextPath.length + 1)}`
}

/** 扫描正式目录得到的文档、领域、问题和分类数量。 */
interface LoadedDocuments {
  /** 以稳定文档 ID 为键的文档或账本集合。 */
  readonly documents: readonly ContextDocument[]
  /** 以稳定领域 ID 为键的领域索引。 */
  readonly domains: readonly string[]
  /** 本次内部完整问题集合，不能用裁剪后的输出代替安全判断。 */
  readonly issues: readonly KnowledgeIssue[]
  /** 当前知识树的分类数量。 */
  readonly counts: {
    /** 设计类文档的数量。 */
    readonly design: number
    /** 手册类文档的数量。 */
    readonly manual: number
    /** 复盘类文档的数量。 */
    readonly reflections: number
  }
}

/** 读取标准目录下的 Markdown 文档，收集解析、类型与位置问题。 */
async function loadDocuments(root: string, contextPath: string, currentMetadata = false): Promise<LoadedDocuments> {
  // 以稳定文档 ID 为键的知识或账本映射。
  const documents: ContextDocument[] = []
  // 当前读取或选择涉及的领域集合。
  const domains: string[] = []
  // 当前读取过程收集的完整问题，保留到调用方统一处理。
  const issues: KnowledgeIssue[] = []
  // 当前文档树各类别的计数。
  const counts = { design: 0, manual: 0, reflections: 0 }
  // 正式 Context 根目录的直接条目。
  const rootEntries = await readDirectory(root, contextPath)
  for (const entry of rootEntries) {
    // 当前领域在正式或候选树中的实际相对路径。
    const actual = `${contextPath}/${entry.name}`
    // 用于公开诊断的正式 context/ 相对路径。
    const canonical = canonicalPath(contextPath, actual)
    if (currentMetadata && entry.name === METADATA_DIRECTORY)
      continue
    if (entry.name === 'meta.json') {
      if (entry.kind !== 'file')
        issues.push(issue('META_NOT_REGULAR_FILE', 'context/meta.json must be a regular file.', canonical))
      continue
    }
    if (entry.kind !== 'directory') {
      issues.push(issue(entry.kind === 'symlink' ? 'KNOWLEDGE_SYMLINK' : 'KNOWLEDGE_ROOT_ENTRY_INVALID', 'The Context root may contain only Meta and Domain directories.', canonical))
      continue
    }
    if (!DOMAIN_ID.test(entry.name)) {
      issues.push(issue('DOMAIN_ID_INVALID', 'Domain directory names must use lowercase kebab-case.', canonical))
      continue
    }
    domains.push(entry.name)
    // 当前领域目录的直接子条目。
    const children = await readDirectory(root, actual)
    // 当前领域是否已经找到合法 domain.md 入口。
    let domainDocument = false
    for (const child of children) {
      // 当前子条目在正式或候选目录中的实际相对路径。
      const childActual = `${actual}/${child.name}`
      // 当前子条目对外使用的规范 context/ 路径。
      const childCanonical = canonicalPath(contextPath, childActual)
      if (child.name === 'domain.md') {
        if (child.kind !== 'file') {
          issues.push(issue('DOCUMENT_NOT_REGULAR_FILE', 'domain.md must be a regular Markdown file.', childCanonical))
        }
        else {
          // 经过当前层格式校验的数据，供后续语义判断使用。
          const parsed = parseDocument(childCanonical, await readUtf8File(root, childActual, MAX_MARKDOWN_BYTES))
          if (parsed.ok) {
            documents.push(parsed.document)
            issues.push(...placementIssues(parsed.document))
            domainDocument = true
          }
          else {
            issues.push(...parsed.issues)
          }
        }
        continue
      }
      if (child.kind !== 'directory' || !CATEGORIES.has(child.name)) {
        issues.push(issue(child.kind === 'symlink' ? 'KNOWLEDGE_SYMLINK' : 'DOCUMENT_PLACEMENT_INVALID', 'A Domain may contain only domain.md and canonical category directories.', childCanonical))
        continue
      }
      // 当前文档分类目录的叶子条目。
      const leaves = await readDirectory(root, childActual)
      if (leaves.length === 0)
        issues.push(issue('DOCUMENT_CATEGORY_EMPTY', 'Empty Document category directories are not allowed.', childCanonical))
      for (const leaf of leaves) {
        // 当前文档叶子在所读目录中的实际相对路径。
        const leafActual = `${childActual}/${leaf.name}`
        // 当前文档叶子对外使用的规范 context/ 路径。
        const leafCanonical = canonicalPath(contextPath, leafActual)
        if (leaf.kind !== 'file' || !leaf.name.endsWith('.md')) {
          issues.push(issue(leaf.kind === 'symlink' ? 'KNOWLEDGE_SYMLINK' : 'DOCUMENT_PLACEMENT_INVALID', 'Document categories contain only regular Markdown files.', leafCanonical))
          continue
        }
        // 经过当前层格式校验的数据，供后续语义判断使用。
        const parsed = parseDocument(leafCanonical, await readUtf8File(root, leafActual, MAX_MARKDOWN_BYTES))
        if (parsed.ok) {
          documents.push(parsed.document)
          issues.push(...placementIssues(parsed.document))
          counts[child.name as keyof typeof counts] += 1
        }
        else {
          issues.push(...parsed.issues)
        }
      }
    }
    if (!domainDocument)
      issues.push(issue('DOMAIN_DOCUMENT_MISSING', 'Every Domain must contain a valid domain.md.', `${CONTEXT_ROOT}/${entry.name}`))
  }
  if (domains.length === 0)
    issues.push(issue('DOMAIN_MISSING', 'A ready Context tree must contain at least one Domain.', CONTEXT_ROOT))
  return { documents, domains, issues, counts }
}

/** 用深度优先遍历找出参与 requires 环的文档 ID。 */
function requiresCycles(documents: ReadonlyMap<string, ContextDocument>): readonly string[] {
  // 深度优先搜索中各文档的访问阶段。
  const state = new Map<string, 'visiting' | 'done'>()
  // 检测到参与 requires 环的文档 ID 集合。
  const cyclic = new Set<string>()
  /** 沿 requires 关系标记访问状态，将当前递归栈中的环成员加入结果。 */
  const visit = (id: string, stack: string[]): void => {
    // 当前阶段已登记的身份、字段或访问状态。
    const known = state.get(id)
    if (known === 'done')
      return
    if (known === 'visiting') {
      // 环入口在当前递归栈中的位置。
      const offset = stack.indexOf(id)
      stack.slice(offset < 0 ? 0 : offset).forEach(member => cyclic.add(member))
      return
    }
    state.set(id, 'visiting')
    stack.push(id)
    for (const target of documents.get(id)?.relations.requires ?? []) {
      if (documents.has(target))
        visit(target, stack)
    }
    stack.pop()
    state.set(id, 'done')
  }
  for (const id of [...documents.keys()].sort(compareCodeUnits))
    visit(id, [])
  return [...cyclic].sort(compareCodeUnits)
}

/** 累加指定文档集合的 UTF-8 字节规模与 token 估算。 */
function documentMetrics(documents: Iterable<ContextDocument>): Metrics {
  // 本次规模统计累计的文档数量。
  let documentCount = 0
  // 累计 front matter 的 UTF-8 字节数。
  let frontMatterBytes = 0
  // 累计规范化正文的 UTF-8 字节数。
  let bodyBytes = 0
  for (const document of documents) {
    documentCount += 1
    frontMatterBytes += document.frontMatterBytes
    bodyBytes += document.bodyBytes
  }
  return { documentCount, frontMatterBytes, bodyBytes, estimatedTokens: Math.ceil((frontMatterBytes + bodyBytes) / 3) }
}

/**
 * 计算整个知识图和各领域的规模统计。
 *
 * @param graph - 当前正式或候选知识快照。
 * @returns 全图 current 统计和以领域 ID 为键的 perDomain 统计。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：知识检查、渐进读取、增量分析或候选验证；本函数不写入正式知识。
 */
export function graphMetrics(graph: KnowledgeGraph): {
  /** 本次读取计算的当前规模或状态。 */
  readonly current: Metrics
  /** 以领域 ID 为键的规模统计。 */
  readonly perDomain: Readonly<Record<string, Metrics>>
} {
  // 按领域 ID 汇总的独立规模统计。
  const perDomain: Record<string, Metrics> = {}
  for (const [id, domain] of graph.domains)
    perDomain[id] = documentMetrics(domain.documentIds.map(documentId => graph.documents.get(documentId) as ContextDocument))
  return { current: documentMetrics(graph.documents.values()), perDomain }
}

/** 构造缺失或不可用 Context 的空快照，保留原始问题。 */
function emptyGraph(contextPath: string, formalState: 'absent' | 'invalid', issues: readonly KnowledgeIssue[]): KnowledgeGraph {
  return {
    contextPath,
    formalState,
    sourceState: 'unchecked',
    metaState: 'absent',
    documents: new Map(),
    domains: new Map(),
    sources: new Map(),
    ledgers: new Map(),
    issues,
    sourceIssues: [],
    counts: { domains: 0, design: 0, manual: 0, reflections: 0, documents: 0 },
    relationCount: 0,
    sourceDeclarationCount: 0,
  }
}

/**
 * 按能力指定的策略读取正式知识和源码证据，形成分层状态快照。
 *
 * @param root - 业务仓库根目录。
 * @param contextPath - 待读取的仓库相对 Context 目录；缺省为正式 context/。
 * @param options - 当前操作的校验、选择或格式选项。
 * @param options.ignoreMeta - 仅在候选结构校验时忽略账本，不能用于放宽正式读取。
 * @param options.requireMeta - 是否要求账本存在且与文档集合一致。
 * @param options.sourcePolicy - 本次调用选择的源码展开范围与容错策略。
 * @param options.selectedDocumentIds - 本次调用显式选择的文档 ID；不自动扩大写入授权。
 * @param options.format - 可选的统一兼容代号，缺省为当前格式。
 * @param options.legacy - 仅供显式迁移读取旧账本。
 * @returns 包含文档、账本、证据和三个独立状态轴的只读快照。
 * @throws 可预期的结构和证据问题存入快照；未分类异常继续抛出。
 * @remarks 调用阶段：知识检查、渐进读取、增量分析或候选验证；本函数不写入正式知识。
 */
export async function loadKnowledge(
  root: string,
  contextPath = CONTEXT_ROOT,
  options: {
    /** 由新格式调用方明确提供，旧协议不能隐式获得新布局写入资格。 */
    readonly format?: typeof FORMAT
    /** 仅供显式迁移读取旧账本，不属于普通能力的回退路径。 */
    readonly legacy?: true
    /** 仅在候选结构校验时忽略账本，不能用于放宽正式读取。 */
    readonly ignoreMeta?: boolean
    /** 是否要求账本存在且与文档集合一致。 */
    readonly requireMeta?: boolean
    /** 本次调用选择的源码展开范围与容错策略。 */
    readonly sourcePolicy?: SourcePolicy
    /** 本次调用显式选择的文档 ID；不自动扩大写入授权。 */
    readonly selectedDocumentIds?: readonly string[]
  } = {},
): Promise<KnowledgeGraph> {
  // 本次读取是否要求账本存在且与文档匹配。
  const requireMeta = options.requireMeta !== false
  // 普通能力只使用当前格式；旧格式必须由迁移显式请求。
  const currentFormat = options.legacy !== true
  // 调用能力要求的源码读取范围与容错策略。
  const sourcePolicy = options.sourcePolicy ?? 'all-strict'
  // 通过 lstat 取得的文件类型、权限和大小，避免隐式跟随链接。
  let info
  try {
    info = await lstatRepositoryPath(root, contextPath)
  }
  catch (error) {
    return emptyGraph(contextPath, 'invalid', faultIssues(error, CONTEXT_ROOT))
  }
  if (info === undefined)
    return emptyGraph(contextPath, 'absent', [])
  if (!info.isDirectory())
    return emptyGraph(contextPath, 'invalid', [issue('CONTEXT_NOT_DIRECTORY', 'The Context root must be a regular directory.', CONTEXT_ROOT)])

  // 新格式入口必须先证明唯一且有效，随后才把 .meta 从文档目录扫描中分离。
  let metadata: MetadataManifest | undefined
  if (currentFormat && options.ignoreMeta !== true) {
    try {
      if (options.format !== undefined && options.format !== FORMAT)
        throw new RuntimeFault('FORMAT_UNSUPPORTED', 'The requested compatibility format is unsupported.')
      // 区分待迁移的旧布局与没有合法入口的损坏树，避免错误引导迁移。
      const layout = await inspectMetadataLayout(root, contextPath)
      if (layout !== 'current')
        throw new RuntimeFault(layout === 'legacy' ? 'MIGRATION_REQUIRED' : 'METADATA_MANIFEST_MISSING', layout === 'legacy' ? 'Migrate legacy Context before current-format maintenance.' : 'Current-format Context requires a metadata manifest.', contextPath)
      // 文件读取使用实际候选路径，公开诊断仍使用规范 Context 路径。
      const manifestPath = `${contextPath}/${METADATA_DIRECTORY}/manifest.json`
      metadata = parseMetadataManifest(canonicalPath(contextPath, manifestPath), await readUtf8File(root, manifestPath, MAX_JSON_TEXT_BYTES))
    }
    catch (error) {
      return { ...emptyGraph(contextPath, 'invalid', faultIssues(error, CONTEXT_ROOT)), metaState: 'invalid' }
    }
  }

  // 正式目录、文档结构和账本一致性问题。
  const formalIssues: KnowledgeIssue[] = []
  // 当前 Context 文件树的精确指纹，用于快照和游标绑定。
  let contextFingerprint: string | undefined
  try {
    contextFingerprint = await fingerprintTree(root, contextPath)
  }
  catch (error) {
    formalIssues.push(...faultIssues(error, CONTEXT_ROOT))
  }
  // 目录扫描得到的文档和原始结构问题。
  let loaded: LoadedDocuments = { documents: [], domains: [], issues: [], counts: { design: 0, manual: 0, reflections: 0 } }
  try {
    loaded = await loadDocuments(root, contextPath, currentFormat)
    formalIssues.push(...loaded.issues)
  }
  catch (error) {
    formalIssues.push(...faultIssues(error, CONTEXT_ROOT))
  }

  // 以稳定文档 ID 为键的知识或账本映射。
  const documents = new Map<string, ContextDocument>()
  for (const document of [...loaded.documents].sort((left, right) => compareCodeUnits(left.path, right.path))) {
    if (documents.has(document.id))
      formalIssues.push(issue('DOCUMENT_ID_DUPLICATE', `Document id "${document.id}" is duplicated.`, document.path))
    else
      documents.set(document.id, document)
  }
  // 从物理目录识别出的领域 ID 集合。
  const domainSet = new Set(loaded.domains)
  for (const document of documents.values()) {
    if (!domainSet.has(document.domain))
      formalIssues.push(issue('DOCUMENT_DOMAIN_UNKNOWN', 'Document refers to an unknown Domain.', document.path))
    for (const relation of ['requires', 'related', 'supersedes'] as const) {
      for (const target of document.relations[relation]) {
        if (target === document.id)
          formalIssues.push(issue('DOCUMENT_RELATION_SELF', 'A Document must not relate to itself.', document.path))
        if (relation !== 'supersedes' && !documents.has(target))
          formalIssues.push(issue('DOCUMENT_RELATION_DANGLING', `Relation target "${target}" is missing.`, document.path))
      }
    }
  }
  for (const id of requiresCycles(documents))
    formalIssues.push(issue('DOCUMENT_REQUIRES_CYCLE', `Document "${id}" participates in a requires cycle.`, documents.get(id)?.path ?? CONTEXT_ROOT))

  // 当前读取或选择涉及的领域集合。
  const domains = new Map<string, DomainNode>()
  for (const id of [...domainSet].sort(compareCodeUnits)) {
    // 当前领域实际包含的稳定文档 ID。
    const documentIds = [...documents.values()].filter(document => document.domain === id).map(document => document.id).sort(compareCodeUnits)
    // 领域入口文档的稳定 ID，用于返回路由元数据。
    const domainDocumentId = documentIds.find(documentId => documents.get(documentId)?.kind === 'domain')
    domains.set(id, { id, documentIds, ...(domainDocumentId === undefined ? {} : { domainDocumentId }) })
  }

  // 已经解析或即将写出的持久账本。
  let meta: Meta | undefined
  // 账本是否缺失或通过格式校验的独立状态。
  let metaState: KnowledgeGraph['metaState'] = metadata === undefined ? 'absent' : 'valid'
  // 当前正式或候选目录下 meta.json 的实际相对路径。
  const metaActual = `${contextPath}/meta.json`
  // 账本文件的类型与大小信息。
  let metaInfo
  if (options.ignoreMeta !== true && !currentFormat) {
    try {
      metaInfo = await lstatRepositoryPath(root, metaActual)
    }
    catch (error) {
      metaState = 'invalid'
      formalIssues.push(...faultIssues(error, META_PATH_FOR_ISSUE))
    }
  }
  if (metaInfo !== undefined) {
    if (!metaInfo.isFile()) {
      metaState = 'invalid'
      formalIssues.push(issue('META_NOT_REGULAR_FILE', 'context/meta.json must be a regular file.', META_PATH_FOR_ISSUE))
    }
    else {
      try {
        // 本次安全读取的 UTF-8 文本。
        const text = await readUtf8File(root, metaActual, MAX_JSON_TEXT_BYTES)
        // 从持久文件或未校验输入取得的原始数据。
        let raw: unknown
        try {
          raw = parseLegacyMetaJson(text.replace(/^\uFEFF/, ''))
        }
        catch (error) {
          if (!(error instanceof SyntaxError))
            throw error
          formalIssues.push(issue('META_JSON_INVALID', 'context/meta.json must contain valid JSON.', META_PATH_FOR_ISSUE))
          metaState = 'invalid'
        }
        if (raw !== undefined) {
          // 经过当前层格式校验的数据，供后续语义判断使用。
          const parsed = parseMeta(META_PATH_FOR_ISSUE, raw)
          if (parsed.ok) {
            meta = parsed.meta
            metaState = 'valid'
          }
          else {
            metaState = 'invalid'
            formalIssues.push(...parsed.issues)
          }
        }
      }
      catch (error) {
        metaState = 'invalid'
        formalIssues.push(...faultIssues(error, META_PATH_FOR_ISSUE))
      }
    }
  }
  if (requireMeta && options.ignoreMeta !== true && metaState === 'absent')
    formalIssues.push(issue('META_MISSING', 'A ready Context tree requires context/meta.json.', META_PATH_FOR_ISSUE))
  if (requireMeta && meta !== undefined) {
    // 正式 Markdown 树要求账本完整覆盖的文档 ID 集合。
    const expectedIds = [...documents.keys()].sort(compareCodeUnits)
    // 账本当前记录的文档 ID 集合。
    const actualIds = Object.keys(meta.documents).sort(compareCodeUnits)
    if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds))
      formalIssues.push(issue('META_DOCUMENT_SET_MISMATCH', 'Meta Document IDs must exactly match the formal Markdown tree.', META_PATH_FOR_ISSUE))
    for (const id of expectedIds) {
      // 当前通过 ID 找到的文档，作为本次判断的依据。
      const document = documents.get(id) as ContextDocument
      // 该文档在持久账本中的内容与源码指纹记录。
      const actual = meta.documents[id]
      if (actual === undefined
        || frontMatterFingerprint(document) !== actual.frontMatterFingerprint
        || bodyFingerprint(document) !== actual.bodyFingerprint) {
        formalIssues.push(issue('META_DOCUMENT_FINGERPRINT_MISMATCH', `Meta content fingerprints for "${id}" are stale or incomplete.`, META_PATH_FOR_ISSUE))
      }
    }
  }

  // 按规范路径与错误码稳定排序的正式知识问题。
  const sortedFormalIssues = formalIssues.sort((left, right) => compareCodeUnits(`${left.path}\0${left.code}`, `${right.path}\0${right.code}`))
  // 由全部结构与账本问题共同决定的正式知识状态。
  const formalState: KnowledgeGraph['formalState'] = sortedFormalIssues.length === 0 && (!requireMeta || metaState === 'valid') ? 'ready' : 'invalid'
  // 按文档或来源组织的当前证据集合。
  const sources = new Map<string, readonly SourceFile[]>()
  // 根据当前源码计算的文档指纹，与持久审查账本分开保存。
  const ledgers = new Map<string, DocumentLedger>()
  // 按文档归属收集的源码证据问题。
  const sourceIssues: SourceKnowledgeIssue[] = []
  // 当前源码展开的可用性，不代表文档已完成语义复核。
  let sourceState: KnowledgeGraph['sourceState'] = 'unchecked'
  // 本次选中源码数据集的整体指纹。
  let sourceDatasetFingerprint: string | undefined

  if (formalState === 'ready' && sourcePolicy !== 'formal-only') {
    // 本次显式选择并排序的文档 ID。
    const selectedIds = sourcePolicy === 'selected'
      ? [...(options.selectedDocumentIds ?? [])].filter(id => documents.has(id)).sort(compareCodeUnits)
      : [...documents.keys()].sort(compareCodeUnits)
    if (selectedIds.length > 0 || sourcePolicy !== 'selected') {
      // 本次源码路径展开及其问题、指纹结果。
      const expansion = await expandSourcePatternSets(root, selectedIds.map(id => ({
        owner: id,
        patterns: (documents.get(id) as ContextDocument).codePaths,
      })))
      sourceDatasetFingerprint = expansion.fingerprint
      // 因源码问题而不能形成完整当前账本的文档或所有者集合。
      const affected = new Set<string>()
      for (const problem of expansion.issues) {
        affected.add(problem.owner)
        sourceIssues.push({
          documentId: problem.owner,
          sourcePattern: problem.pattern,
          code: problem.diagnostic.code,
          message: problem.diagnostic.message,
          path: documents.get(problem.owner)?.path ?? CONTEXT_ROOT,
        })
      }
      for (const id of selectedIds) {
        if (affected.has(id))
          continue
        // 当前通过 ID 找到的文档，作为本次判断的依据。
        const document = documents.get(id) as ContextDocument
        // 当前文档或交付单元实际包含的文件快照。
        const files = expansion.filesByOwner.get(id) ?? []
        sources.set(id, files)
        ledgers.set(id, {
          frontMatterFingerprint: frontMatterFingerprint(document),
          bodyFingerprint: bodyFingerprint(document),
          sourceFingerprint: sourceFingerprint(document, files),
        })
      }
      sourceState = sourceIssues.length === 0 ? 'ready' : 'degraded'
    }
  }

  // 按文档、模式和错误码稳定排序的源码问题。
  const sortedSourceIssues = sourceIssues.sort((left, right) => compareCodeUnits(
    `${left.documentId}\0${left.sourcePattern}\0${left.code}`,
    `${right.documentId}\0${right.sourcePattern}\0${right.code}`,
  ))
  // 全部文档声明的关系边数量。
  const relationCount = [...documents.values()].reduce((total, document) => total
    + document.relations.requires.length + document.relations.related.length + document.relations.supersedes.length, 0)
  // 全部文档源码声明的数量。
  const sourceDeclarationCount = [...documents.values()].reduce((total, document) => total + document.codePaths.length, 0)
  return {
    contextPath,
    formalState,
    sourceState,
    metaState,
    ...(contextFingerprint === undefined ? {} : { contextFingerprint }),
    ...(sourceDatasetFingerprint === undefined ? {} : { sourceFingerprint: sourceDatasetFingerprint }),
    ...(metadata === undefined ? {} : { metadata }),
    documents,
    domains,
    sources,
    ledgers,
    ...(meta === undefined ? {} : { meta }),
    issues: sortedFormalIssues,
    sourceIssues: sortedSourceIssues,
    counts: {
      domains: domains.size,
      design: loaded.counts.design,
      manual: loaded.counts.manual,
      reflections: loaded.counts.reflections,
      documents: documents.size,
    },
    relationCount,
    sourceDeclarationCount,
  }
}

/**
 * 从选中文档展开前置依赖，并保留每个文档进入闭包的原因。
 *
 * @param graph - 当前正式或候选知识快照。
 * @param seeds - 闭包展开的起始文档 ID 集合。
 * @returns 按文档 ID 排序的依赖闭包及其入选原因。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：知识检查、渐进读取、增量分析或候选验证；本函数不写入正式知识。
 */
export function requiresClosure(graph: KnowledgeGraph, seeds: readonly string[]): readonly {
  /** 当前对象的稳定 ID。 */
  readonly id: string
  /** 条目被选中或判定受影响的可解释原因。 */
  readonly reasons: readonly string[]
}[] {
  // 当前文档进入结果或影响集合的可解释原因。
  const reasons = new Map<string, Set<string>>()
  // 尚未处理的闭包节点或待复核文档集合。
  const pending = [...seeds].sort(compareCodeUnits).map(id => ({ id, reason: 'selected' }))
  while (pending.length > 0) {
    // 等待处理的依赖文档及其进入闭包的原因。
    const current = pending.shift() as {
      /** 当前对象的稳定 ID。 */
      id: string
      /** 当前条目进入依赖或影响闭包的原因。 */
      reason: string
    }
    // 当前阶段已登记的身份、字段或访问状态。
    const known = reasons.get(current.id) ?? new Set<string>()
    // 本次增加原因前，该文档已有的入选原因数量。
    const before = known.size
    known.add(current.reason)
    reasons.set(current.id, known)
    if (before > 0)
      continue
    for (const target of graph.documents.get(current.id)?.relations.requires ?? [])
      pending.push({ id: target, reason: `required by ${current.id}` })
  }
  return [...reasons.entries()].sort(([left], [right]) => compareCodeUnits(left, right)).map(([id, values]) => ({
    id,
    reasons: [...values].sort(compareCodeUnits),
  }))
}

/**
 * 投影可供渐进读取的文档元数据，不返回正文或源码内容。
 *
 * @param document - 已解析的文档对象。
 * @param reasons - 文档被选择或受影响的原因列表。
 * @returns 不含正文和源码文件内容的元数据投影。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：知识检查、渐进读取、增量分析或候选验证；本函数不写入正式知识。
 */
export function documentMetadata(document: ContextDocument, reasons?: readonly string[]): JsonObject {
  return {
    id: document.id,
    description: document.description,
    kind: document.kind,
    domain: document.domain,
    path: document.path,
    relations: {
      requires: [...document.relations.requires],
      related: [...document.relations.related],
      supersedes: [...document.relations.supersedes],
    },
    code: { paths: [...document.codePaths] },
    ...(reasons === undefined ? {} : { reasons: [...reasons] }),
  }
}
