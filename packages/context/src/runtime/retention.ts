import type { ConfirmationRecord, ConfirmationStore } from './confirmation.js'
import { confirmationKey } from './confirmation.js'
import { FORMAT, RuntimeFault, sha256 } from './protocol.js'
import { compactJson, compareCodeUnits } from './stable-json.js'

// 主线清理后的活跃文档确认上限；不是读取合法性限制。
export const ACTIVE_CONFIRMATION_LIMIT = 10
// 退休身份保留真实记录，使 Git 不把整个旧目录视为已移动。
export const RETIRED_CONFIRMATION_LIMIT = 1
// 自动维护的批量触发阈值，显式 compact 不受此调度阈值限制。
export const RETENTION_TRIGGER = 20

/** 不包含记录正文的有界清理摘要。 */
export interface RetentionSummary {
  /** 清理前的合法记录总数，包含退休身份。 */
  readonly beforeCount: number
  /** 清理后保留的记录总数。 */
  readonly afterCount: number
  /** 计划淘汰的记录数量，不包含新增。 */
  readonly removedCount: number
  /** 有历史记录且当前仍存在的文档身份数量。 */
  readonly activeIdentityCount: number
  /** 有历史记录但当前已不存在的文档身份数量。 */
  readonly retiredIdentityCount: number
  /** 是否建议主线自动任务发起批量清理，而非当前结构是否有效。 */
  readonly triggered: boolean
  /** 绑定完整删除身份集合及保留结果的确定性摘要。 */
  readonly planFingerprint: string
}

/** 仅从原始集合选取的清理结果，不包含新增确认。 */
export interface RetentionPlan {
  /** 按完整 key 保存的原始记录子集。 */
  readonly retained: ReadonlyMap<string, ConfirmationRecord>
  /** 已排序的淘汰身份，供事务登记删除所有权。 */
  readonly removedKeys: readonly string[]
  /** 可公开传输的固定大小摘要。 */
  readonly summary: RetentionSummary
}

/** 为正文和业务元数据组合建立确定性分组键，不涉及历史先后。 */
function contentKey(record: ConfirmationRecord): string {
  return `${record.frontMatterFingerprint}:${record.bodyFingerprint}`
}

/** 对同一输入组合计算清理必须保持的两个确认事实。 */
function matchFacts(records: ReadonlyMap<string, ConfirmationRecord>, current: ConfirmationRecord): string {
  return `${records.has(confirmationKey(FORMAT, current))}:${[...records.values()].some(record => contentKey(record) === contentKey(current))}`
}

/**
 * 从已验证的历史中选择有界记录，保留当前事实并覆盖不同内容版本。
 * @param store - 按 format=1 完整读取且验证过的原始确认集合。
 * @param current - 每个活跃文档的当前完整输入；来源不完整时调用方必须拒绝规划。
 * @returns 保留的原始记录、排序删除身份及有界摘要；不修改输入或文件。
 * @throws 当前事实被计划改变时抛出 RETENTION_FACTS_CHANGED。
 * @remarks 调用阶段：只读预览或集中 compact 事务，不能作为语义确认。
 */
export function planRetention(store: ConfirmationStore, current: ReadonlyMap<string, ConfirmationRecord>): RetentionPlan {
  // 按完整身份聚合保留结果，记录对象来自原始集合。
  const retained = new Map<string, ConfirmationRecord>()
  // 删除集合始终按 key 排序，避免依赖文件枚举或插入顺序。
  const removedKeys: string[] = []
  // 分开报告活跃与退休身份，不把退休记录当作当前文档。
  let activeIdentityCount = 0
  // 保留目录的退休身份数量，同时决定单条锚点的空间成本。
  let retiredIdentityCount = 0
  // 调度建议不参与读取合法性，也不会在此函数内执行清理。
  let triggered = false
  for (const [documentId, records] of [...store.records].sort(([left], [right]) => compareCodeUnits(left, right))) {
    if (records.size === 0)
      continue
    // 当前输入只来自实际活跃文档；缺省表示已退休身份。
    const input = current.get(documentId)
    // 不同生命周期的身份采用不同上限。
    const limit = input === undefined ? RETIRED_CONFIRMATION_LIMIT : ACTIVE_CONFIRMATION_LIMIT
    // 固定选择顺序，不能将 hash 排序描述为时间排序。
    const sorted = [...records].sort(([left], [right]) => compareCodeUnits(left, right))
    // 此身份最终保留的原始记录。
    const selected = new Map<string, ConfirmationRecord>()
    if (input === undefined)
      retiredIdentityCount += 1
    else
      activeIdentityCount += 1
    triggered ||= records.size > RETENTION_TRIGGER
    if (records.size > limit && input !== undefined) {
      // 当前完整确认优先；源漂移时至少保护相同正文及元数据的证据。
      const exactKey = confirmationKey(FORMAT, input)
      // 必须保护的当前证据；缺少精确匹配时只保护已知内容，不伪造来源。
      const protectedEntry = sorted.find(([key]) => key === exactKey)
        ?? sorted.find(([, record]) => contentKey(record) === contentKey(input))
      if (protectedEntry !== undefined)
        selected.set(...protectedEntry)
      // 每种内容先分配一个名额，同组代表按完整 key 确定。
      const groups = new Map<string, [string, ConfirmationRecord]>()
      for (const entry of sorted) {
        if (!groups.has(contentKey(entry[1])))
          groups.set(contentKey(entry[1]), entry)
      }
      // 已分配名额的内容版本，避免同一正文挤占全部历史名额。
      const covered = new Set([...selected.values()].map(contentKey))
      for (const [content, entry] of [...groups].sort(([left], [right]) => compareCodeUnits(left, right))) {
        if (selected.size < limit && !covered.has(content)) {
          selected.set(...entry)
          covered.add(content)
        }
      }
    }
    for (const [key, record] of sorted) {
      if (selected.size < limit)
        selected.set(key, record)
    }
    if (input !== undefined && matchFacts(records, input) !== matchFacts(selected, input))
      throw new RuntimeFault('RETENTION_FACTS_CHANGED', 'Retention must preserve current confirmation facts.')
    for (const [key, record] of sorted) {
      if (selected.has(key))
        retained.set(key, record)
      else
        removedKeys.push(key)
    }
  }
  removedKeys.sort(compareCodeUnits)
  return {
    retained,
    removedKeys,
    summary: {
      beforeCount: store.count,
      afterCount: retained.size,
      removedCount: removedKeys.length,
      activeIdentityCount,
      retiredIdentityCount,
      triggered,
      planFingerprint: sha256(compactJson({ retained: [...retained.keys()].sort(compareCodeUnits), removed: removedKeys })),
    },
  }
}
