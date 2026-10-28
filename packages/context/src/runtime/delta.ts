import type { KnowledgeGraph } from './graph.js'
import type { CursorPosition, DeltaComputeInput, RuntimeRequest, RuntimeResponse, Scope } from './protocol.js'
import type { GitChange } from './repository.js'
import type { JsonObject, JsonValue } from './stable-json.js'
import { impactClosure, loadKnowledge, reviewPendingIds } from './graph.js'
import { decodeCursor, encodeCursor, paginate, resolvedBudget, RuntimeFault, runtimeResponse, sha256 } from './protocol.js'
import { assertGitEvidencePath, assertSourcePattern, declarationMatches, readGitEvidence } from './repository.js'
import { compactJson, compareCodeUnits } from './stable-json.js'

/** 汇总 Git 变更的新旧路径，去重后按码元排序。 */
function changedPaths(changes: readonly GitChange[]): readonly string[] {
  // 本次计算涉及的仓库相对路径集合。
  const paths = new Set<string>()
  for (const change of changes) {
    paths.add(change.path)
    if (change.previousPath !== undefined)
      paths.add(change.previousPath)
  }
  return [...paths].sort(compareCodeUnits)
}

/** 结合源码声明、当前文件和 Git 路径判断文档是否在授权范围内。 */
function scopeContainsDocument(scope: Scope, graph: KnowledgeGraph, documentId: string, gitPaths: readonly string[]): boolean {
  // 当前通过 ID 找到的文档，作为本次判断的依据。
  const document = graph.documents.get(documentId)
  if (document === undefined)
    return false
  if (scope.kind === 'repository')
    return true
  if (scope.kind === 'domains')
    return scope.ids.includes(document.domain)
  if (scope.kind === 'documents')
    return scope.ids.includes(documentId)
  // 当前源码及 Git 变更共同证明的具体文件路径。
  const actualPaths = new Set([
    ...(graph.sources.get(documentId) ?? []).map(file => file.path),
    ...gitPaths.filter(candidate => document.codePaths.some(declaration => declarationMatches(declaration, candidate))),
  ])
  return [...actualPaths].some(candidate => scope.paths.some(pattern => declarationMatches(pattern, candidate)))
}

/** 校验增量分析范围，拒绝未知领域、文档或不安全路径模式。 */
function validateScope(scope: Scope, graph: KnowledgeGraph): void {
  if (scope.kind === 'domains') {
    // 输入中不属于允许身份或字段集合的项。
    const unknown = scope.ids.find(id => !graph.domains.has(id))
    if (unknown !== undefined)
      throw new RuntimeFault('SCOPE_DOMAIN_UNKNOWN', 'Delta scope contains an unknown Domain.')
  }
  else if (scope.kind === 'documents') {
    // 输入中不属于允许身份或字段集合的项。
    const unknown = scope.ids.find(id => !graph.documents.has(id))
    if (unknown !== undefined)
      throw new RuntimeFault('SCOPE_DOCUMENT_UNKNOWN', 'Delta scope contains an unknown Document.')
  }
  else if (scope.kind === 'paths') {
    for (const pattern of scope.paths)
      assertSourcePattern(pattern)
  }
}

/** 增量结果流中的带分区条目，供统一预算分页使用。 */
interface SectionItem extends JsonObject {
  /** 结果所属的协议分区，用于恢复分页后的数据结构。 */
  section: 'changedPaths' | 'directImpact' | 'expandedImpact' | 'unreferencedPaths' | 'brokenEvidence'
  /** 当前结果分区所承载的 JSON 数据。 */
  value: JsonValue
}

/** 将一页结果按协议分区归组，保持本页条目的顺序。 */
function pageData(items: readonly SectionItem[]): {
  /** 本页涉及的 Git 新旧路径或结构化变更条目。 */
  readonly changedPaths: readonly JsonValue[]
  /** 因内容或源码审查状态变化而直接需要维护的文档。 */
  readonly directImpact: readonly JsonValue[]
  /** 经依赖和领域关系展开后的影响文档。 */
  readonly expandedImpact: readonly JsonValue[]
  /** 尚未被任何文档源码声明覆盖的变更路径。 */
  readonly unreferencedPaths: readonly JsonValue[]
  /** 带文档归属的不可用源码证据。 */
  readonly brokenEvidence: readonly JsonValue[]
} {
  // 本次处理累积的结果集合。
  const result: Record<SectionItem['section'], JsonValue[]> = {
    changedPaths: [],
    directImpact: [],
    expandedImpact: [],
    unreferencedPaths: [],
    brokenEvidence: [],
  }
  for (const item of items)
    result[item.section].push(item.value)
  return result
}

