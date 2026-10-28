import type { MetadataManifest } from './document.js'
import type { KnowledgeGraph } from './graph.js'
import type { Scope } from './protocol.js'
import type { JsonValue } from './stable-json.js'
import { Buffer } from 'node:buffer'
import { parseMetadataManifest } from './document.js'
import { loadKnowledge } from './graph.js'
import { FORMAT, isRecord, RuntimeFault, sha256 } from './protocol.js'
import { assertSafeRelativePath, assertSourcePattern, CONFIRMATIONS_ROOT, CONTEXT_ROOT, declarationMatches, inspectMetadataLayout, lstatRepositoryPath, MAX_JSON_TEXT_BYTES, MAX_SOURCE_BYTES, MAX_SOURCE_FILES, METADATA_DIRECTORY, readDirectory, readUtf8File } from './repository.js'
import { compactJson, compareCodeUnits, stableJson } from './stable-json.js'

// 确认记录只有四个短字段，读取上限独立于一般 JSON 文件，单位为字节。
export const MAX_CONFIRMATION_BYTES = 4 * 1024
// 文档身份与现有 Markdown 合同一致，不把物理路径作为身份。
const DOCUMENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/
// 确认 key 与所有内容指纹均保留完整 SHA-256。
const HASH = /^[a-f0-9]{64}$/
// 所有记录共用的封闭字段集合，不持久保存 format 或待审状态。
const RECORD_FIELDS = ['bodyFingerprint', 'documentId', 'frontMatterFingerprint', 'sourceFingerprint']

/** 一次内容确认绑定的文档和来源摘要；是否匹配当前内容由读取时计算。 */
export interface ConfirmationRecord {
  /** 与所属记录目录一致的稳定文档身份。 */
  readonly documentId: string
  /** 当前确认所绑定的业务元数据规范指纹。 */
  readonly frontMatterFingerprint: string
  /** 当前确认所绑定的规范化正文指纹。 */
  readonly bodyFingerprint: string
  /** 当前确认所依据的完整声明及实际来源字节指纹。 */
  readonly sourceFingerprint: string
}

/** 已通过格式和路径校验的不可变确认集合，不包含当前状态指针。 */
export interface ConfirmationStore {
  /** 从唯一元数据入口取得的兼容代号。 */
  readonly format: typeof FORMAT
  /** 按文档身份、内容 key 组织的历史确认。 */
  readonly records: ReadonlyMap<string, ReadonlyMap<string, ConfirmationRecord>>
  /** 本次实际读取的记录总数，不是当前文档数量。 */
  readonly count: number
}

/** 对单个当前文档计算的来源可用性和历史确认匹配结果。 */
export interface ConfirmationCheckItem {
  /** 当前文档的稳定身份。 */
  readonly documentId: string
  /** 相对业务仓库的当前规范 Markdown 路径。 */
  readonly path: string
  /** 该文档的来源读取情况，不能由其他文档的状态推断。 */
  readonly sourceState: 'ready' | 'unavailable' | 'unchecked'
  /** 本次匹配结果；不会写回记录或元数据入口。 */
  readonly confirmationState: 'matched' | 'unmatched' | 'unavailable' | 'unchecked'
  /** 来源完整时才计算的当前内容 key。 */
  readonly currentKey?: string
  /** 仅精确匹配时返回，必定等于 currentKey。 */
  readonly matchedKey?: string
  /** 是否存在相同正文及元数据的历史确认，不代表当前来源一致。 */
  readonly documentContentKnown?: boolean
  /** 稳定、有序的解释码，不推测哪条历史记录是最新的。 */
  readonly reasons: readonly string[]
}

/** 内部检查的完整结果；公开能力接入时必须在此基础上分页。 */
export interface ConfirmationSnapshot {
  /** 经过两轮内容采样核对的新布局知识图。 */
  readonly graph: KnowledgeGraph
  /** 本次读取并验证的完整确认集合。 */
  readonly store: ConfirmationStore
  /** 按文档身份排序的所选文档结果。 */
  readonly items: readonly ConfirmationCheckItem[]
  /** 绑定格式、Context、所选来源及选择集合的内容快照。 */
  readonly snapshotFingerprint: string
}

