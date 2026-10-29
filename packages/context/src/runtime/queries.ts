import type { ContextDocument, Metrics } from './document.js'
import type { KnowledgeGraph } from './graph.js'
import type {
  ConfirmationCheckInput,
  CursorPosition,
  Diagnostic,
  FeedbackMatchInput,
  FrontierQueryInput,
  RepositoryInspectInput,
  RuntimeRequest,
  RuntimeResponse,
} from './protocol.js'
import type { JsonObject, JsonValue } from './stable-json.js'
import { Buffer } from 'node:buffer'
import { checkConfirmations, currentConfirmation, readConfirmationStore, selectDocumentIds } from './confirmation.js'
import { bodyFingerprint } from './document.js'
import { documentMetadata, graphMetrics, loadKnowledge, requiresClosure } from './graph.js'
import { planLegacyMigration } from './migration.js'
import {
  decodeCursor,
  diagnostic,
  encodeCursor,
  fitBodyChunk,
  FORMAT,
  paginate,
  resolvedBudget,
  RuntimeFault,
  runtimeResponse,
  sha256,
} from './protocol.js'
import {
  assertSourcePattern,
  declarationMatches,
  decodeUtf8,
  FEEDBACK_ROOT,
  inspectMetadataLayout,
  LOCK_ROOT,
  MAX_JSON_TEXT_BYTES,
  pathExists,
  readDirectory,
  readLockOwner,
  readRegularBytes,
  readUtf8File,
  RUNS_ROOT,
} from './repository.js'
import { planRetention } from './retention.js'
import { compactJson, compareCodeUnits } from './stable-json.js'

// 检查活动事务时认可的工作流命令集合。
const TRANSACTION_COMMANDS = new Set(['init', 'update', 'prune', 'migrate', 'compact'])
// 检查活动事务时认可的持久阶段集合。
const TRANSACTION_PHASES = new Set(['staged', 'validated', 'committing', 'committed', 'restored', 'recovery_required', 'failed'])

/** 把知识问题转换为协议诊断，可按需要包含源码证据错误。 */
function issueDiagnostics(graph: KnowledgeGraph, includeSource = false): readonly Diagnostic[] {
  return [
    ...graph.issues.map(item => diagnostic(item.code, item.message, 'error', item.path)),
    ...(includeSource ? graph.sourceIssues.map(item => diagnostic(item.code, item.message, 'error', item.path)) : []),
  ]
}

/** 拒绝读取缺失或损坏的正式知识，优先报告原始诊断。 */
function requireFormalReady(graph: KnowledgeGraph): void {
  if (graph.formalState !== 'ready') {
    // 优先公开或判定的首个问题项。
    const first = graph.issues[0]
    throw new RuntimeFault(
      first?.code ?? 'CONTEXT_NOT_READY',
      first?.message ?? 'Formal Context is not ready.',
      first?.path ?? 'context',
    )
  }
}

/** 只读检查写锁及其事务清单，暴露活动事务或恢复提示。 */
async function activeRun(root: string): Promise<{
  /** 当前结果分区所承载的 JSON 数据。 */
  readonly value?: JsonObject
  /** 面向调用方的问题列表，输出时统一排序和裁剪。 */
  readonly diagnostics: readonly Diagnostic[]
}> {
  // 当前仓库写锁的所有者状态。
  const lock = await readLockOwner(root)
  if (lock.state === 'absent')
    return { diagnostics: [] }
  if (lock.state === 'corrupt')
    return { diagnostics: [diagnostic('WRITE_LOCK_INVALID', 'The Context write lock owner is invalid.', 'warning', LOCK_ROOT)] }
  // 当前事务持久清单的仓库相对路径。
  const manifestPath = `${RUNS_ROOT}/${lock.runId}/manifest.json`
  try {
    // 已解析的事务阶段、冻结输入和恢复事实。
    const manifest = JSON.parse(await readUtf8File(root, manifestPath, MAX_JSON_TEXT_BYTES)) as unknown
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest))
      return { diagnostics: [diagnostic('ACTIVE_RUN_INVALID', 'The active transaction manifest is invalid.', 'warning', manifestPath)] }
    // 从当前对象取得、尚待类型与内容校验的字段值。
    const value = manifest as Record<string, unknown>
    if (value.kind !== 'plugydown.context.transaction' || value.format !== FORMAT || value.runId !== lock.runId || typeof value.command !== 'string' || !TRANSACTION_COMMANDS.has(value.command)
      || typeof value.phase !== 'string' || !TRANSACTION_PHASES.has(value.phase)) {
      return { diagnostics: [diagnostic('ACTIVE_RUN_INVALID', 'The active transaction manifest identity is invalid.', 'warning', manifestPath)] }
    }
    return { value: { runId: lock.runId, command: value.command, phase: value.phase }, diagnostics: [] }
  }
  catch (error) {
    if (error instanceof RuntimeFault || error instanceof SyntaxError)
      return { diagnostics: [diagnostic('ACTIVE_RUN_INVALID', 'The active transaction could not be inspected safely.', 'warning', LOCK_ROOT)] }
    throw error
  }
}

/**
 * 在完整一致快照上只读预览集中保留结果，不返回无界身份列表。
 * @param root - 业务仓库根目录。
 * @returns 固定大小的保留摘要与快照身份，不创建运行或写锁。
 * @throws 来源不可用、结构或记录损坏、采样变化时返回上层可封装的 RuntimeFault。
 * @remarks 调用阶段：主线自动任务判断是否需要 compact；不是语义批准。
 */
