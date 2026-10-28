import type { CursorPosition, DeltaComputeInput, RuntimeRequest, RuntimeResponse } from './protocol.js'
import type { JsonObject, JsonValue } from './stable-json.js'
import { checkConfirmations, selectDocumentIds } from './confirmation.js'
import { loadKnowledge, requiresClosure } from './graph.js'
import { decodeCursor, encodeCursor, paginate, resolvedBudget, RuntimeFault, runtimeResponse, sha256 } from './protocol.js'
import { assertSafeRelativePath, assertSourcePattern, declarationMatches, readGitEvidence } from './repository.js'
import { compactJson, compareCodeUnits } from './stable-json.js'

/** 分区结果共用单个游标与预算，不把阅读依赖当作更新授权。 */
interface SectionItem extends JsonObject {
  section: 'confirmationMismatches' | 'changedPaths' | 'sourceAffected' | 'requiredContext' | 'outOfScopeAffected'
  value: JsonValue
}

/**
 * 结合当前确认事实和显式 Git 差异，生成限定范围的维护线索。
 * @param root - 业务仓库根目录。
 * @param request - 已经通过协议解析的请求。
 * @returns 完整快照绑定的分页结果；历史未提供时明确声明覆盖限制。
 * @throws 非法结构、范围、记录或变化的快照使调用失败。
 * @remarks 只读调用；不推进基线、不决定语义审查深度、不扩大写范围。
 */
export async function deltaCompute(root: string, request: RuntimeRequest): Promise<RuntimeResponse> {
  // 当前能力经过解析的输入，不在 await 后重新读取宿主对象。
  const input = request.input as DeltaComputeInput
  assertSafeRelativePath(input.gitEvidencePath)
  if (input.scope.kind === 'paths')
    input.scope.paths.forEach(assertSourcePattern)
  // 本次读取的知识快照，后续判断以该快照为准。
  const graph = await loadKnowledge(root, undefined, { sourcePolicy: input.scope.kind === 'paths' ? 'all-tolerant' : 'formal-only' })
  if (graph.formalState !== 'ready') {
    // 用于返回稳定、具体错误的首个诊断。
    const first = graph.issues[0]
    throw new RuntimeFault(first?.code ?? 'CONTEXT_NOT_READY', first?.message ?? 'Delta requires valid Context.', first?.path)
  }
  // 宿主提供的固定 Git 原始证据，不由 Runtime 执行 Git。
  const evidence = await readGitEvidence(root, input.gitEvidencePath)
  // 声明、当前文件与显式变更路径共同提供的归属线索。
  const paths = [...new Set(evidence.changes.flatMap(change => [change.path, ...(change.previousPath === undefined ? [] : [change.previousPath])]))].sort(compareCodeUnits)
  // 固定排序的本次检查文档集合。
  const selected = selectDocumentIds(graph, input.scope, paths)
  // 经过两轮读取核对的确认与来源事实。
  const snapshot = await checkConfirmations(root, selected)
  // 再次核对路径展开，拒绝选定期间出现或消失的文件。
  const selectionCheck = input.scope.kind === 'paths' ? await loadKnowledge(root, undefined, { sourcePolicy: 'all-tolerant' }) : undefined
  if (selectionCheck !== undefined && (selectionCheck.contextFingerprint !== graph.contextFingerprint || selectionCheck.sourceFingerprint !== graph.sourceFingerprint))
    throw new RuntimeFault('CHECK_SNAPSHOT_CHANGED', 'Sources changed while resolving Delta scope.')
  if (snapshot.graph.contextFingerprint !== graph.contextFingerprint)
    throw new RuntimeFault('CHECK_SNAPSHOT_CHANGED', 'Context changed while selecting Delta scope.')
  // 由显式 Git 变更匹配声明得到的文档线索。
  const affected = [...graph.documents.values()].flatMap((document) => {
    // 该文档声明实际匹配的变更路径。
    const changedPaths = paths.filter(candidate => document.codePaths.some(pattern => declarationMatches(pattern, candidate)))
    return changedPaths.length === 0 ? [] : [{ documentId: document.id, changedPaths }]
  })
  // 快速判定结果是否属于请求范围，不扩大授权。
  const selectedSet = new Set(selected)
  // 本次选定输入中未匹配的文档，不是持久待审队列。
  const mismatches = snapshot.items.filter(item => item.confirmationState !== 'matched')
  // 仅供阅读的 requires 前置闭包，不授予写入权限。
  const required = requiresClosure(graph, [...new Set([...mismatches.map(item => item.documentId), ...affected.filter(item => selectedSet.has(item.documentId)).map(item => item.documentId)])])
  // 按稳定顺序排列的完整分页条目集合。
  const stream: SectionItem[] = [
    ...mismatches.map(item => ({ section: 'confirmationMismatches' as const, value: { ...item, reasons: [...item.reasons] } })),
    ...evidence.changes.map(change => ({ section: 'changedPaths' as const, value: { ...change } })),
    ...affected.filter(item => selectedSet.has(item.documentId)).map(item => ({ section: 'sourceAffected' as const, value: item })),
    ...required.map(item => ({ section: 'requiredContext' as const, value: { documentId: item.id } })),
    ...affected.filter(item => !selectedSet.has(item.documentId)).map(item => ({ section: 'outOfScopeAffected' as const, value: item })),
  ]
  // 最后重读宿主证据，拒绝跨 await 混合 Git 事实。
  if ((await readGitEvidence(root, input.gitEvidencePath)).fingerprint !== evidence.fingerprint)
    throw new RuntimeFault('CHECK_SNAPSHOT_CHANGED', 'Git evidence changed during Delta.')
  // 绑定请求、内容和所读来源的确定性快照身份。
  const fingerprint = sha256(compactJson({ snapshot: snapshot.snapshotFingerprint, gitEvidence: evidence.fingerprint, input: request.input as unknown as JsonValue }))
  // 与本次输入和快照匹配的续读位置。
  const position = decodeCursor(request.cursor, request.capability, request.input, graph.contextFingerprint!, fingerprint)
  // 将下一位置绑定到同一完整快照的续读令牌。
  const cursorFor = (next: CursorPosition): string => encodeCursor(request.capability, request.input, graph.contextFingerprint!, fingerprint, next)
  // 构造同一合同的完整响应，亦供分页预算计算。
  const response = (items: readonly SectionItem[], cursor?: string): RuntimeResponse => {
    // 把统一分页流重新投影到公开结果分区。
    const sections: Record<SectionItem['section'], JsonValue[]> = { confirmationMismatches: [], changedPaths: [], sourceAffected: [], requiredContext: [], outOfScopeAffected: [] }
    for (const item of items) sections[item.section].push(item.value)
    return runtimeResponse('delta.compute', cursor === undefined ? 'success' : 'incomplete', {
      data: { ...sections, scope: { kind: input.scope.kind, requestFingerprint: sha256(compactJson(request.input as unknown as JsonValue)) }, snapshotFingerprint: fingerprint, historyCoverage: evidence.hasDiff ? 'provided' : 'not_provided', gitMidOperation: evidence.midOperation },
      ...(cursor === undefined ? {} : { cursor }),
    })
  }
  // 在响应预算内可公开的当前结果页。
  const page = paginate(stream, position, resolvedBudget(request), { response, cursor: cursorFor })
  return response(page.items, page.nextPosition === undefined ? undefined : cursorFor(page.nextPosition))
}