/** 校验调用方已从入口读取的统一兼容代号，不猜测当前插件所写格式。 */
function assertFormat(format: unknown): asserts format is typeof FORMAT {
  if (format !== FORMAT)
    throw new RuntimeFault('FORMAT_UNSUPPORTED', 'The confirmation compatibility format is unsupported.')
}

/** 校验四字段记录的完整形状，拒绝额外状态及被误拼接的字段结构。 */
function validRecord(value: unknown): value is ConfirmationRecord {
  return isRecord(value)
    && Object.keys(value).sort(compareCodeUnits).join('\0') === RECORD_FIELDS.join('\0')
    && typeof value.documentId === 'string' && DOCUMENT_ID.test(value.documentId)
    && [value.frontMatterFingerprint, value.bodyFingerprint, value.sourceFingerprint]
      .every(item => typeof item === 'string' && HASH.test(item))
}

/**
 * 将统一 format 与完整确认记录绑定为稳定身份。
 *
 * @param format - 所属元数据入口的兼容代号。
 * @param record - 已完成内容核对后拟保存或已读取的四字段记录。
 * @returns 不含路径、Git 身份、时间或插件版本的 64 位 SHA-256 key。
 * @throws format 不支持或记录形状无效时抛出 RuntimeFault。
 * @remarks 调用阶段：候选推导和记录校验；只计算身份，不代表语义批准。
 */
export function confirmationKey(format: unknown, record: ConfirmationRecord): string {
  assertFormat(format)
  if (!validRecord(record))
    throw new RuntimeFault('CONFIRMATION_RECORD_INVALID', 'A confirmation must contain exactly one complete content and source tuple.')
  return sha256(compactJson({ format, record } as unknown as JsonValue))
}

/**
 * 严格解析确认文件，同时核对文档归属、规范字节与文件名身份。
 *
 * @param format - 所属元数据入口的兼容代号。
 * @param documentId - 记录所属目录的文档身份。
 * @param key - 文件名中的完整 SHA-256，不含扩展名。
 * @param source - 严格 UTF-8 解码的文件文本。
 * @returns 校验通过的不可变确认内容。
 * @throws 形状、资源限制、规范字节、归属或 key 不匹配时抛出 RuntimeFault。
 * @remarks 调用阶段：读取历史确认或候选校验；不改写坏记录，不静默跳过。
 */
export function parseConfirmation(format: unknown, documentId: string, key: string, source: string): ConfirmationRecord {
  assertFormat(format)
  if (!DOCUMENT_ID.test(documentId) || !HASH.test(key))
    throw new RuntimeFault('CONFIRMATION_PATH_INVALID', 'A confirmation path requires a Document ID and a complete content key.')
  // 错误输出使用正式路径，不暴露候选目录或机器根目录。
  const sourcePath = `${CONFIRMATIONS_ROOT}/${documentId}/${key}.json`
  assertSafeRelativePath(sourcePath)
  if (Buffer.byteLength(source, 'utf8') > MAX_CONFIRMATION_BYTES)
    throw new RuntimeFault('CONFIRMATION_SIZE_EXCEEDED', 'A confirmation exceeds its byte limit.', sourcePath)
  // 必须在规范字节比较前保留完整原文，避免重复 JSON 键被自动接纳。
  let raw: unknown
  try {
    raw = JSON.parse(source) as unknown
  }
  catch (error) {
    if (!(error instanceof SyntaxError))
      throw error
    throw new RuntimeFault('CONFIRMATION_JSON_INVALID', 'A confirmation must contain valid JSON.', sourcePath)
  }
  if (!validRecord(raw))
    throw new RuntimeFault('CONFIRMATION_RECORD_INVALID', 'A confirmation has an invalid shape.', sourcePath)
  if (raw.documentId !== documentId)
    throw new RuntimeFault('CONFIRMATION_DOCUMENT_MISMATCH', 'A confirmation belongs to another Document.', sourcePath)
  if (source !== stableJson(raw as unknown as JsonValue))
    throw new RuntimeFault('CONFIRMATION_NON_CANONICAL', 'A confirmation must use canonical JSON without duplicate keys.', sourcePath)
  if (confirmationKey(format, raw) !== key)
    throw new RuntimeFault('CONFIRMATION_KEY_MISMATCH', 'A confirmation does not match its content key.', sourcePath)
  return raw
}