export async function confirmationRetention(root: string): Promise<RuntimeResponse> {
  // 两轮采样已经证明图、记录及当前来源属于同一读取快照。
  const snapshot = await checkConfirmations(root)
  if (snapshot.graph.sourceState !== 'ready')
    throw new RuntimeFault('RETENTION_SOURCE_UNAVAILABLE', 'Retention requires complete current source evidence.')
  const current = new Map([...snapshot.graph.documents.keys()].map(id => [id, currentConfirmation(snapshot.graph, id)!]))
  const plan = planRetention(snapshot.store, current)
  return runtimeResponse('confirmation.retention', 'success', {
    data: {
      contextFingerprint: snapshot.graph.contextFingerprint!,
      snapshotFingerprint: snapshot.snapshotFingerprint,
      retention: { ...plan.summary },
    },
  })
}

/**
 * 检查 Context、账本和活动事务；按需返回选中文档状态或分页修复计划。
 *
 * @param root - 业务仓库根目录。
 * @param request - 当前能力的请求；除入口解析函数外应已通过协议校验。
 * @returns 检查结果页；请求成功时 Context 本身仍可能为 invalid。
 * @throws 输入、游标或读取前置条件不满足时抛出 RuntimeFault，由请求入口转换为 failed 响应。
 * @remarks 调用阶段：知识检查、渐进读取、增量分析或候选验证；本函数不写入正式知识。
 */
export async function repositoryInspect(root: string, request: RuntimeRequest): Promise<RuntimeResponse> {
  // 当前能力经过解析的输入，不在 await 后重新读取宿主对象。
  const input = request.input as RepositoryInspectInput
  // 独立于源码可用性的持久元数据布局状态。
  let layout: 'absent' | 'legacy' | 'current' | 'incomplete' | 'invalid'
  try {
    layout = await inspectMetadataLayout(root)
  }
  catch (error) {
    if (!(error instanceof RuntimeFault))
      throw error
    layout = 'invalid'
  }
  if (layout === 'legacy' && input.selectedDocumentIds !== undefined)
    throw new RuntimeFault('MIGRATION_REQUIRED', 'Migrate legacy Context before checking current confirmations.')
  // 显式请求时生成的只读历史迁移计划。
  const plan = input.migration === true ? await planLegacyMigration(root) : undefined
  // 本次读取的知识快照，后续判断以该快照为准。
  const graph = plan?.graph ?? await loadKnowledge(root, undefined, { ...(layout === 'legacy' ? { legacy: true as const } : {}), sourcePolicy: 'formal-only' })
  // 当前工作树的事务锁和活动运行提示。
  const active = await activeRun(root)
  // 显式选择的文档确认结果，缺省不读取来源。
  const checked = input.selectedDocumentIds !== undefined && layout === 'current'
    ? await checkConfirmations(root, input.selectedDocumentIds)
    : undefined
  // 已校验 canonical 字节、路径与身份的历史记录集合。
  const store = layout === 'current' && graph.formalState === 'ready' ? await readConfirmationStore(root, FORMAT) : undefined
  // 包括确认文件在内的 Context 整树摘要。
  const contextFingerprint = graph.contextFingerprint ?? 'formal:absent'
  // 绑定当前能力附加状态的游标摘要。
  const stateFingerprint = sha256(compactJson({ snapshot: checked?.snapshotFingerprint ?? null, active: active.value ?? null, plan: plan?.planFingerprint ?? null }))
  // 与本次输入和快照匹配的续读位置。
  const position = decodeCursor(request.cursor, request.capability, request.input, contextFingerprint, stateFingerprint)
  // 将下一位置绑定到同一完整快照的续读令牌。
  const cursorFor = (next: CursorPosition): string => encodeCursor(request.capability, request.input, contextFingerprint, stateFingerprint, next)
  // 构造同一合同的完整响应，亦供分页预算计算。
  const response = (items: readonly JsonObject[], cursor?: string): RuntimeResponse => runtimeResponse('repository.inspect', cursor === undefined ? 'success' : 'incomplete', {
    data: {
      context: { state: layout === 'legacy' ? 'legacy' : graph.formalState, sourceState: checked?.graph.sourceState ?? graph.sourceState, ...(graph.contextFingerprint === undefined ? {} : { fingerprint: graph.contextFingerprint }) },
      meta: { state: graph.metaState, layout },
      ...(graph.formalState === 'absent' ? {} : { counts: { ...graph.counts } }),
      ...(store === undefined ? {} : { confirmationCount: store.count }),
      ...(active.value === undefined ? {} : { activeRun: active.value }),
      ...(plan === undefined
        ? input.selectedDocumentIds === undefined ? {} : { selected: [...items] }
        : { migration: { eligible: plan.eligible, strategy: plan.strategy, documentCount: plan.items.length, importCount: plan.records.size, planFingerprint: plan.planFingerprint, items: [...items] } }),
    },
    ...(cursor === undefined ? {} : { cursor }),
    diagnostics: [...issueDiagnostics(graph), ...active.diagnostics, ...(layout === 'legacy' ? [diagnostic('MIGRATION_REQUIRED', 'Use explicit migration before current-format maintenance.', 'warning', 'context/meta.json')] : [])],
  })
  // 按稳定顺序排列的完整分页条目集合。
  const stream = plan?.items ?? checked?.items.map(item => ({ ...item, reasons: [...item.reasons] })) ?? []
  // 在响应预算内可公开的当前结果页。
  const page = paginate(stream, position, resolvedBudget(request), { response, cursor: cursorFor })
  return response(page.items, page.nextPosition === undefined ? undefined : cursorFor(page.nextPosition))
}

