import type { ConfirmationRecord } from './confirmation.js'
import type { MetadataManifest } from './document.js'
import type { KnowledgeGraph } from './graph.js'
import type { JsonObject, JsonValue } from './stable-json.js'
import { confirmationKey } from './confirmation.js'
import { loadKnowledge } from './graph.js'
import { FORMAT, RuntimeFault, sha256 } from './protocol.js'
import { inspectMetadataLayout } from './repository.js'
import { compactJson, compareCodeUnits } from './stable-json.js'

/** 调用方明确选择的历史证据信任策略。 */
export type MigrationStrategy = 'import-trusted' | 'reconfirm'

/** 一条历史记录的导入或跳过决定，不是本次语义确认。 */
export interface MigrationItem extends JsonObject {
  /** 原始账本对应的稳定文档身份。 */
  documentId: string
  /** 仅决定历史依据是否导入，不授予本次语义批准。 */
  disposition: 'import' | 'skip'
  /** 可供调用方解释导入决定的稳定原因码。 */
  reason: 'LEGACY_EVIDENCE' | 'REVIEW_UNFINISHED' | 'RECONFIRM_REQUESTED'
  /** 导入时的完整内容身份；跳过时省略。 */
  key?: string
}

/** 与原始 Context 快照绑定的只读迁移计划。 */
export interface MigrationPlan {
  /** 所有原始结构问题均可由本次格式转换处理。 */
  readonly eligible: boolean
  /** 原始旧格式结构快照，不读取当前源码。 */
  readonly graph: KnowledgeGraph
  /** 该计划明确使用的历史信任策略。 */
  readonly strategy: MigrationStrategy
  /** 目标格式入口，保留原有基线。 */
  readonly metadata: MetadataManifest
  /** 从原始元组直接转换的不可变记录，以内容 key 索引。 */
  readonly records: ReadonlyMap<string, ConfirmationRecord>
  /** 所有文档的导入或跳过决定，由公开查询分页。 */
  readonly items: readonly MigrationItem[]
  /** 绑定原始快照、策略及完整计划的 SHA-256 摘要。 */
  readonly planFingerprint: string
}

/**
 * 预览旧账本转换，不读取当前源码或重算历史摘要。
 * @param root - 业务仓库根目录。
 * @param strategy - 预览缺省展示可信导入；写事务必须显式选择。
 * @returns 绑定原始快照、策略及逐条决定的计划。
 * @throws 入口不唯一或不是旧格式时抛出 RuntimeFault。
 * @remarks 只读阶段；所有写入由既有事务执行。
 */
export async function planLegacyMigration(root: string, strategy: MigrationStrategy = 'import-trusted'): Promise<MigrationPlan> {
  if (await inspectMetadataLayout(root) !== 'legacy')
    throw new RuntimeFault('MIGRATION_NOT_ELIGIBLE', 'Migration requires a unique legacy metadata entry.')
  // 结构校验不要求当前旧来源仍存在。
  const graph = await loadKnowledge(root, undefined, { legacy: true, sourcePolicy: 'formal-only' })
  // 仅内容摘要失配可迁移；其他结构问题必须先解决。
  const eligible = graph.meta !== undefined && graph.contextFingerprint !== undefined
    && graph.issues.every(item => item.code === 'META_DOCUMENT_FINGERPRINT_MISMATCH')
  // 原有两类基线原样保留，不建立新的全仓批准。
  const metadata: MetadataManifest = {
    format: FORMAT,
    ...(graph.meta?.repository === undefined ? {} : { repository: graph.meta.repository }),
    ...(graph.meta?.convergence === undefined ? {} : { convergence: graph.meta.convergence }),
  }
  // 由完整四字段元组组成的确认集合，无 latest 指针。
  const records = new Map<string, ConfirmationRecord>()
  // 面向调用方的稳定、有序逐文档结果。
  const items: MigrationItem[] = []
  if (eligible) {
    for (const [documentId, ledger] of Object.entries(graph.meta!.documents).sort(([a], [b]) => compareCodeUnits(a, b))) {
      if (ledger.reviewRequired === true || strategy === 'reconfirm') {
        items.push({ documentId, disposition: 'skip', reason: ledger.reviewRequired === true ? 'REVIEW_UNFINISHED' : 'RECONFIRM_REQUESTED' })
        continue
      }
      // 只复制原元组；内容失配时不能用当前正文伪造历史批准。
      const record: ConfirmationRecord = { documentId, frontMatterFingerprint: ledger.frontMatterFingerprint, bodyFingerprint: ledger.bodyFingerprint, sourceFingerprint: ledger.sourceFingerprint }
      // 绑定兼容代号与完整元组的内容身份。
      const key = confirmationKey(FORMAT, record)
      records.set(key, record)
      items.push({ documentId, disposition: 'import', reason: 'LEGACY_EVIDENCE', key })
    }
  }
  // 绑定原始快照、策略和全部迁移决定的摘要。
  const planFingerprint = sha256(compactJson({ contextFingerprint: graph.contextFingerprint ?? null, strategy, metadata: metadata as unknown as JsonValue, items }))
  return { eligible, graph, strategy, metadata, records, items, planFingerprint }
}