/**
 * 读取并验证全部确认记录；没有确认目录时返回合法的空集合。
 *
 * @param root - 业务仓库根目录。
 * @param format - 调用方固定的兼容代号，必须与入口一致。
 * @param contextPath - 正式或候选 Context 的仓库相对路径。
 * @returns 按内容 key 保存的已校验记录，不选择 latest 或合并记录字段。
 * @throws 入口冲突、目录/文件不安全、坏记录或资源超限时抛出 RuntimeFault。
 * @remarks 调用阶段：新布局查询和事务校验；只读，不为缺失记录创建文件。
 */
export async function readConfirmationStore(root: string, format: unknown, contextPath = CONTEXT_ROOT): Promise<ConfirmationStore> {
  assertFormat(format)
  if (await inspectMetadataLayout(root, contextPath) !== 'current')
    throw new RuntimeFault('METADATA_LAYOUT_REQUIRED', 'Confirmation reads require a unique current metadata entry.', contextPath)
  // 即使记录单独读取，也必须验证它们所属的实际入口，不能只信调用参数。
  const metadataPath = `${contextPath}/${METADATA_DIRECTORY}`
  // 本次校验或写入的统一格式入口。
  const metadata: MetadataManifest = parseMetadataManifest(`${CONTEXT_ROOT}/${METADATA_DIRECTORY}/manifest.json`, await readUtf8File(root, `${metadataPath}/manifest.json`, MAX_JSON_TEXT_BYTES))
  if (metadata.format !== format)
    throw new RuntimeFault('FORMAT_UNSUPPORTED', 'The requested format does not match the metadata entry.')
  // 当前记录集合所属的安全目录。
  const directory = `${metadataPath}/confirmations`
  // 通过安全路径读取的当前文件类型事实。
  const info = await lstatRepositoryPath(root, directory)
  // 每个 Document 的记录独立保存，集合中可以保留已删除文档的历史确认。
  const records = new Map<string, ReadonlyMap<string, ConfirmationRecord>>()
  if (info === undefined)
    return { format, records, count: 0 }
  if (!info.isDirectory())
    throw new RuntimeFault('CONFIRMATION_DIRECTORY_INVALID', 'Confirmations must be stored in a regular directory.', CONFIRMATIONS_ROOT)
  // 整次读取共用数量及字节预算，不能按文档分别绕过限制。
  let count = 0
  // 当前读取字节或累计字节数，用于完整性和预算检查。
  let bytes = 0
  for (const entry of await readDirectory(root, directory)) {
    if (entry.kind !== 'directory' || !DOCUMENT_ID.test(entry.name))
      throw new RuntimeFault('CONFIRMATION_DIRECTORY_INVALID', 'Confirmation directories must be ordinary Document ID directories.', CONFIRMATIONS_ROOT)
    // 当前文档的不可变确认映射。
    const byKey = new Map<string, ConfirmationRecord>()
    for (const file of await readDirectory(root, `${directory}/${entry.name}`)) {
      if (file.kind !== 'file' || !/^[a-f0-9]{64}\.json$/.test(file.name))
        throw new RuntimeFault('CONFIRMATION_PATH_INVALID', 'A confirmation directory contains a non-ordinary or invalid record.', `${CONFIRMATIONS_ROOT}/${entry.name}`)
      count += 1
      if (count > MAX_SOURCE_FILES)
        throw new RuntimeFault('FORMAL_FILE_LIMIT_EXCEEDED', 'The confirmation store exceeds the file-count limit.')
      // 严格读取并受字节预算限制的记录原文。
      const text = await readUtf8File(root, `${directory}/${entry.name}/${file.name}`, MAX_CONFIRMATION_BYTES)
      bytes += Buffer.byteLength(text, 'utf8')
      if (bytes > MAX_SOURCE_BYTES)
        throw new RuntimeFault('FORMAL_BYTE_LIMIT_EXCEEDED', 'The confirmation store exceeds the byte limit.')
      // 绑定完整确认内容与 format 的稳定身份。
      const key = file.name.slice(0, -5)
      byKey.set(key, parseConfirmation(format, entry.name, key, text))
    }
    records.set(entry.name, byKey)
  }
  return { format, records, count }
}