/**
 * 检查请求范围的确认匹配，并返回有界分页事实。
 * @param root - 业务仓库根目录。
 * @param request - 经过协议解析的只读请求。
 * @returns 匹配统计及条目；失配不等于调用失败。
 * @throws 结构、记录损坏或快照变化时抛出 RuntimeFault。
 * @remarks 只读；调用方自行执行明确的 CI 政策，不自动写入确认。
 */
export async function confirmationCheck(root: string, request: RuntimeRequest): Promise<RuntimeResponse> {
  // 当前能力经过解析的输入，不在 await 后重新读取宿主对象。
  const input = request.input as ConfirmationCheckInput
  if (input.scope.kind === 'paths')
    input.scope.paths.forEach(assertSourcePattern)
  // 全仓检查直接使用两轮完整快照；仅局部选择需要额外的路由快照。
  const initial = input.scope.kind === 'repository' ? undefined : await loadKnowledge(root, undefined, { sourcePolicy: input.scope.kind === 'paths' ? 'all-tolerant' : 'formal-only' })
  if (initial !== undefined)
    requireFormalReady(initial)
  const selected = initial === undefined ? undefined : selectDocumentIds(initial, input.scope)
  // 经过两轮读取核对的确认与来源事实。
  const snapshot = await checkConfirmations(root, selected)
  const ids = selected ?? [...snapshot.graph.documents.keys()].sort(compareCodeUnits)
  // 再次核对路径展开，拒绝选定期间出现或消失的文件。
  const selectionCheck = input.scope.kind === 'paths' ? await loadKnowledge(root, undefined, { sourcePolicy: 'all-tolerant' }) : undefined
  if (selectionCheck !== undefined && (selectionCheck.contextFingerprint !== initial!.contextFingerprint || selectionCheck.sourceFingerprint !== initial!.sourceFingerprint))
    throw new RuntimeFault('CHECK_SNAPSHOT_CHANGED', 'Sources changed while resolving the path selection.')
  if (initial !== undefined && snapshot.graph.contextFingerprint !== initial.contextFingerprint)
    throw new RuntimeFault('CHECK_SNAPSHOT_CHANGED', 'Context changed while selecting Documents.')
  // 规范请求摘要，不无界回显调用方范围列表。
  const requestFingerprint = sha256(compactJson(request.input as unknown as JsonValue))
  // 绑定请求、内容和所读来源的确定性快照身份。
  const fingerprint = sha256(compactJson({ snapshot: snapshot.snapshotFingerprint, requestFingerprint }))
  // 与本次输入和快照匹配的续读位置。
  const position = decodeCursor(request.cursor, request.capability, request.input, snapshot.graph.contextFingerprint!, fingerprint)
  // 将下一位置绑定到同一完整快照的续读令牌。
  const cursorFor = (next: CursorPosition): string => encodeCursor(request.capability, request.input, snapshot.graph.contextFingerprint!, fingerprint, next)
  // 完整仓库与请求范围的覆盖计数，不是当前页条数。
  const counts = { documents: snapshot.graph.documents.size, checked: ids.length, matched: 0, unmatched: 0, unavailable: 0, unchecked: snapshot.graph.documents.size - ids.length }
  for (const item of snapshot.items) {
    if (item.confirmationState !== 'unchecked')
      counts[item.confirmationState] += 1
  }
  // 构造同一合同的完整响应，亦供分页预算计算。
  const response = (items: readonly JsonObject[], cursor?: string): RuntimeResponse => runtimeResponse('confirmation.check', cursor === undefined ? 'success' : 'incomplete', {
    data: { scope: { kind: input.scope.kind, requestFingerprint }, structureState: 'valid', recordStore: { state: 'valid', coverage: 'repository' }, sourceState: ids.length === 0 ? 'unchecked' : counts.unavailable > 0 ? 'degraded' : 'ready', snapshotFingerprint: fingerprint, summary: counts, items: [...items] },
    ...(cursor === undefined ? {} : { cursor }),
    diagnostics: issueDiagnostics(snapshot.graph, true),
  })
  // 按稳定顺序排列的完整分页条目集合。
  const stream = snapshot.items.map(item => ({ ...item, reasons: input.explain ? [...item.reasons] : [] }))
  // 在响应预算内可公开的当前结果页。
  const page = paginate(stream, position, resolvedBudget(request), { response, cursor: cursorFor })
  return response(page.items, page.nextPosition === undefined ? undefined : cursorFor(page.nextPosition))
}

/** 近似判断源码声明与路径选择器是否相交。 */
function pathSelects(document: ContextDocument, selector: string): boolean {
  // 当前用双向声明匹配近似判断交集；两侧都含中段通配符时可能漏判，例如 packages/*/a.ts 与 packages/foo/**。出现需求时需改为模式交集算法。
  return document.codePaths.some(pattern =>
    declarationMatches(pattern, selector) || declarationMatches(selector, pattern))
}