/**
 * 根据账本与当前源码生成待审队列、影响闭包和 Light 模式阻塞原因。
 *
 * @param root - 业务仓库根目录。
 * @param request - 当前能力的请求；除入口解析函数外应已通过协议校验。
 * @returns 增量结果页；预算耗尽时附带 cursor，源码缺口保留为结果中的阻塞因素。
 * @throws 输入、游标或读取前置条件不满足时抛出 RuntimeFault，由请求入口转换为 failed 响应。
 * @remarks 调用阶段：知识检查、渐进读取、增量分析或候选验证；本函数不写入正式知识。
 */
export async function deltaCompute(root: string, request: RuntimeRequest): Promise<RuntimeResponse> {
  // 当前能力已解析的业务参数。
  const input = request.input as DeltaComputeInput
  assertGitEvidencePath(input.gitEvidencePath)
  if (input.scope.kind === 'paths')
    input.scope.paths.forEach(assertSourcePattern)
  // 本次调用读取的知识快照，后续判断都以它为依据。
  const graph = await loadKnowledge(root, undefined, { sourcePolicy: 'all-tolerant' })
  if (graph.formalState !== 'ready') {
    // 优先公开或判定的首个问题项。
    const first = graph.issues[0]
    throw new RuntimeFault(first?.code ?? 'CONTEXT_NOT_READY', first?.message ?? 'Delta requires ready formal Context.', first?.path ?? 'context')
  }
  validateScope(input.scope, graph)
  // 当前工作流拥有的宿主 Git 证据叶子或已校验快照。
  const evidence = await readGitEvidence(root, input.gitEvidencePath)
  // 本次计算涉及的仓库相对路径集合。
  const paths = changedPaths(evidence.changes)
  // 待审队列仅由内容和源码指纹决定，即使 squash 导致基线历史丢失也保持完整；变更路径只解释原因，源码不可读同样需要复核。
  const impacted = new Set(reviewPendingIds(graph))
  // 按文档 ID 记录直接影响及其原因的映射。
  const direct = new Map<string, string[]>()
  // 未被任何文档源码声明覆盖的变更路径。
  const unreferenced: string[] = []
  for (const changedPath of paths) {
    if (changedPath.startsWith('context/') || changedPath.startsWith('.scratch/'))
      continue
    // 当前变更路径是否已找到至少一个文档归属。
    let mapped = false
    for (const document of graph.documents.values()) {
      for (const declaration of document.codePaths) {
        if (!declarationMatches(declaration, changedPath))
          continue
        mapped = true
        if (!impacted.has(document.id))
          continue
        // 当前文档进入结果或影响集合的可解释原因。
        const reasons = direct.get(document.id) ?? []
        reasons.push(`code.paths ${declaration} matches ${changedPath}`)
        direct.set(document.id, reasons)
      }
    }
    // 未被文档引用的变更路径只供 Recorder 评估是否补充知识锚点，不阻断 Light 或基线推进。
    if (!mapped)
      unreferenced.push(changedPath)
  }
  for (const id of impacted) {
    // 当前文档进入结果或影响集合的可解释原因。
    const reasons = direct.get(id) ?? []
    if (graph.meta?.documents[id]?.reviewRequired === true)
      reasons.push('content fingerprint repair requires semantic review')
    if (reasons.length === 0)
      reasons.push('cited sources differ from those recorded at the last review')
    direct.set(id, reasons)
  }
  for (const [id, reasons] of direct)
    direct.set(id, [...new Set(reasons)].sort(compareCodeUnits))
  // 从直接影响展开的完整依赖与领域闭包。
  const closure = impactClosure(graph, direct)
  // 待向调用方报告的源码证据缺口。
  const brokenEvidence: JsonValue[] = graph.sourceIssues.map(problem => ({
    documentId: problem.documentId,
    code: problem.code,
    sourcePattern: problem.sourcePattern,
  }))
  // 账本保存的对应源码或规模基线。
  const baseline = graph.meta?.repository?.baseline
  // 缺少 diff.bin 时路径列表仅覆盖工作区；待审队列仍完整，此限制本身不构成阻塞。
  const changedPathsComplete = baseline === undefined || baseline.revision === evidence.currentRevision || evidence.hasDiff

  // 阻止使用 Light 模式的语义或证据条件。
  const blockers: string[] = []
  if (baseline === undefined)
    blockers.push('repository baseline is absent')
  if (!input.taskEvidence.intentKnown)
    blockers.push('task intent is not known')
  if (!input.taskEvidence.scopeComplete)
    blockers.push('task scope is incomplete')
  if (input.taskEvidence.newCapabilitySuspected)
    blockers.push('a new capability is suspected')
  if (input.taskEvidence.crossDomainContractUncertain)
    blockers.push('a cross-Domain contract is uncertain')
  if (evidence.midOperation)
    blockers.push('Git is in a mid-operation state')
  if (brokenEvidence.length > 0)
    blockers.push('evidence is incomplete')
  // 候选中发生修改但没有获得授权的文档 ID。
  const outsideScope = closure.filter(item => !scopeContainsDocument(input.scope, graph, item.documentId, paths))
  if (outsideScope.length > 0)
    blockers.push('impact closure extends outside authorized scope')
  // 去重并稳定排序后的 Light 阻塞原因。
  const uniqueBlockers = [...new Set(blockers)].sort(compareCodeUnits)
  // 这里只判断全仓基线是否具备推进资格；最终仍须由提交证明所有受影响文档已编辑或明确重新确认。
  const baselineEligible = input.scope.kind === 'repository'
    && !evidence.midOperation
    && brokenEvidence.length === 0
    && input.taskEvidence.scopeComplete

  // 按固定分区和业务顺序组织的分页结果流。
  const stream: SectionItem[] = [
    ...evidence.changes.map(change => ({ section: 'changedPaths' as const, value: { ...change } })),
    ...[...direct.entries()].sort(([left], [right]) => compareCodeUnits(left, right)).map(([documentId, reasons]) => ({
      section: 'directImpact' as const,
      value: { documentId, changedPaths: paths.filter(changedPath => reasons.some(reason => reason.endsWith(` ${changedPath}`))), reasons },
    })),
    ...closure.map(item => ({ section: 'expandedImpact' as const, value: { documentId: item.documentId, reasons: [...item.reasons] } })),
    ...unreferenced.sort(compareCodeUnits).map(value => ({ section: 'unreferencedPaths' as const, value })),
    ...brokenEvidence.sort((left, right) => compareCodeUnits(compactJson(left), compactJson(right))).map(value => ({ section: 'brokenEvidence' as const, value })),
  ]
  // 当前 Context 文件树的精确指纹，用于快照和游标绑定。
  const contextFingerprint = graph.contextFingerprint as string
  // 当前查询额外依赖的来源状态指纹。
  const stateFingerprint = sha256(compactJson({
    gitEvidenceFingerprint: evidence.fingerprint,
    sourceFingerprint: graph.sourceFingerprint ?? 'source:unavailable',
    brokenEvidence,
  }))
  // 校验后的续读位置，首次调用从零开始。
  const position = decodeCursor(request.cursor, request.capability, request.input, contextFingerprint, stateFingerprint)
  /** 将本次查询快照与下一读取位置绑定为续读游标。 */
  const cursorFor = (next: CursorPosition): string => encodeCursor(
    request.capability,
    request.input,
    contextFingerprint,
    stateFingerprint,
    next,
  )
  /** 构造当前结果页的完整响应，供预算计算与最终返回共用。 */
  const response = (pageItems: readonly SectionItem[], cursor?: string): RuntimeResponse => {
    // 当前页按协议分区重新组织的增量结果。
    const sections = pageData(pageItems)
    return runtimeResponse('delta.compute', cursor === undefined ? 'success' : 'incomplete', {
      data: {
        ...(baseline === undefined ? {} : { repositoryBaseline: baseline.revision }),
        currentRevision: evidence.currentRevision,
        changedPathsComplete,
        changedPaths: [...sections.changedPaths],
        directImpact: [...sections.directImpact],
        expandedImpact: [...sections.expandedImpact],
        unreferencedPaths: [...sections.unreferencedPaths],
        brokenEvidence: [...sections.brokenEvidence],
        light: { eligible: uniqueBlockers.length === 0, blockers: uniqueBlockers },
        repositoryBaselineEligible: baselineEligible,
      },
      ...(cursor === undefined ? {} : { cursor }),
    })
  }
  // 应用响应预算后选出的当前结果页。
  const page = paginate(stream, position, resolvedBudget(request), { response, cursor: cursorFor })
  // 下一页的续读令牌；缺省表示当前结果已读完。
  const cursor = page.nextPosition === undefined ? undefined : cursorFor(page.nextPosition)
  return response(page.items, cursor)
}