/**
 * 从完整当前来源的读取结果构造候选确认，不为缺失或未读来源制造摘要。
 *
 * @param graph - 已按统一 format 读取的当前知识图。
 * @param documentId - 必须存在的当前文档身份。
 * @returns 来源完整时的四字段内容；不可用或未检查时为 undefined。
 * @throws 图无效、格式不符或文档不存在时抛出 RuntimeFault。
 * @remarks 调用阶段：查询和候选推导；返回数据不构成语义批准或正式写入。
 */
export function currentConfirmation(graph: KnowledgeGraph, documentId: string): ConfirmationRecord | undefined {
  if (graph.formalState !== 'ready' || graph.metadata?.format !== FORMAT)
    throw new RuntimeFault('CONFIRMATION_CONTEXT_INVALID', 'Current confirmations require a valid current-format Context.')
  if (!graph.documents.has(documentId))
    throw new RuntimeFault('CONFIRMATION_DOCUMENT_UNKNOWN', 'The selected Document does not exist.')
  // graph.ledgers 仅包含来源完整且本轮实际读取过的文档，不使用旧 Meta 值。
  const current = graph.ledgers.get(documentId)
  if (current === undefined)
    return undefined
  return { documentId, frontMatterFingerprint: current.frontMatterFingerprint, bodyFingerprint: current.bodyFingerprint, sourceFingerprint: current.sourceFingerprint }
}

/** 组合单文档的当前来源事实与不可变记录，精确匹配不会跨记录拼接字段。 */
function checkDocument(graph: KnowledgeGraph, store: ConfirmationStore, documentId: string): ConfirmationCheckItem {
  // 本轮可用来源对应的完整内容元组。
  const current = currentConfirmation(graph, documentId)
  // 已验证存在的当前 Markdown 文档。
  const document = graph.documents.get(documentId)!
  if (current === undefined) {
    // 仅该文档的实际读取问题才能说明来源不可用，否则只是未检查。
    const unavailable = graph.sourceIssues.some(problem => problem.documentId === documentId)
    return { documentId, path: document.path, sourceState: unavailable ? 'unavailable' : 'unchecked', confirmationState: unavailable ? 'unavailable' : 'unchecked', reasons: unavailable ? ['SOURCE_UNAVAILABLE'] : [] }
  }
  // 当前文档与实际来源的完整内容身份。
  const currentKey = confirmationKey(store.format, current)
  // 本次匹配可用的历史确认集合。
  const records = store.records.get(documentId)
  if (records?.has(currentKey))
    return { documentId, path: document.path, sourceState: 'ready', confirmationState: 'matched', currentKey, matchedKey: currentKey, documentContentKnown: true, reasons: [] }
  // 相同正文的历史确认只说明内容曾被核对，不能代替当前来源匹配。
  const documentContentKnown = [...records?.values() ?? []].some(record => record.frontMatterFingerprint === current.frontMatterFingerprint && record.bodyFingerprint === current.bodyFingerprint)
  return { documentId, path: document.path, sourceState: 'ready', confirmationState: 'unmatched', currentKey, documentContentKnown, reasons: [records === undefined || records.size === 0 ? 'NO_CONFIRMATION' : documentContentKnown ? 'SOURCE_BASIS_CHANGED' : 'DOCUMENT_CONTENT_UNKNOWN'] }
}

/**
 * 在两轮相同快照上检查完整或选定文档，供后续公开分页能力复用。
 *
 * @param root - 业务仓库根目录。
 * @param selectedDocumentIds - 唯一的选择集合；内部空集合表示无命中，省略时检查全部。
 * @param contextPath - 正式或候选 Context 的仓库相对路径。
 * @returns 完整的内部结果、记录集合及绑定选择的快照指纹；调用方负责公开分页。
 * @throws 选择错误、坏结构/记录、资源超限或两轮内容变化时抛出 RuntimeFault。
 * @remarks 调用阶段：新布局只读检查及候选复验；不调用模型、Git 或任何写入操作。
 */