/** 按选择器和依赖闭包生成确定排序的渐进读取候选。 */
function frontierCandidates(graph: KnowledgeGraph, input: FrontierQueryInput): readonly {
  /** 已通过解析的文档，失败分支不提供部分结果。 */
  readonly document: ContextDocument
  /** 条目被选中或判定受影响的可解释原因。 */
  readonly reasons: readonly string[]
}[] {
  // 经字段校验的渐进读取选择条件。
  const selectors = input.selectors
  if (input.depth === 1) {
    // 当前选择或授权涉及的稳定身份集合。
    let ids = [...graph.domains.keys()]
    if (selectors?.domainIds !== undefined)
      ids = ids.filter(id => selectors.domainIds?.includes(id))
    if (selectors?.documentIds !== undefined) {
      // 选择器命中的领域 ID 集合。
      const selectedDomains = new Set(selectors.documentIds.map(id => graph.documents.get(id)?.domain).filter((id): id is string => id !== undefined))
      ids = ids.filter(id => selectedDomains.has(id))
    }
    if (selectors?.kinds !== undefined && !selectors.kinds.includes('domain'))
      ids = []
    if (selectors?.relation !== undefined) {
      // 关系选择器指向的目标文档集合。
      const related = graph.documents.get(selectors.relation.documentId)?.relations[selectors.relation.type] ?? []
      // 当前读取或选择涉及的领域集合。
      const domains = new Set(related.map(id => graph.documents.get(id)?.domain).filter((id): id is string => id !== undefined))
      ids = ids.filter(id => domains.has(id))
    }
    if (selectors?.codePaths !== undefined) {
      // 当前读取或选择涉及的领域集合。
      const domains = new Set([...graph.documents.values()]
        .filter(document => selectors.codePaths?.some(candidate => pathSelects(document, candidate)))
        .map(document => document.domain))
      ids = ids.filter(id => domains.has(id))
    }
    return ids.sort(compareCodeUnits).flatMap((id) => {
      // 领域入口文档的稳定 ID，用于返回路由元数据。
      const domainDocumentId = graph.domains.get(id)?.domainDocumentId
      // 当前通过 ID 找到的文档，作为本次判断的依据。
      const document = domainDocumentId === undefined ? undefined : graph.documents.get(domainDocumentId)
      return document === undefined ? [] : [{ document, reasons: ['selected Domain'] }]
    })
  }

  // 闭包展开前已经选中的文档及其原因集合。
  const seeds = new Map<string, Set<string>>()
  /** 合并文档的选中原因，避免同一候选重复进入读取流。 */
  const add = (id: string, reason: string): void => {
    if (!graph.documents.has(id))
      return
    // 当前文档进入结果或影响集合的可解释原因。
    const reasons = seeds.get(id) ?? new Set<string>()
    reasons.add(reason)
    seeds.set(id, reasons)
  }
  selectors?.documentIds?.forEach(id => add(id, 'selected Document'))
  selectors?.domainIds?.forEach((domain) => {
    for (const id of graph.domains.get(domain)?.documentIds ?? [])
      add(id, `selected Domain ${domain}`)
  })
  if (selectors?.kinds !== undefined) {
    for (const document of graph.documents.values()) {
      if (selectors.kinds.includes(document.kind)
        && (selectors.domainIds === undefined || selectors.domainIds.includes(document.domain))) {
        add(document.id, `selected kind ${document.kind}`)
      }
    }
  }
  if (selectors?.relation !== undefined) {
    for (const id of graph.documents.get(selectors.relation.documentId)?.relations[selectors.relation.type] ?? [])
      add(id, `${selectors.relation.type} from ${selectors.relation.documentId}`)
  }
  selectors?.codePaths?.forEach((candidate) => {
    for (const document of graph.documents.values()) {
      if (pathSelects(document, candidate))
        add(document.id, `code path ${candidate}`)
    }
  })
  if (input.requiresClosure === true) {
    for (const item of requiresClosure(graph, [...seeds.keys()]))
      item.reasons.forEach(reason => add(item.id, reason))
  }
  return [...seeds.entries()]
    .map(([id, reasons]) => ({ document: graph.documents.get(id) as ContextDocument, reasons: [...reasons].sort(compareCodeUnits) }))
    .sort((left, right) => {
      // 左侧候选的领域入口优先级，用于稳定排序。
      const leftDomain = left.document.kind === 'domain' ? 0 : 1
      // 右侧候选的领域入口优先级，用于稳定排序。
      const rightDomain = right.document.kind === 'domain' ? 0 : 1
      return leftDomain - rightDomain || compareCodeUnits(left.document.id, right.document.id)
    })
}

/** 渐进读取流中的文档及其选中原因、元数据和可选正文。 */
interface FrontierItem {
  /** 供渐进读取的文档元数据投影。 */
  readonly metadata: JsonObject
  /** 已规范化的文档正文，不包含 front matter。 */
  readonly body?: string
}

/**
 * 按深度与选择器读取知识，受预算约束时返回可继续的游标。
 *
 * @param root - 业务仓库根目录。
 * @param request - 当前能力的请求；除入口解析函数外应已通过协议校验。
 * @returns 指定深度的结果页或正文片段，未读完时附带 cursor。
 * @throws 输入、游标或读取前置条件不满足时抛出 RuntimeFault，由请求入口转换为 failed 响应。
 * @remarks 调用阶段：知识检查、渐进读取、增量分析或候选验证；本函数不写入正式知识。
 */
