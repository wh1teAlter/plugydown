import type { Meta } from './document.js'
import type { KnowledgeGraph } from './graph.js'
import type { JsonObject } from './stable-json.js'
import { bodyFingerprint, frontMatterFingerprint, META_SCHEMA } from './document.js'
import { sha256 } from './protocol.js'
import { compactJson, compareCodeUnits } from './stable-json.js'

/** 一次账本字段修复的旧值与新值；不承载任意字段写入权限。 */
export interface RepairField extends JsonObject {
  /** 获准修复的账本字段名。 */
  field: 'bodyFingerprint' | 'frontMatterFingerprint' | 'reviewRequired'
  /** 修复前的字段值；null 表示该字段原先不存在。 */
  before: string | true | null
  /** Runtime 推导的修复后字段值。 */
  after: string | true
}

/** 按文档组织的修复预览项，标明该文档是否处于调用方选择的范围。 */
export interface RepairItem extends JsonObject {
  /** 当前条目所属的稳定文档 ID。 */
  documentId: string
  /** 该修复项是否处于调用方显式选择的文档范围。 */
  selected: boolean
  /** 该文档实际需要变更的字段集合。 */
  fields: RepairField[]
}

/**
 * 根据完整内部诊断判断是否仅存在可修复的内容指纹失配，并拒绝冲突标记。
 *
 * @param graph - 当前正式或候选知识快照。
 * @returns 格式有效、仅存在内容指纹失配或已完全一致，且没有冲突标记时返回 true。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：修复预览或 Repair 候选验证；只推导数据，实际写入由事务层负责。
 */
export function repairEligible(graph: KnowledgeGraph): boolean {
  return graph.metaState === 'valid' && graph.contextFingerprint !== undefined
    && graph.issues.every(problem => problem.code === 'META_DOCUMENT_FINGERPRINT_MISMATCH')
    && ![...graph.documents.values()].some(document => /^(?:<{7}|>{7}|\|{7})(?: |$)/m.test(document.body))
}

/**
 * 计算确定性的字段修复计划，包含范围外失配项以暴露授权缺口。
 *
 * @param graph - 当前正式或候选知识快照。
 * @param selectedIds - 本次显式选择的文档 ID。
 * @returns 带字段旧新值、范围标志、数量与 planFingerprint 的完整确定性计划。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：修复预览或 Repair 候选验证；只推导数据，实际写入由事务层负责。
 */
export function repairPlan(graph: KnowledgeGraph, selectedIds?: readonly string[]) {
  // 当前完整内部状态是否满足受限内容修复条件。
  const eligible = repairEligible(graph)
  // 调用方显式选中的文档 ID 集合，不自动扩大授权。
  const selected = selectedIds === undefined ? undefined : new Set(selectedIds)
  // 按文档 ID 排序的字段修复计划，包含范围外失配项。
  const items: RepairItem[] = []
  if (eligible) {
    for (const [id, document] of [...graph.documents].sort(([left], [right]) => compareCodeUnits(left, right))) {
      // 持久账本保存的上次审查或内容一致性记录。
      const recorded = graph.meta?.documents[id]
      if (recorded === undefined)
        continue
      // 当前文档真正需要改变的内容指纹或待复核标记。
      const fields: RepairField[] = []
      // 按现有算法重新计算的正文和 front matter 内容指纹。
      const current = { bodyFingerprint: bodyFingerprint(document), frontMatterFingerprint: frontMatterFingerprint(document) }
      for (const field of ['bodyFingerprint', 'frontMatterFingerprint'] as const) {
        if (recorded[field] !== current[field])
          fields.push({ field, before: recorded[field], after: current[field] })
      }
      if (fields.length === 0)
        continue
      if (recorded.reviewRequired !== true)
        fields.push({ field: 'reviewRequired', before: null, after: true })
      items.push({ documentId: id, selected: selected?.has(id) ?? true, fields })
    }
  }
  // 本次范围内真正需要修复的文档数量。
  const selectedDocumentCount = items.filter(item => item.selected).length
  // 修复资格、选中数量、范围缺口和格式迁移标志。
  const summary = {
    eligible,
    documentCount: items.length,
    selectedDocumentCount,
    remainingDocumentCount: items.length - selectedDocumentCount,
    schemaMigrationRequired: selectedDocumentCount > 0 && graph.meta?.schema !== META_SCHEMA,
  }
  return { ...summary, planFingerprint: sha256(compactJson({ ...summary, items })), items }
}

/**
 * 根据已授权文档推导修复账本，保留源码审查依据和所有基线。
 *
 * @param live - 修复前已检查的正式知识快照。
 * @param ids - 已授权并经身份校验的文档 ID 集合。
 * @returns 新账本对象；实际受影响文档被标记 reviewRequired，源码依据与基线保持原值。
 * @throws live.meta 缺失时可能抛出 TypeError；调用方必须预先证明修复资格和完整授权范围。
 * @remarks 调用阶段：修复预览或 Repair 候选验证；只推导数据，实际写入由事务层负责。
 */
export function repairMeta(live: KnowledgeGraph, ids: readonly string[]): Meta {
  // 修复前已通过格式校验的账本，源码依据与基线从中原样保留。
  const original = live.meta as Meta
  // 保留原记录的账本副本，仅替换获准修复文档的必要字段。
  const documents = { ...original.documents }
  // Runtime 推导的完整内容修复计划。
  const plan = repairPlan(live, ids)
  for (const item of plan.items) {
    if (!item.selected)
      continue
    // 本次获准修复的正式文档，用它重新计算两个内容指纹。
    const document = live.documents.get(item.documentId)!
    documents[item.documentId] = {
      ...documents[item.documentId]!,
      bodyFingerprint: bodyFingerprint(document),
      frontMatterFingerprint: frontMatterFingerprint(document),
      reviewRequired: true,
    }
  }
  return { ...original, schema: plan.selectedDocumentCount > 0 ? META_SCHEMA : original.schema, documents }
}