export async function checkConfirmations(root: string, selectedDocumentIds?: readonly string[], contextPath = CONTEXT_ROOT): Promise<ConfirmationSnapshot> {
  if (selectedDocumentIds !== undefined && (new Set(selectedDocumentIds).size !== selectedDocumentIds.length || selectedDocumentIds.some(id => !DOCUMENT_ID.test(id))))
    throw new RuntimeFault('CONFIRMATION_SELECTION_INVALID', 'Select unique valid Document IDs or omit the selection.')
  // 固定选择顺序及读取范围，避免调用方在 await 期间改变数组。
  const selected = selectedDocumentIds === undefined ? undefined : [...selectedDocumentIds].sort(compareCodeUnits)
  // 固定的格式及来源选择，不允许 await 期间被外部改变。
  const options = { format: FORMAT, sourcePolicy: selected === undefined ? 'all-tolerant' : 'selected', ...(selected === undefined ? {} : { selectedDocumentIds: selected }) } as const
  // 本次实际读取的知识图和来源事实。
  const graph = await loadKnowledge(root, contextPath, options)
  if (graph.formalState !== 'ready' || graph.contextFingerprint === undefined) {
    // 用于报告结构失败的首个稳定诊断。
    const first = graph.issues[0]
    throw new RuntimeFault(first?.code ?? 'CONFIRMATION_CONTEXT_INVALID', first?.message ?? 'Current-format Context is not ready.', first?.path)
  }
  // 本次需要检查的确定性文档 ID 集合。
  const ids = selected ?? [...graph.documents.keys()].sort(compareCodeUnits)
  if (ids.some(id => !graph.documents.has(id)))
    throw new RuntimeFault('CONFIRMATION_DOCUMENT_UNKNOWN', 'A selected Document does not exist.')
  // 已经验证入口、路径和规范字节的完整确认集合。
  const store = await readConfirmationStore(root, FORMAT, contextPath)
  // 按固定文档顺序生成的只读匹配结果。
  const items = ids.map(id => checkDocument(graph, store, id))
  // 再次读取包括确认文件在内的正式树和来源，拒绝混合两个时刻的判断。
  const final = await loadKnowledge(root, contextPath, options)
  if (final.formalState !== 'ready' || final.contextFingerprint !== graph.contextFingerprint || final.sourceFingerprint !== graph.sourceFingerprint)
    throw new RuntimeFault('CHECK_SNAPSHOT_CHANGED', 'Context or selected source evidence changed during confirmation checking.')
  // 同时绑定格式、正式树、来源与选择集合的快照。
  const snapshotFingerprint = sha256(compactJson({ format: FORMAT, contextFingerprint: graph.contextFingerprint, sourceFingerprint: graph.sourceFingerprint ?? null, selectedDocumentIds: ids }))
  return { graph, store, items, snapshotFingerprint }
}

/** 按调用范围选择文档；缺失 exact 来源仍保留归属，不把历史失配扩大为全仓维护。 */
export function selectDocumentIds(graph: KnowledgeGraph, scope: Scope, changedPaths: readonly string[] = []): readonly string[] {
  if (scope.kind === 'paths')
    scope.paths.forEach(assertSourcePattern)
  if (scope.kind === 'documents' && scope.ids.some(id => !graph.documents.has(id)))
    throw new RuntimeFault('SCOPE_DOCUMENT_UNKNOWN', 'Scope contains an unknown Document.')
  if (scope.kind === 'domains' && scope.ids.some(id => !graph.domains.has(id)))
    throw new RuntimeFault('SCOPE_DOMAIN_UNKNOWN', 'Scope contains an unknown Domain.')
  return [...graph.documents.values()].filter((document) => {
    if (scope.kind === 'repository')
      return true
    if (scope.kind === 'documents')
      return scope.ids.includes(document.id)
    if (scope.kind === 'domains')
      return scope.ids.includes(document.domain)
    // 声明、当前文件与显式变更路径共同提供的归属线索。
    const paths = [...document.codePaths.filter(pattern => !pattern.includes('*')), ...(graph.sources.get(document.id) ?? []).map(file => file.path), ...changedPaths.filter(candidate => document.codePaths.some(pattern => declarationMatches(pattern, candidate)))]
    return scope.paths.some(pattern => document.codePaths.includes(pattern) || paths.some(candidate => declarationMatches(pattern, candidate))
      || (!pattern.includes('*') && document.codePaths.some(declaration => declarationMatches(declaration, pattern))))
  }).map(document => document.id).sort(compareCodeUnits)
}