export async function frontierQuery(root: string, request: RuntimeRequest): Promise<RuntimeResponse> {
  // 当前能力已解析的业务参数。
  const input = request.input as FrontierQueryInput
  input.selectors?.codePaths?.forEach(assertSourcePattern)
  // 本次调用读取的知识快照，后续判断都以它为依据。
  const graph = await loadKnowledge(root, undefined, { sourcePolicy: 'formal-only' })
  requireFormalReady(graph)
  // 当前 Context 文件树的精确指纹，用于快照和游标绑定。
  const contextFingerprint = graph.contextFingerprint as string
  // 当前查询额外依赖的来源状态指纹。
  const stateFingerprint = contextFingerprint
  // 明确允许返回正文的文档 ID，防止闭包自动扩大正文读取。
  const explicitBodyIds = new Set(input.selectors?.documentIds ?? [])
  // 按查询顺序排列、尚待预算分页的结果流。
  const items: readonly FrontierItem[] = frontierCandidates(graph, input).map(({ document, reasons }) => ({
    metadata: documentMetadata(document, reasons),
    ...(input.depth === 3 && explicitBodyIds.has(document.id) ? { body: document.body } : {}),
  }))
  // 校验后的续读位置，首次调用从零开始。
  const position = decodeCursor(request.cursor, request.capability, request.input, contextFingerprint, stateFingerprint)
  if (position.itemOffset > items.length || (position.itemOffset === items.length && request.cursor !== undefined))
    throw new RuntimeFault('CURSOR_INVALID', 'The continuation cursor points beyond the current result stream.')
  /** 将本次查询快照与下一读取位置绑定为续读游标。 */
  const cursorFor = (next: CursorPosition): string => encodeCursor(
    request.capability,
    request.input,
    contextFingerprint,
    stateFingerprint,
    next,
  )
  /** 构造当前结果页的完整响应，供预算计算与最终返回共用。 */
  const response = (pageItems: readonly JsonObject[], cursor?: string): RuntimeResponse => runtimeResponse(
    'frontier.query',
    cursor === undefined ? 'success' : 'incomplete',
    {
      data: { contextFingerprint, items: [...pageItems] },
      ...(cursor === undefined ? {} : { cursor }),
    },
  )
  if (items.length === 0)
    return response([])

  // 游标指向的元数据或正文条目。
  const current = items[position.itemOffset] as FrontierItem
  if (current.body !== undefined) {
    // 当前正文续读的起始 UTF-8 字节偏移。
    const startByte = position.bodyByteOffset ?? 0
    // 本次累计读取或完整正文占用的 UTF-8 字节数量。
    const totalBytes = Buffer.byteLength(current.body, 'utf8')
    /** 根据正文字节进度生成续读游标，正文结束后推进到下一条。 */
    const continuation = (endByte: number): string | undefined => {
      if (endByte < totalBytes)
        return cursorFor({ itemOffset: position.itemOffset, bodyByteOffset: endByte })
      return position.itemOffset + 1 < items.length ? cursorFor({ itemOffset: position.itemOffset + 1 }) : undefined
    }
    // 当前读取或输出的字节、正文片段。
    const chunk = fitBodyChunk(
      current.body,
      startByte,
      resolvedBudget(request),
      (candidate, cursor) => response([{ ...current.metadata, body: candidate }], cursor),
      continuation,
    )
    return response([{ ...current.metadata, body: chunk }], continuation(chunk.endByte))
  }
  if (position.bodyByteOffset !== undefined)
    throw new RuntimeFault('CURSOR_INVALID', 'The continuation cursor points inside an item without a body.')

  // 元数据页使用统一分页器；单条无法放入调用预算时返回 BUDGET_TOO_SMALL，避免生成不能推进的游标。
  // 遇到正文条目即停止本次元数据分页，正文由前面的分块分支处理。
  const nextBody = items.findIndex((item, index) => index >= position.itemOffset && item.body !== undefined)
  // 当前连续元数据页可处理的结束位置。
  const runEnd = nextBody === -1 ? items.length : nextBody
  // 应用响应预算后选出的当前结果页。
  const page = paginate(
    items.slice(position.itemOffset, runEnd).map(item => item.metadata),
    { itemOffset: 0 },
    resolvedBudget(request),
    {
      response,
      /** 把当前元数据切片的页内位置换算为完整结果流位置，再绑定查询快照。 */
      cursor: next => cursorFor({ itemOffset: position.itemOffset + next.itemOffset }),
    },
  )
  // 当前结果流已经消费的条目数量。
  const consumed = position.itemOffset + page.items.length
  // 下一页的续读令牌；缺省表示当前结果已读完。
  const cursor = consumed < items.length ? cursorFor({ itemOffset: consumed }) : undefined
  return response(page.items, cursor)
}

/**
 * 严格验证正式结构、记录存储和源码可读性；确认匹配由独立能力报告。
 *
 * @param root - 业务仓库根目录。
 * @returns 验证响应；结构、记录或证据损坏使用 failed，成功不代表确认匹配。
 * @throws 结构或证据问题通过 failed 响应返回；未分类读取异常继续传播。
 * @remarks 调用阶段：知识检查、渐进读取、增量分析或候选验证；本函数不写入正式知识。
 */
export async function graphValidate(root: string): Promise<RuntimeResponse> {
  // 本次调用读取的知识快照，后续判断都以它为依据。
  const graph = await loadKnowledge(root, undefined, { sourcePolicy: 'all-strict' })
  if (graph.formalState !== 'ready' || graph.sourceState !== 'ready') {
    // 即将公开的安全诊断集合。
    const diagnostics = [...issueDiagnostics(graph, true)]
    return runtimeResponse('graph.validate', 'failed', { diagnostics: diagnostics.length === 0
      ? [diagnostic('CONTEXT_NOT_READY', 'Formal Context is absent or invalid.', 'error', 'context')]
      : diagnostics })
  }
  await readConfirmationStore(root, FORMAT)
  return runtimeResponse('graph.validate', 'success', {
    data: {
      contextFingerprint: graph.contextFingerprint as string,
      domainCount: graph.domains.size,
      documentCount: graph.documents.size,
      relationCount: graph.relationCount,
      sourceDeclarationCount: graph.sourceDeclarationCount,
    },
  })
}

/** 计算当前规模相对基线的差值；缺失基线按零处理。 */
function subtract(current: Metrics, baseline: Metrics | undefined): JsonObject {
  return {
    documentCount: current.documentCount - (baseline?.documentCount ?? 0),
    frontMatterBytes: current.frontMatterBytes - (baseline?.frontMatterBytes ?? 0),
    bodyBytes: current.bodyBytes - (baseline?.bodyBytes ?? 0),
    estimatedTokens: current.estimatedTokens - (baseline?.estimatedTokens ?? 0),
  }
}

/** 从重复内容、领域规模和关系分布中提取待人工评估的收敛候选。 */
function growthCandidates(graph: KnowledgeGraph): readonly JsonObject[] {
  // 根据当前条件选出的业务候选集合。
  const candidates: JsonObject[] = []
  // 按种类和正文指纹归组的潜在重复文档。
  const duplicates = new Map<string, string[]>()
  for (const document of graph.documents.values()) {
    // 由文档种类与正文指纹组成的重复内容分组键。
    const key = `${document.kind}:${bodyFingerprint(document)}`
    // 当前选择或授权涉及的稳定身份集合。
    const ids = duplicates.get(key) ?? []
    ids.push(document.id)
    duplicates.set(key, ids)
  }
  for (const ids of duplicates.values()) {
    if (ids.length > 1)
      candidates.push({ kind: 'duplicate', documentIds: ids.sort(compareCodeUnits), reasons: ['same kind and identical normalized body'] })
  }
  for (const [domainId, domain] of graph.domains) {
    // 领域中规模较小、可评估是否合并的文档集合。
    const small = domain.documentIds.filter(id => (graph.documents.get(id)?.bodyBytes ?? 0) < 256)
    if (small.length >= 3)
      candidates.push({ kind: 'fragmented', documentIds: small.sort(compareCodeUnits), reasons: [`${domainId} contains at least three bodies below 256 bytes`] })
    if (domain.documentIds.length >= 4 && domain.documentIds.length * 2 > graph.documents.size)
      candidates.push({ kind: 'concentrated', documentIds: [...domain.documentIds], reasons: [`${domainId} owns more than half of all Documents`] })
  }
  for (const document of graph.documents.values()) {
    // 其他文档指向当前文档的关系数量。
    const incoming = [...graph.documents.values()].some(candidate => candidate.relations.requires.includes(document.id) || candidate.relations.related.includes(document.id))
    // 当前文档向外声明的关系数量。
    const outgoing = document.relations.requires.length + document.relations.related.length
    if (document.kind !== 'domain' && !incoming && outgoing === 0 && document.codePaths.length === 0)
      candidates.push({ kind: 'orphaned', documentIds: [document.id], reasons: ['no code paths or current requires/related edges'] })
  }
  return candidates.sort((left, right) => compareCodeUnits(compactJson(left), compactJson(right)))
}

/**
 * 计算知识增长统计和 Prune 候选，不直接修改知识。
 *
 * @param root - 业务仓库根目录。
 * @param request - 当前能力的请求；除入口解析函数外应已通过协议校验。
 * @returns 当前规模、基线差值与收敛候选页，不代表已批准删除。
 * @throws 输入、游标或读取前置条件不满足时抛出 RuntimeFault，由请求入口转换为 failed 响应。
 * @remarks 调用阶段：知识检查、渐进读取、增量分析或候选验证；本函数不写入正式知识。
 */
export async function growthMeasure(root: string, request: RuntimeRequest): Promise<RuntimeResponse> {
  // 本次调用读取的知识快照，后续判断都以它为依据。
  const graph = await loadKnowledge(root, undefined, { sourcePolicy: 'formal-only' })
  requireFormalReady(graph)
  // 当前知识集合的规模统计。
  const metrics = graphMetrics(graph)
  // 账本保存的对应源码或规模基线。
  const baseline = graph.metadata?.convergence
  // 按固定分区和业务顺序组织的分页结果流。
  const stream: JsonObject[] = []
  for (const [id, current] of Object.entries(metrics.perDomain).sort(([left], [right]) => compareCodeUnits(left, right))) {
    // 当前领域上次收敛时的规模统计。
    const domainBaseline = baseline?.perDomain[id]
    stream.push({ section: 'domain', value: {
      id,
      current: { ...current },
      ...(domainBaseline === undefined ? {} : { baseline: { ...domainBaseline } }),
      delta: subtract(current, domainBaseline),
    } })
  }
  growthCandidates(graph).forEach(value => stream.push({ section: 'candidate', value }))
  // 当前 Context 文件树的精确指纹，用于快照和游标绑定。
  const contextFingerprint = graph.contextFingerprint as string
  // 当前查询额外依赖的来源状态指纹。
  const stateFingerprint = contextFingerprint
  // 校验后的续读位置，首次调用从零开始。
  const position = decodeCursor(request.cursor, request.capability, request.input, contextFingerprint, stateFingerprint)
  /** 将本次查询快照与下一读取位置绑定为续读游标。 */
  const cursorFor = (next: CursorPosition): string => encodeCursor(request.capability, request.input, contextFingerprint, stateFingerprint, next)
  /** 构造当前结果页的完整响应，供预算计算与最终返回共用。 */
  const response = (pageItems: readonly JsonObject[], cursor?: string): RuntimeResponse => runtimeResponse(
    'growth.measure',
    cursor === undefined ? 'success' : 'incomplete',
    {
      data: {
        current: { ...metrics.current },
        ...(baseline === undefined ? {} : { baseline: { ...baseline, perDomain: Object.fromEntries(Object.entries(baseline.perDomain)) as unknown as JsonValue } }),
        delta: subtract(metrics.current, baseline),
        perDomain: pageItems.filter(item => item.section === 'domain').map(item => item.value as JsonValue),
        candidates: pageItems.filter(item => item.section === 'candidate').map(item => item.value as JsonValue),
      },
      ...(cursor === undefined ? {} : { cursor }),
    },
  )
  // 应用响应预算后选出的当前结果页。
  const page = paginate(stream, position, resolvedBudget(request), { response, cursor: cursorFor })
  // 下一页的续读令牌；缺省表示当前结果已读完。
  const cursor = page.nextPosition === undefined ? undefined : cursorFor(page.nextPosition)
  return response(page.items, cursor)
}

/** 统一 Unicode、大小写和空白，使反馈身份不受表面文本差异影响。 */
function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** 将规范化文本拆为去重检索词。 */
function terms(value: string): ReadonlySet<string> {
  return new Set(normalize(value).match(/[\p{L}\p{N}]+/gu) ?? [])
}

/** 临时反馈的匹配字段与证据正文。 */
interface FeedbackFields {
  /** 反馈可复用时适用的情境。 */
  readonly context: string
  /** 已观察到的具体行为，用于反馈身份和匹配。 */
  readonly observedBehavior: string
  /** 行为结果或可复用的修正方式。 */
  readonly outcomeOrCorrection: string
  /** 支撑反馈或审查结论的证据文本，不参与反馈身份哈希。 */
  readonly evidence: string
  /** 反馈可以再次适用的边界。 */
  readonly reuseBoundary: string
}

// 临时反馈 Markdown 必须按顺序出现的固定标题。
const FEEDBACK_HEADINGS = ['Context', 'Observed behavior', 'Outcome or correction', 'Evidence', 'Reuse boundary'] as const
// 反馈文件的可读短名与身份哈希命名规则。
const FEEDBACK_FILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{8}\.md$/

/** 按固定标题解析反馈 Markdown，拒绝不完整或不合法的结构。 */
function feedbackSections(source: string): FeedbackFields | undefined {
  // 完成大小写、空白或正文规则处理的规范化内容。
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  // 按固定反馈标题分组的正文行集合。
  const bodies: string[][] = FEEDBACK_HEADINGS.map(() => [])
  // 当前已进入的反馈标题序号。
  let heading = -1
  for (const line of normalized.split('\n')) {
    if (line.startsWith('# ')) {
      // 当前行应匹配的固定反馈标题。
      const expected = FEEDBACK_HEADINGS[heading + 1]
      if (expected === undefined || line !== `# ${expected}`)
        return undefined
      heading += 1
      continue
    }
    if (heading < 0) {
      if (line.trim().length > 0)
        return undefined
      continue
    }
    ;(bodies[heading] as string[]).push(line)
  }
  if (heading !== FEEDBACK_HEADINGS.length - 1 || bodies.some(lines => lines.join('\n').trim().length === 0))
    return undefined
  return {
    context: (bodies[0] as string[]).join('\n').trim(),
    observedBehavior: (bodies[1] as string[]).join('\n').trim(),
    outcomeOrCorrection: (bodies[2] as string[]).join('\n').trim(),
    evidence: (bodies[3] as string[]).join('\n').trim(),
    reuseBoundary: (bodies[4] as string[]).join('\n').trim(),
  }
}

/** 从四个匹配字段计算反馈身份，不把证据正文纳入身份。 */
function feedbackIdentity(fields: Omit<FeedbackFields, 'evidence'>): JsonObject {
  return {
    context: normalize(fields.context),
    observedBehavior: normalize(fields.observedBehavior),
    outcomeOrCorrection: normalize(fields.outcomeOrCorrection),
    reuseBoundary: normalize(fields.reuseBoundary),
  }
}

/** 为反馈身份提取稳定 ASCII 短名，不承载唯一性保证。 */
function asciiSlug(fields: Pick<FeedbackFields, 'context' | 'observedBehavior'>): string {
  // 完成大小写、空白或正文规则处理的规范化内容。
  const normalized = normalize(`${fields.context} ${fields.observedBehavior}`)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
  // 从规范文本提取的 ASCII 单词或匹配结果。
  const found = normalized.match(/[a-z0-9]+/g) ?? []
  // 不含唯一性信息的可读 ASCII 短名。
  const slug = found.slice(0, 4).join('-').slice(0, 48).replace(/-+$/g, '')
  return slug.length === 0 ? 'feedback' : slug
}

/** 组合可读短名与身份哈希，生成稳定的反馈叶子名。 */
function suggestedFeedbackId(fields: Omit<FeedbackFields, 'evidence'>): string {
  return `${asciiSlug(fields)}-${sha256(compactJson(feedbackIdentity(fields))).slice(0, 8)}`
}

/** 可参与匹配的临时反馈或正式 Reflection 来源。 */
interface MatchSource {
  /** 用于选择合法分支的种类判别值。 */
  readonly kind: 'feedback' | 'reflection'
  /** 当前对象的稳定 ID。 */
  readonly id: string
  /** 仓库相对路径；正式知识诊断统一使用 context/ 前缀。 */
  readonly path: string
  /** 当前条目或片段的文本内容。 */
  readonly text: string
}

/** 读取反馈与 Reflection 的匹配投影，并计算本次来源快照指纹。 */
async function matchSources(root: string, graph: KnowledgeGraph): Promise<{
  /** 按文档归属组织的当前源码文件集合。 */
  readonly sources: readonly MatchSource[]
  /** 所描述数据集的确定性 SHA-256 指纹。 */
  readonly fingerprint: string
}> {
  // 按文档或来源组织的当前证据集合。
  const sources: MatchSource[] = []
  // 用于绑定反馈来源快照的文件路径和内容哈希集合。
  const feedbackFacts: JsonObject[] = []
  if (await pathExists(root, FEEDBACK_ROOT)) {
    for (const entry of await readDirectory(root, FEEDBACK_ROOT)) {
      if (entry.kind !== 'file' || !FEEDBACK_FILE_NAME.test(entry.name))
        throw new RuntimeFault('FEEDBACK_FILE_INVALID', 'Feedback storage contains an invalid entry.', FEEDBACK_ROOT)
      // 当前证据或反馈文件的仓库相对路径。
      const sourcePath = `${FEEDBACK_ROOT}/${entry.name}`
      // 本次读取或编码的原始字节序列。
      const bytes = await readRegularBytes(root, sourcePath, MAX_JSON_TEXT_BYTES)
      // 当前安全读取或待生成的资源文本。
      const source = decodeUtf8(bytes, sourcePath)
      // 当前协议对象需要校验的业务字段集合。
      const fields = feedbackSections(source)
      if (fields === undefined)
        throw new RuntimeFault('FEEDBACK_FORMAT_INVALID', 'Feedback Markdown does not use the fixed short structure.', FEEDBACK_ROOT)
      // 由反馈字段计算的合法文件身份，用于校验文件名。
      const expected = suggestedFeedbackId(fields)
      if (entry.name !== `${expected}.md`)
        throw new RuntimeFault('FEEDBACK_IDENTITY_INVALID', 'Feedback filename does not match its normalized identity.', FEEDBACK_ROOT)
      sources.push({ kind: 'feedback', id: expected, path: sourcePath, text: Object.values(fields).join('\n') })
      feedbackFacts.push({ path: sourcePath, hash: sha256(bytes) })
    }
  }
  for (const document of graph.documents.values()) {
    if (document.kind === 'reflection')
      sources.push({ kind: 'reflection', id: document.id, path: document.path, text: `${document.description}\n${document.body}` })
  }
  return {
    sources: sources.sort((left, right) => compareCodeUnits(`${left.kind}\0${left.id}`, `${right.kind}\0${right.id}`)),
    fingerprint: sha256(compactJson(feedbackFacts.sort((left, right) => compareCodeUnits(String(left.path), String(right.path))))),
  }
}

/**
 * 匹配可复用反馈，返回分页结果和建议身份，不创建任何文件。
 *
 * @param root - 业务仓库根目录。
 * @param request - 当前能力的请求；除入口解析函数外应已通过协议校验。
 * @returns 匹配结果页与建议反馈身份，不创建反馈文件。
 * @throws 输入、游标或读取前置条件不满足时抛出 RuntimeFault，由请求入口转换为 failed 响应。
 * @remarks 调用阶段：知识检查、渐进读取、增量分析或候选验证；本函数不写入正式知识。
 */
export async function feedbackMatch(root: string, request: RuntimeRequest): Promise<RuntimeResponse> {
  // 当前能力已解析的业务参数。
  const input = request.input as FeedbackMatchInput
  // 本次调用读取的知识快照，后续判断都以它为依据。
  const graph = await loadKnowledge(root, undefined, { sourcePolicy: 'formal-only' })
  if (graph.formalState === 'invalid')
    requireFormalReady(graph)
  // 用于复用匹配的四个反馈字段拼接文本。
  const queryText = `${input.context}\n${input.observedBehavior}\n${input.outcomeOrCorrection}\n${input.reuseBoundary}`
  // 当前反馈查询的规范化检索词集合。
  const queryTerms = terms(queryText)
  // 可参与匹配的来源集合及其快照指纹。
  const matched = await matchSources(root, graph)
  // 当前模式或查询实际命中的结果集合。
  const matches = matched.sources.flatMap((source): JsonObject[] => {
    // 当前来源与查询共有的检索词集合。
    const overlap = [...terms(source.text)].filter(term => queryTerms.has(term)).sort(compareCodeUnits)
    if (overlap.length === 0)
      return []
    return [{ kind: source.kind, id: source.id, path: source.path, reasons: overlap.slice(0, 12).map(term => `shared term: ${term}`) }]
  })
  // 根据反馈身份生成的建议叶子名。
  const suggestedId = suggestedFeedbackId({
    context: input.context,
    observedBehavior: input.observedBehavior,
    outcomeOrCorrection: input.outcomeOrCorrection,
    reuseBoundary: input.reuseBoundary,
  })
  // 当前 Context 文件树的精确指纹，用于快照和游标绑定。
  const contextFingerprint = graph.contextFingerprint ?? 'formal:absent'
  // 当前查询额外依赖的来源状态指纹。
  const stateFingerprint = matched.fingerprint
  // 校验后的续读位置，首次调用从零开始。
  const position = decodeCursor(request.cursor, request.capability, request.input, contextFingerprint, stateFingerprint)
  /** 将本次查询快照与下一读取位置绑定为续读游标。 */
  const cursorFor = (next: CursorPosition): string => encodeCursor(request.capability, request.input, contextFingerprint, stateFingerprint, next)
  /** 构造当前结果页的完整响应，供预算计算与最终返回共用。 */
  const response = (pageItems: readonly JsonObject[], cursor?: string): RuntimeResponse => runtimeResponse(
    'feedback.match',
    cursor === undefined ? 'success' : 'incomplete',
    {
      data: { suggestedId, matches: [...pageItems] },
      ...(cursor === undefined ? {} : { cursor }),
    },
  )
  // 应用响应预算后选出的当前结果页。
  const page = paginate(matches, position, resolvedBudget(request), { response, cursor: cursorFor })
  // 下一页的续读令牌；缺省表示当前结果已读完。
  const cursor = page.nextPosition === undefined ? undefined : cursorFor(page.nextPosition)
  return response(page.items, cursor)
}
