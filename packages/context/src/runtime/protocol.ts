import type { JsonObject, JsonValue } from './stable-json.js'
import { Buffer } from 'node:buffer'
import { createHash, timingSafeEqual } from 'node:crypto'
import { compactJson, compareCodeUnits, stableJson } from './stable-json.js'

// 单次 Runtime 请求与响应使用的固定协议标识。
export const PROTOCOL = 'plugydown.context.runtime'

// 新元数据、确认身份及后续调用合同共用的兼容代号，不随插件补丁版本变化。
export const FORMAT = 1

// 协议允许的只读能力白名单。
export const READ_CAPABILITIES = [
  'repository.inspect',
  'frontier.query',
  'graph.validate',
  'confirmation.check',
  'delta.compute',
  'growth.measure',
  'feedback.match',
] as const

/** Runtime 支持的只读能力名称。 */
export type ReadCapability = typeof READ_CAPABILITIES[number]
// 事务生命周期允许的动作集合。
export const TRANSACTION_ACTIONS = ['begin', 'validate', 'commit', 'resume'] as const
/** 事务允许执行的四个生命周期动作。 */
export type TransactionAction = typeof TRANSACTION_ACTIONS[number]
/** 全部协议能力名称，不包括未识别输入。 */
export type Capability = ReadCapability | 'transaction'
/** 请求的产品级执行状态，与传输层成功或失败分离。 */
export type RuntimeStatus = 'success' | 'no_change' | 'dry_run' | 'incomplete' | 'failed'
/** 协议诊断的严重程度。 */
export type Severity = 'error' | 'warning' | 'info'

/** 可公开返回的诊断，文本和可选路径须经过安全裁剪。 */
export interface Diagnostic {
  /** 稳定错误码，供调用方分支处理。 */
  readonly code: string
  /** 诊断严重程度，不等同于请求状态。 */
  readonly severity: Severity
  /** 可公开的诊断文本，不应包含环境值或凭据。 */
  readonly message: string
  /** 仓库相对路径；正式知识诊断统一使用 context/ 前缀。 */
  readonly path?: string
}

/** 单次响应的条目、UTF-8 字节和估算 token 预算。 */
export interface Budget {
  /** 单次响应最多包含的完整条目数量。 */
  readonly items: number
  /** 完整 JSON 响应允许的最大 UTF-8 字节数。 */
  readonly bytes: number
  /** 按 UTF-8 字节数估算的 token 数量。 */
  readonly estimatedTokens: number
}

// 单次读取默认预算：100 项、256 KiB、估算 32000 tokens。
export const DEFAULT_BUDGET: Budget = {
  items: 100,
  bytes: 256 * 1024,
  estimatedTokens: 32_000,
}

// 单次读取硬上限：1000 项、1 MiB、估算 128000 tokens。
export const MAX_BUDGET: Budget = {
  items: 1_000,
  bytes: 1024 * 1024,
  estimatedTokens: 128_000,
}

/** 调用方授予的仓库、领域、文档或路径范围。 */
export type Scope
  = | { readonly kind: 'repository' }
    | {
      readonly kind: 'domains'
      /** 授权或选中的稳定领域、文档 ID 集合。 */
      readonly ids: readonly string[]
    }
    | {
      readonly kind: 'documents'
      /** 授权或选中的稳定领域、文档 ID 集合。 */
      readonly ids: readonly string[]
    }
    | {
      readonly kind: 'paths'
      /** 仓库相对源码路径或受控 glob 声明。 */
      readonly paths: readonly string[]
    }

/** 仓库检查参数，可选择文档状态或迁移预览。 */
export interface RepositoryInspectInput {
  /** 本次调用显式选择的文档 ID；不自动扩大写入授权。 */
  readonly selectedDocumentIds?: readonly string[]
  /** 是否请求分页迁移预览；不授予写入权限。 */
  readonly migration?: true
}

/** 渐进读取选择器，用稳定身份、路径或关系缩小候选范围。 */
export interface FrontierSelectors {
  /** 待查询的领域 ID。 */
  readonly domainIds?: readonly string[]
  /** 当前领域或选择器包含的文档 ID。 */
  readonly documentIds?: readonly string[]
  /** 筛选允许的文档种类。 */
  readonly kinds?: readonly string[]
  /** 关系筛选条件，由关系类型与目标文档共同限定。 */
  readonly relation?: {
    /** 关系或结果分支的判别值。 */
    readonly type: 'requires' | 'related'
    /** 当前条目所属的稳定文档 ID。 */
    readonly documentId: string
  }
  /** 文档引用的仓库相对源码声明，可包含受控 glob。 */
  readonly codePaths?: readonly string[]
}

/** 渐进读取的深度、选择器与前置依赖闭包开关。 */
export interface FrontierQueryInput {
  /** 渐进读取深度：1 为领域，2 为文档元数据，3 可返回选中正文。 */
  readonly depth: 1 | 2 | 3
  /** 缩小读取候选的选择条件；深度 2/3 时必须提供。 */
  readonly selectors?: FrontierSelectors
  /** 是否把前置依赖加入读取闭包，不自动纳入 related。 */
  readonly requiresClosure?: boolean
}

/** 增量分析输入，包含宿主收集的 Git 证据和明确范围。 */
export interface DeltaComputeInput {
  /** 本次工作流拥有的 .scratch/evidence/ 直接子目录。 */
  readonly gitEvidencePath: string
  /** 调用方授予的作用范围，在事务开始后固定。 */
  readonly scope: Scope
}

/** 按授权范围只读计算当前文档的确认匹配。 */
export interface ConfirmationCheckInput {
  /** 默认检查整个仓库，也可限制为文档、领域或来源路径。 */
  readonly scope: Scope
  /** 是否附带失配解释码；默认 false。 */
  readonly explain: boolean
}

/** 用于反馈身份和复用匹配的四个业务字段。 */
export interface FeedbackMatchInput {
  /** 反馈可复用时适用的情境。 */
  readonly context: string
  /** 已观察到的具体行为，用于反馈身份和匹配。 */
  readonly observedBehavior: string
  /** 行为结果或可复用的修正方式。 */
  readonly outcomeOrCorrection: string
  /** 反馈可以再次适用的边界。 */
  readonly reuseBoundary: string
}

/** 事务所属的 Init、Update、Prune 或 Migrate 工作流。 */
export type TransactionCommand = 'init' | 'update' | 'prune' | 'migrate'
/** 宿主选择的语义审查深度，不代表 Runtime 调用了模型。 */
export type TransactionMode = 'light' | 'deep'

/** 创建事务时冻结的授权范围、证据和执行选项。 */
export interface TransactionBeginInput {
  /** 事务所属工作流，在 begin 时固定。 */
  readonly command: TransactionCommand
  /** 语义审查深度，由工作流开始时固定。 */
  readonly mode: TransactionMode
  /** 为 true 时验证后结束并清理，不切换正式 Context。 */
  readonly dryRun: boolean
  /** 调用方授予的作用范围，在事务开始后固定。 */
  readonly scope: Scope
  /** 本次工作流拥有的 .scratch/evidence/ 直接子目录。 */
  readonly gitEvidencePath: string
  /** 宿主显式补充的仓库相对证据声明，事务期间必须保持新鲜。 */
  readonly evidencePaths: readonly string[]
  /** 调用方已对照当前源码复核且确认准确的文档 ID，仅 Update 可用。 */
  readonly confirmedDocumentIds?: readonly string[]
  /** 迁移必须显式选择如何处理旧依据，不存在隐式导入默认值。 */
  readonly migrationStrategy?: 'import-trusted' | 'reconfirm'
}

/** 指定需要重新验证的已暂存事务。 */
export interface TransactionValidateInput {
  /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
  readonly runId: string
}

/** 主助手的显式批准，绑定候选与源码证据两个指纹。 */
export interface TransactionApproval {
  /** 是否显式批准；可提交的批准必须为 true。 */
  readonly approved: boolean
  /** 已验证候选完整目录树的 SHA-256 指纹。 */
  readonly candidateFingerprint: string
  /** 当前候选引用源码与显式证据的整体 SHA-256 指纹。 */
  readonly sourceEvidenceFingerprint: string
  /** 审查批准的简短说明；不替代指纹绑定。 */
  readonly summary: string
}

/** 提交请求，包含事务身份和对当前验证结果的批准。 */
export interface TransactionCommitInput {
  /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
  readonly runId: string
  /** 对当前已验证候选与源码证据的显式批准。 */
  readonly approval: TransactionApproval
}

/** 恢复已有事务，或显式放弃尚未切换目录的事务。 */
export interface TransactionResumeInput {
  /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
  readonly runId: string
  /** 恢复时继续事务或放弃尚未开始切换的事务。 */
  readonly disposition?: 'continue' | 'abandon'
}

/** 各能力允许的输入联合，由能力与动作共同决定具体形状。 */
export type CapabilityInput
  = | RepositoryInspectInput
    | FrontierQueryInput
    | DeltaComputeInput
    | ConfirmationCheckInput
    | FeedbackMatchInput
    | TransactionBeginInput
    | TransactionCommitInput
    | TransactionResumeInput
    | TransactionValidateInput
    | Record<string, never>

/** 经过协议校验的单次请求，根目录由进程 cwd 决定。 */
export interface RuntimeRequest {
  /** 固定 Runtime 协议标识。 */
  readonly protocol: typeof PROTOCOL
  /** 与持久数据、临时资源共同使用的兼容代号。 */
  readonly format: typeof FORMAT
  /** 请求分派目标或响应所属能力。 */
  readonly capability: Capability
  /** transaction 能力的生命周期动作，其他能力不得携带。 */
  readonly action?: TransactionAction
  /** 经能力及动作限定的请求参数。 */
  readonly input: CapabilityInput
  /** 本次响应预算，缺省时使用 Runtime 默认值。 */
  readonly budget?: Budget
  /** 绑定查询与快照的续读令牌，不是写入授权。 */
  readonly cursor?: string
}

/** Runtime 的单次产品响应，不包含传输层故障对象。 */
export interface RuntimeResponse {
  /** 固定 Runtime 协议标识。 */
  readonly protocol: typeof PROTOCOL
  /** 与持久数据、临时资源共同使用的兼容代号。 */
  readonly format: typeof FORMAT
  /** 请求分派目标或响应所属能力。 */
  readonly capability: Capability | 'unknown'
  /** 产品级执行状态；success 不代表 Context 本身有效。 */
  readonly status: RuntimeStatus
  /** 该能力和状态允许返回的结果数据。 */
  readonly data?: JsonObject
  /** 绑定查询与快照的续读令牌，不是写入授权。 */
  readonly cursor?: string
  /** 面向调用方的问题列表，输出时统一排序和裁剪。 */
  readonly diagnostics?: readonly Diagnostic[]
}

/** 可安全封装为合法协议响应的产品级故障。 */
export class RuntimeFault extends Error {
  /** 稳定错误码，供调用方分支处理。 */
  readonly code: string
  /** 面向调用方的问题列表，输出时统一排序和裁剪。 */
  readonly diagnostics: readonly Diagnostic[]

  /**
   * 构造可由请求入口转换为 failed 响应的产品故障。
   *
   * @param code - 稳定错误码，用于调用方分支处理。
   * @param message - 可公开的问题说明。
   * @param path - 可选的仓库相对诊断路径，最终由响应出口安全筛选。
   * @remarks 调用阶段：发现可预期的协议、知识或事务错误时。构造错误实例，不执行文件操作，也不主动抛出。
   */
  constructor(code: string, message: string, path?: string) {
    super(message)
    this.name = 'RuntimeFault'
    this.code = code
    this.diagnostics = [{ code, severity: 'error', message, ...(path === undefined ? {} : { path }) }]
  }
}

/**
 * 构造结构化诊断，由响应出口统一排序和限制长度。
 *
 * @param code - 稳定错误码。
 * @param message - 可公开的问题说明，不包含环境值或凭据。
 * @param severity - 诊断严重程度，缺省为 error。
 * @param path - 可选的仓库相对诊断路径。
 * @returns 未经出口裁剪的结构化诊断对象。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：请求解析、响应构造或分页续读；纯协议计算，不读写正式知识。
 */
export function diagnostic(code: string, message: string, severity: Severity = 'error', path?: string): Diagnostic {
  return { code, severity, message, ...(path === undefined ? {} : { path }) }
}

// 单次响应最多返回的诊断数量，包含省略汇总项。
const MAX_DIAGNOSTICS = 100
// 单条诊断消息的最大字符数。
const MAX_DIAGNOSTIC_MESSAGE = 512
// 诊断路径允许的最大字符数。
const MAX_DIAGNOSTIC_PATH = 1_024

/** 清除诊断中的控制字符并按字符数量裁剪文本。 */
function cleanDiagnosticText(value: string, maximum: number): string {
  // 当前字符的 Unicode 码点，用于拒绝控制字符。
  const cleaned = [...value].map((character) => {
    // 当前字符的 Unicode 码点，用于拒绝控制字符。
    const codePoint = character.codePointAt(0) as number
    return codePoint <= 0x1F || codePoint === 0x7F ? ' ' : character
  }).join('').trim()
  return cleaned.length <= maximum ? cleaned : cleaned.slice(0, maximum)
}

// 诊断路径规则须与 repository.ts 的路径安全边界同步；避免循环依赖而独立实现，输出过滤不能更宽松。
const DIAGNOSTIC_PATH_VARIABLE = /\$|%[A-Z_]\w*%/i

/** 仅保留可安全公开的仓库相对诊断路径。 */
function safeDiagnosticPath(value: string): string | undefined {
  // 移除不安全字符并按长度限制处理后的公开文本。
  const cleaned = cleanDiagnosticText(value, MAX_DIAGNOSTIC_PATH)
  if (cleaned.length === 0 || cleaned.length !== value.length || cleaned.startsWith('/') || cleaned.includes('\\')
    || /^[a-z]:/i.test(cleaned) || DIAGNOSTIC_PATH_VARIABLE.test(cleaned) || cleaned.includes('~')
    || cleaned.split('/').some(part => part.length === 0 || part === '.' || part === '..')) {
    return undefined
  }
  return cleaned
}

/** 裁剪诊断文本并移除不安全路径，防止响应泄漏环境信息。 */
function boundedDiagnostic(value: Diagnostic): Diagnostic {
  // 经安全筛选后允许出现在诊断中的仓库相对路径。
  const path = value.path === undefined ? undefined : safeDiagnosticPath(value.path)
  return {
    code: cleanDiagnosticText(value.code, 128),
    severity: value.severity,
    message: cleanDiagnosticText(value.message, MAX_DIAGNOSTIC_MESSAGE),
    ...(path === undefined ? {} : { path }),
  }
}

/**
 * 安全裁剪并稳定排序诊断，超量时用汇总项说明省略数量。
 *
 * @param diagnostics - 内部诊断集合，输出时进行安全裁剪。
 * @returns 裁剪和排序后的诊断集合，超量部分由汇总警告替代。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：请求解析、响应构造或分页续读；纯协议计算，不读写正式知识。
 */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  // 经安全裁剪并按错误码、路径和消息排序的诊断。
  const sorted = diagnostics.map(boundedDiagnostic).sort((left, right) => compareCodeUnits(
    `${left.code}\0${left.path ?? ''}\0${left.message}`,
    `${right.code}\0${right.path ?? ''}\0${right.message}`,
  ))
  if (sorted.length <= MAX_DIAGNOSTICS)
    return sorted
  // 因响应诊断上限而省略的问题数量。
  const omitted = sorted.length - (MAX_DIAGNOSTICS - 1)
  return [
    ...sorted.slice(0, MAX_DIAGNOSTICS - 1),
    diagnostic('DIAGNOSTICS_OMITTED', `${omitted} additional diagnostics were omitted.`, 'warning'),
  ]
}

/**
 * 校验响应状态组合并构造只读能力的规范响应。
 *
 * @param capability - 响应或游标所属的能力名称。
 * @param status - 产品级响应状态。
 * @param options - 当前操作的校验、选择或格式选项。
 * @param options.data - 该能力和状态允许返回的结果数据。
 * @param options.cursor - 绑定查询与快照的续读令牌，不是写入授权。
 * @param options.diagnostics - 面向调用方的问题列表，输出时统一排序和裁剪。
 * @returns 满足当前能力和状态组合约束的规范响应。
 * @throws 状态与 data/cursor/diagnostics 的组合违反协议时抛出 TypeError。
 * @remarks 调用阶段：请求解析、响应构造或分页续读；纯协议计算，不读写正式知识。
 */
export function runtimeResponse(
  capability: Capability | 'unknown',
  status: RuntimeStatus,
  options: {
    /** 该能力和状态允许返回的结果数据。 */
    readonly data?: JsonObject
    /** 绑定查询与快照的续读令牌，不是写入授权。 */
    readonly cursor?: string
    /** 面向调用方的问题列表，输出时统一排序和裁剪。 */
    readonly diagnostics?: readonly Diagnostic[]
  } = {},
): RuntimeResponse {
  // 即将写入响应的有界诊断列表。
  const diagnostics = options.diagnostics === undefined ? undefined : sortDiagnostics(options.diagnostics)
  if (capability !== 'transaction') {
    if (status === 'failed' && (options.data !== undefined || options.cursor !== undefined || diagnostics === undefined || diagnostics.length === 0))
      throw new TypeError('A failed read response requires diagnostics and forbids data/cursor.')
    if (status === 'success' && (options.data === undefined || options.cursor !== undefined))
      throw new TypeError('A successful read response requires data and forbids a cursor.')
    if (status === 'incomplete' && (options.data === undefined || options.cursor === undefined))
      throw new TypeError('An incomplete read response requires data and a cursor.')
    if (status === 'no_change' || status === 'dry_run')
      throw new TypeError('Read capabilities do not use transaction-only statuses.')
  }
  return {
    protocol: PROTOCOL,
    format: FORMAT,
    capability,
    status,
    ...(options.data === undefined ? {} : { data: options.data }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(diagnostics === undefined || diagnostics.length === 0 ? {} : { diagnostics }),
  }
}

/** 事务结果判别联合，每种结果仅携带其阶段允许的字段。 */
export type TransactionOutcome
  = | {
    readonly outcome: 'migration_staged'
    /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
    readonly runId: string
    /** 当前事务拥有的完整候选 Context 相对目录。 */
    readonly candidatePath: string
  }
  | {
    readonly outcome: 'staged'
    /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
    readonly runId: string
    /** 当前事务拥有的完整候选 Context 相对目录。 */
    readonly candidatePath: string
  }
  | {
    readonly outcome: 'ready_for_review'
    /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
    readonly runId: string
    /** 已验证候选完整目录树的 SHA-256 指纹。 */
    readonly candidateFingerprint: string
    /** 当前候选引用源码与显式证据的整体 SHA-256 指纹。 */
    readonly sourceEvidenceFingerprint: string
    /** 当前确认的文档数量与计划指纹，仅作为验证摘要。 */
    readonly confirmation?: {
      /** 本次派生确认的文档数量。 */
      readonly documentCount: number
      /** 本次实际新增的不可变确认数量。 */
      readonly newRecordCount: number
      /** 确定性确认计划的 SHA-256 指纹，用于核对预览与验证。 */
      readonly planFingerprint: string
    }
  }
  | {
    /** 事务具体结局，决定响应状态、后续动作及清理策略。 */
    readonly outcome: 'committed' | 'candidate_completed'
    /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
    readonly runId: string
    /** 完整正式或候选 Context 文件树的 SHA-256 指纹。 */
    readonly contextFingerprint: string
    /** 本次提交实际采用的候选批准指纹。 */
    readonly approvedCandidateFingerprint: string
    /** 本次提交实际采用的源码证据批准指纹。 */
    readonly approvedSourceEvidenceFingerprint: string
  }
  | {
    readonly outcome: 'abandoned'
    /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
    readonly runId: string
  }
  | {
    readonly outcome: 'no_change'
    /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
    readonly runId: string
    /** 完整正式或候选 Context 文件树的 SHA-256 指纹。 */
    readonly contextFingerprint: string
  }
  | {
    readonly outcome: 'validated'
    /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
    readonly runId: string
    /** 已验证候选完整目录树的 SHA-256 指纹。 */
    readonly candidateFingerprint: string
    /** 当前候选引用源码与显式证据的整体 SHA-256 指纹。 */
    readonly sourceEvidenceFingerprint: string
    /** 当前确认的文档数量与计划指纹，仅作为验证摘要。 */
    readonly confirmation?: {
      /** 本次派生确认的文档数量。 */
      readonly documentCount: number
      /** 本次实际新增的不可变确认数量。 */
      readonly newRecordCount: number
      /** 确定性确认计划的 SHA-256 指纹，用于核对预览与验证。 */
      readonly planFingerprint: string
    }
  }
  | {
    readonly outcome: 'active_run'
    /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
    readonly runId: string
  }
  | {
    /** 事务具体结局，决定响应状态、后续动作及清理策略。 */
    readonly outcome: 'candidate_edit_required' | 'candidate_stale' | 'approval_mismatch'
    /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
    readonly runId: string
  }
  | {
    readonly outcome: 'manual_recovery'
    /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
    readonly runId?: string
  }
  | {
    readonly outcome: 'snapshot_stale'
    /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
    readonly runId: string
  }
  | {
    readonly outcome: 'backup_restored'
    /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
    readonly runId: string
    /** 完整正式或候选 Context 文件树的 SHA-256 指纹。 */
    readonly contextFingerprint: string
  }
  | {
    readonly outcome: 'no_trusted_copy'
    /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
    readonly runId: string
  }
  | {
    readonly outcome: 'mechanical_failure'
    /** Runtime 生成的事务 UUID，也是运行目录和写锁所有权标识。 */
    readonly runId: string
  }
// 每个事务结局对应的唯一状态、后续动作和人工恢复标志。
const TRANSACTION_SHAPES = {
  migration_staged: { status: 'success', nextAction: 'validate' },
  staged: { status: 'success', nextAction: 'edit_candidate' },
  ready_for_review: { status: 'success', nextAction: 'semantic_review' },
  committed: { status: 'success' },
  candidate_completed: { status: 'success' },
  abandoned: { status: 'success' },
  no_change: { status: 'no_change' },
  validated: { status: 'dry_run' },
  active_run: { status: 'incomplete', nextAction: 'resume' },
  candidate_edit_required: { status: 'incomplete', nextAction: 'edit_candidate' },
  candidate_stale: { status: 'incomplete', nextAction: 'validate' },
  approval_mismatch: { status: 'incomplete', nextAction: 'semantic_review' },
  manual_recovery: { status: 'incomplete', manualRecoveryRequired: true },
  snapshot_stale: { status: 'failed', nextAction: 'restart_transaction' },
  backup_restored: { status: 'failed' },
  no_trusted_copy: { status: 'failed', manualRecoveryRequired: true },
  mechanical_failure: { status: 'failed' },
} as const satisfies Record<TransactionOutcome['outcome'], {
  /** 产品级执行状态；success 不代表 Context 本身有效。 */
  readonly status: RuntimeStatus
} & JsonObject>

/**
 * 根据事务结果推导唯一合法的状态和后续动作。
 *
 * @param result - 具体事务结局及其阶段允许的字段。
 * @param diagnostics - 内部诊断集合，输出时进行安全裁剪。
 * @returns 由具体 outcome 唯一推导 status 和 nextAction 的响应。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：请求解析、响应构造或分页续读；纯协议计算，不读写正式知识。
 */
export function transactionResponse(
  result: TransactionOutcome,
  diagnostics?: readonly Diagnostic[],
): RuntimeResponse {
  const { status, ...derived } = TRANSACTION_SHAPES[result.outcome]
  // 按确定性顺序组织的结果，避免受机器区域设置影响。
  const sorted = diagnostics === undefined ? undefined : sortDiagnostics(diagnostics)
  return {
    protocol: PROTOCOL,
    format: FORMAT,
    capability: 'transaction',
    status,
    data: { ...result, ...derived } as JsonObject,
    ...(sorted === undefined || sorted.length === 0 ? {} : { diagnostics: sorted }),
  }
}

/**
 * 将故障转换为失败响应；未知异常只公开通用错误信息。
 *
 * @param capability - 响应或游标所属的能力名称。
 * @param error - 待分类的异常，可能是产品故障或未知错误。
 * @returns 可公开的 failed 响应，未知异常不会泄漏细节。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：请求解析、响应构造或分页续读；纯协议计算，不读写正式知识。
 */
export function failureResponse(capability: Capability | 'unknown', error: unknown): RuntimeResponse {
  if (error instanceof RuntimeFault)
    return runtimeResponse(capability, 'failed', { diagnostics: error.diagnostics })
  return runtimeResponse(capability, 'failed', {
    diagnostics: [diagnostic('INTERNAL_ERROR', 'The Runtime encountered an unexpected internal error.')],
  })
}

/**
 * 判断输入是否为非 null、非数组的对象。
 *
 * @param value - 待校验或规范化的输入值。
 * @returns 是否为非 null、非数组的对象，同时缩窄 TypeScript 类型。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：请求解析、响应构造或分页续读；纯协议计算，不读写正式知识。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 验证对象必填字段和封闭字段集合，拒绝遗漏或额外字段。 */
function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], subject: string): void {
  // 当前对象允许出现的字段集合。
  const allowedSet = new Set(allowed)
  // 输入中不属于允许身份或字段集合的项。
  const unknown = Object.keys(value).filter(key => !allowedSet.has(key)).sort(compareCodeUnits)
  if (unknown.length > 0)
    throw new RuntimeFault('REQUEST_FIELD_UNKNOWN', `${subject} contains an unknown field.`)
  // 输入中缺失的必填字段集合。
  const missing = required.filter(key => !(key in value))
  if (missing.length > 0)
    throw new RuntimeFault('REQUEST_FIELD_MISSING', `${subject} requires field "${missing[0]}".`)
}

/** 读取长度受限且非空的请求字符串。 */
function text(value: unknown, field: string, maximum = 65_536): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum)
    throw new RuntimeFault('REQUEST_FIELD_INVALID', `Request field "${field}" must be a non-empty string within its limit.`)
  return value
}

/** 读取严格布尔值，不做隐式类型转换。 */
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean')
    throw new RuntimeFault('REQUEST_FIELD_INVALID', `Request field "${field}" must be boolean.`)
  return value
}

/** 读取长度受限、去重的字符串数组，并按调用要求拒绝空数组。 */
function uniqueStrings(value: unknown, field: string, options: {
  /** 是否拒绝空数组或空输入。 */
  readonly nonEmpty?: boolean
  /** 数组允许包含的最大元素数量。 */
  readonly maximum?: number
} = {}): readonly string[] {
  // 本次校验生效的数量或长度上限。
  const maximum = options.maximum ?? 10_000
  if (!Array.isArray(value) || value.length > maximum || (options.nonEmpty === true && value.length === 0))
    throw new RuntimeFault('REQUEST_FIELD_INVALID', `Request field "${field}" must be a bounded string array.`)
  if (value.some(item => typeof item !== 'string' || item.length === 0) || new Set(value).size !== value.length)
    throw new RuntimeFault('REQUEST_FIELD_INVALID', `Request field "${field}" must contain unique non-empty strings.`)
  return value as string[]
}

// 领域 ID 的小写 kebab-case 校验规则。
const DOMAIN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// 允许点分层级的稳定文档 ID 校验规则。
const DOCUMENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/

/** 在字符串数组校验后继续验证领域或文档 ID 语法。 */
function uniqueIds(value: unknown, field: string, pattern: RegExp, kind: 'Domain' | 'Document', nonEmpty = false): readonly string[] {
  // 当前选择或授权涉及的稳定身份集合。
  const ids = uniqueStrings(value, field, { nonEmpty })
  if (ids.some(id => !pattern.test(id)))
    throw new RuntimeFault('REQUEST_FIELD_INVALID', `Request field "${field}" must contain valid ${kind} IDs.`)
  return ids
}

/** 验证不接受参数的能力确实收到空对象。 */
function emptyInput(value: unknown, capability: string): Record<string, never> {
  if (!isRecord(value))
    throw new RuntimeFault('REQUEST_INPUT_INVALID', `${capability} input must be an object.`)
  assertExactKeys(value, [], [], `${capability} input`)
  return {}
}

/** 解析仓库检查参数，限制迁移开关与文档选择器的形状。 */
function parseInspectInput(value: unknown): RepositoryInspectInput {
  if (!isRecord(value))
    throw new RuntimeFault('REQUEST_INPUT_INVALID', 'repository.inspect input must be an object.')
  assertExactKeys(value, ['selectedDocumentIds', 'migration'], [], 'repository.inspect input')
  if (value.migration !== undefined && value.migration !== true)
    throw new RuntimeFault('REQUEST_FIELD_INVALID', 'repository.inspect migration must be true when present.')
  if (value.migration && value.selectedDocumentIds !== undefined)
    throw new RuntimeFault('REQUEST_FIELD_INVALID', 'Migration preview does not accept a document selection.')
  return {
    ...(value.selectedDocumentIds === undefined ? {} : { selectedDocumentIds: uniqueIds(value.selectedDocumentIds, 'selectedDocumentIds', DOCUMENT_ID, 'Document') }),
    ...(value.migration === true ? { migration: true } : {}),
  }
}

// 文档种类白名单，决定路由与物理存放位置。
const DOCUMENT_KINDS = ['domain', 'architecture', 'decision', 'guide', 'reference', 'reflection'] as const

/** 解析渐进读取选择器并验证关系和身份约束。 */
function parseSelectors(value: unknown): FrontierSelectors | undefined {
  if (value === undefined)
    return undefined
  if (!isRecord(value))
    throw new RuntimeFault('REQUEST_FIELD_INVALID', 'frontier.query selectors must be an object.')
  assertExactKeys(value, ['domainIds', 'documentIds', 'kinds', 'relation', 'codePaths'], [], 'frontier.query selectors')
  // 经字段校验的渐进读取选择条件。
  const selectors: { -readonly [K in keyof FrontierSelectors]?: FrontierSelectors[K] } = {}
  if (value.domainIds !== undefined)
    selectors.domainIds = uniqueIds(value.domainIds, 'selectors.domainIds', DOMAIN_ID, 'Domain')
  if (value.documentIds !== undefined)
    selectors.documentIds = uniqueIds(value.documentIds, 'selectors.documentIds', DOCUMENT_ID, 'Document')
  if (value.codePaths !== undefined)
    selectors.codePaths = uniqueStrings(value.codePaths, 'selectors.codePaths')
  if (value.kinds !== undefined) {
    // 请求选中的文档种类集合。
    const kinds = uniqueStrings(value.kinds, 'selectors.kinds')
    if (kinds.some(kind => !(DOCUMENT_KINDS as readonly string[]).includes(kind)))
      throw new RuntimeFault('REQUEST_FIELD_INVALID', 'selectors.kinds contains an unknown Document kind.')
    selectors.kinds = kinds
  }
  if (value.relation !== undefined) {
    if (!isRecord(value.relation))
      throw new RuntimeFault('REQUEST_FIELD_INVALID', 'selectors.relation must be an object.')
    assertExactKeys(value.relation, ['type', 'documentId'], ['type', 'documentId'], 'selectors.relation')
    if (value.relation.type !== 'requires' && value.relation.type !== 'related')
      throw new RuntimeFault('REQUEST_FIELD_INVALID', 'selectors.relation.type must be requires or related.')
    selectors.relation = {
      type: value.relation.type,
      documentId: uniqueIds([value.relation.documentId], 'selectors.relation.documentId', DOCUMENT_ID, 'Document', true)[0] as string,
    }
  }
  return selectors
}

/** 解析读取深度，拒绝未提供必要选择器的正文请求。 */
function parseFrontierInput(value: unknown): FrontierQueryInput {
  if (!isRecord(value))
    throw new RuntimeFault('REQUEST_INPUT_INVALID', 'frontier.query input must be an object.')
  assertExactKeys(value, ['depth', 'selectors', 'requiresClosure'], ['depth'], 'frontier.query input')
  if (value.depth !== 1 && value.depth !== 2 && value.depth !== 3)
    throw new RuntimeFault('REQUEST_FIELD_INVALID', 'frontier.query depth must be 1, 2, or 3.')
  // 经字段校验的渐进读取选择条件。
  const selectors = parseSelectors(value.selectors)
  if (value.depth > 1 && (selectors === undefined || Object.keys(selectors).length === 0))
    throw new RuntimeFault('REQUEST_FIELD_INVALID', 'frontier.query depth 2 and 3 require a selector.')
  if (value.depth === 1 && value.requiresClosure !== undefined)
    throw new RuntimeFault('REQUEST_FIELD_INVALID', 'requiresClosure is only valid for depth 2 or 3.')
  return {
    depth: value.depth,
    ...(selectors === undefined ? {} : { selectors }),
    ...(value.requiresClosure === undefined ? {} : { requiresClosure: boolean(value.requiresClosure, 'requiresClosure') }),
  }
}

/** 解析唯一的授权范围种类并验证其字段。 */
function parseScope(value: unknown): Scope {
  if (!isRecord(value) || typeof value.kind !== 'string')
    throw new RuntimeFault('REQUEST_FIELD_INVALID', 'scope must be a discriminated object.')
  if (value.kind === 'repository') {
    assertExactKeys(value, ['kind'], ['kind'], 'scope')
    return { kind: 'repository' }
  }
  if (value.kind === 'domains' || value.kind === 'documents') {
    assertExactKeys(value, ['kind', 'ids'], ['kind', 'ids'], 'scope')
    return {
      kind: value.kind,
      ids: uniqueIds(value.ids, 'scope.ids', value.kind === 'domains' ? DOMAIN_ID : DOCUMENT_ID, value.kind === 'domains' ? 'Domain' : 'Document', true),
    }
  }
  if (value.kind === 'paths') {
    assertExactKeys(value, ['kind', 'paths'], ['kind', 'paths'], 'scope')
    return { kind: 'paths', paths: uniqueStrings(value.paths, 'scope.paths', { nonEmpty: true }) }
  }
  throw new RuntimeFault('REQUEST_FIELD_INVALID', 'scope.kind is unknown.')
}

/** 解析显式 Git 比较和授权范围，不推导全局审查任务。 */
function parseDeltaInput(value: unknown): DeltaComputeInput {
  if (!isRecord(value))
    throw new RuntimeFault('REQUEST_INPUT_INVALID', 'delta.compute input must be an object.')
  assertExactKeys(value, ['gitEvidencePath', 'scope'], ['gitEvidencePath', 'scope'], 'delta.compute input')
  return { gitEvidencePath: text(value.gitEvidencePath, 'gitEvidencePath', 1_024), scope: parseScope(value.scope) }
}

/** 解析有界确认检查，省略范围表示完整仓库。 */
function parseConfirmationInput(value: unknown): ConfirmationCheckInput {
  if (!isRecord(value))
    throw new RuntimeFault('REQUEST_INPUT_INVALID', 'confirmation.check input must be an object.')
  assertExactKeys(value, ['scope', 'explain'], [], 'confirmation.check input')
  return { scope: value.scope === undefined ? { kind: 'repository' } : parseScope(value.scope), explain: value.explain === undefined ? false : boolean(value.explain, 'explain') }
}

/** 校验反馈匹配所需的四个非空字段。 */
function parseFeedbackInput(value: unknown): FeedbackMatchInput {
  if (!isRecord(value))
    throw new RuntimeFault('REQUEST_INPUT_INVALID', 'feedback.match input must be an object.')
  // 当前协议对象需要校验的业务字段集合。
  const fields = ['context', 'observedBehavior', 'outcomeOrCorrection', 'reuseBoundary'] as const
  assertExactKeys(value, fields, fields, 'feedback.match input')
  return {
    context: text(value.context, 'context'),
    observedBehavior: text(value.observedBehavior, 'observedBehavior'),
    outcomeOrCorrection: text(value.outcomeOrCorrection, 'outcomeOrCorrection'),
    reuseBoundary: text(value.reuseBoundary, 'reuseBoundary'),
  }
}

// Runtime 事务 UUID v4 的格式校验规则。
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
// 小写 SHA-256 十六进制指纹的格式校验规则。
const FINGERPRINT = /^[a-f0-9]{64}$/

/** 校验事务 ID 必须是 Runtime 生成的 UUID 格式。 */
function parseRunId(value: unknown): string {
  // 当前事务的 UUID，也是其运行目录和写锁的所有权标识。
  const runId = text(value, 'runId', 64)
  if (!UUID.test(runId))
    throw new RuntimeFault('RUN_ID_INVALID', 'runId must be a Runtime-generated UUID.')
  return runId
}

/** 按事务动作解析专属参数，拒绝跨动作字段和无效批准。 */
function parseTransactionInput(action: TransactionAction, value: unknown): TransactionBeginInput | TransactionCommitInput | TransactionResumeInput | TransactionValidateInput {
  if (!isRecord(value))
    throw new RuntimeFault('REQUEST_INPUT_INVALID', `transaction.${action} input must be an object.`)
  if (action === 'begin') {
    // 当前协议对象需要校验的业务字段集合。
    const fields = ['command', 'mode', 'dryRun', 'scope', 'gitEvidencePath', 'evidencePaths'] as const
    assertExactKeys(value, [...fields, 'confirmedDocumentIds', 'migrationStrategy'], fields, 'transaction.begin input')
    if (value.command !== 'init' && value.command !== 'update' && value.command !== 'prune' && value.command !== 'migrate')
      throw new RuntimeFault('REQUEST_FIELD_INVALID', 'transaction.begin command is unknown.')
    if (value.mode !== 'light' && value.mode !== 'deep')
      throw new RuntimeFault('REQUEST_FIELD_INVALID', 'transaction.begin mode must be light or deep.')
    if (value.command === 'migrate' ? !['import-trusted', 'reconfirm'].includes(String(value.migrationStrategy)) : value.migrationStrategy !== undefined)
      throw new RuntimeFault('REQUEST_FIELD_INVALID', 'Only migrate requires an explicit migrationStrategy.')
    return {
      command: value.command,
      ...(value.command === 'migrate' ? { migrationStrategy: value.migrationStrategy as 'import-trusted' | 'reconfirm' } : {}),
      mode: value.mode,
      dryRun: boolean(value.dryRun, 'dryRun'),
      scope: parseScope(value.scope),
      gitEvidencePath: text(value.gitEvidencePath, 'gitEvidencePath', 1_024),
      evidencePaths: uniqueStrings(value.evidencePaths, 'evidencePaths', {}),
      ...(value.confirmedDocumentIds === undefined
        ? {}
        : { confirmedDocumentIds: uniqueIds(value.confirmedDocumentIds, 'confirmedDocumentIds', DOCUMENT_ID, 'Document', true) }),
    }
  }
  if (action === 'validate') {
    assertExactKeys(value, ['runId'], ['runId'], `transaction.${action} input`)
    return { runId: parseRunId(value.runId) }
  }
  if (action === 'resume') {
    assertExactKeys(value, ['runId', 'disposition'], ['runId'], 'transaction.resume input')
    if (value.disposition !== undefined && value.disposition !== 'continue' && value.disposition !== 'abandon')
      throw new RuntimeFault('REQUEST_FIELD_INVALID', 'transaction.resume disposition must be continue or abandon.')
    return {
      runId: parseRunId(value.runId),
      ...(value.disposition === undefined ? {} : { disposition: value.disposition }),
    }
  }
  assertExactKeys(value, ['runId', 'approval'], ['runId', 'approval'], 'transaction.commit input')
  if (!isRecord(value.approval))
    throw new RuntimeFault('REQUEST_FIELD_INVALID', 'transaction.commit approval must be an object.')
  // 当前协议对象需要校验的业务字段集合。
  const fields = ['approved', 'candidateFingerprint', 'sourceEvidenceFingerprint', 'summary'] as const
  assertExactKeys(value.approval, fields, fields, 'transaction.commit approval')
  if (typeof value.approval.candidateFingerprint !== 'string' || !FINGERPRINT.test(value.approval.candidateFingerprint)
    || typeof value.approval.sourceEvidenceFingerprint !== 'string' || !FINGERPRINT.test(value.approval.sourceEvidenceFingerprint)) {
    throw new RuntimeFault('APPROVAL_INVALID', 'Approval fingerprints must be lowercase SHA-256 values.')
  }
  if (boolean(value.approval.approved, 'approval.approved') !== true)
    throw new RuntimeFault('APPROVAL_INVALID', 'Approval must explicitly be true.')
  return {
    runId: parseRunId(value.runId),
    approval: {
      approved: true,
      candidateFingerprint: value.approval.candidateFingerprint,
      sourceEvidenceFingerprint: value.approval.sourceEvidenceFingerprint,
      summary: text(value.approval.summary, 'approval.summary', 2_048),
    },
  }
}

/** 合并默认预算并拒绝超出硬上限或非正整数的维度。 */
function parseBudget(value: unknown): Budget | undefined {
  if (value === undefined)
    return undefined
  if (!isRecord(value))
    throw new RuntimeFault('BUDGET_INVALID', 'budget must be an object.')
  assertExactKeys(value, ['items', 'bytes', 'estimatedTokens'], [], 'budget')
  // 从默认值开始合并显式预算的可写副本。
  const result: { -readonly [K in keyof Budget]: number } = { ...DEFAULT_BUDGET }
  for (const field of ['items', 'bytes', 'estimatedTokens'] as const) {
    // 调用方为当前预算维度提供的值。
    const candidate = value[field]
    if (candidate === undefined)
      continue
    if (!Number.isInteger(candidate) || (candidate as number) < 1 || (candidate as number) > MAX_BUDGET[field])
      throw new RuntimeFault('BUDGET_INVALID', `budget.${field} must be a positive integer no greater than ${MAX_BUDGET[field]}.`)
    result[field] = candidate as number
  }
  return result
}

// 允许携带预算和续读游标的能力白名单。
const PAGED = new Set<Capability>(['repository.inspect', 'frontier.query', 'confirmation.check', 'delta.compute', 'growth.measure', 'feedback.match'])

/**
 * 严格解析协议封套与能力输入，不接受未知能力或跨能力参数。
 *
 * @param raw - 未经格式校验的原始输入。
 * @returns 经过封套、输入、预算和游标字段校验的请求。
 * @throws 非法封套、能力、参数或预算抛出带稳定诊断码的 RuntimeFault。
 * @remarks 调用阶段：请求解析、响应构造或分页续读；纯协议计算，不读写正式知识。
 */
export function parseRequest(raw: unknown): RuntimeRequest {
  if (!isRecord(raw))
    throw new RuntimeFault('REQUEST_INVALID', 'A Runtime request must be an object.')
  assertExactKeys(raw, ['protocol', 'format', 'capability', 'action', 'input', 'budget', 'cursor'], ['protocol', 'format', 'capability', 'input'], 'request')
  if (raw.protocol !== PROTOCOL)
    throw new RuntimeFault('PROTOCOL_UNSUPPORTED', `The request protocol must be ${PROTOCOL}.`)
  if (raw.format !== FORMAT)
    throw new RuntimeFault('FORMAT_UNSUPPORTED', 'The requested compatibility format is unsupported.')
  if (typeof raw.capability !== 'string' || (!(READ_CAPABILITIES as readonly string[]).includes(raw.capability) && raw.capability !== 'transaction'))
    throw new RuntimeFault('CAPABILITY_UNKNOWN', 'The request capability is unknown.')
  // 从请求中识别的能力名，用于分派或安全标注失败响应。
  const capability = raw.capability as Capability
  if (capability === 'transaction' && (typeof raw.action !== 'string' || !(TRANSACTION_ACTIONS as readonly string[]).includes(raw.action)))
    throw new RuntimeFault('ACTION_UNKNOWN', 'transaction requests require a known action.')
  if (capability !== 'transaction' && raw.action !== undefined)
    throw new RuntimeFault('REQUEST_FIELD_INVALID', 'action is only valid for transaction requests.')
  if (!PAGED.has(capability) && (raw.budget !== undefined || raw.cursor !== undefined))
    throw new RuntimeFault('REQUEST_FIELD_INVALID', `${capability} does not accept budget or cursor.`)
  if (raw.cursor !== undefined && (typeof raw.cursor !== 'string' || raw.cursor.length === 0 || raw.cursor.length > 4_096))
    throw new RuntimeFault('CURSOR_INVALID', 'cursor must be a bounded non-empty string.')

  // 当前能力已解析的业务参数。
  let input: CapabilityInput
  switch (capability) {
    case 'repository.inspect':
      input = parseInspectInput(raw.input)
      break
    case 'frontier.query':
      input = parseFrontierInput(raw.input)
      break
    case 'graph.validate':
      input = emptyInput(raw.input, capability)
      break
    case 'confirmation.check':
      input = parseConfirmationInput(raw.input)
      break
    case 'delta.compute':
      input = parseDeltaInput(raw.input)
      break
    case 'growth.measure':
      input = emptyInput(raw.input, capability)
      break
    case 'feedback.match':
      input = parseFeedbackInput(raw.input)
      break
    case 'transaction':
      input = parseTransactionInput(raw.action as TransactionAction, raw.input)
      break
  }
  return {
    protocol: PROTOCOL,
    format: FORMAT,
    capability,
    ...(capability === 'transaction' ? { action: raw.action as TransactionAction } : {}),
    input,
    ...(raw.budget === undefined ? {} : { budget: parseBudget(raw.budget) as Budget }),
    ...(raw.cursor === undefined ? {} : { cursor: raw.cursor }),
  }
}

/**
 * 从未校验请求中识别能力名，仅用于安全标注失败响应。
 *
 * @param raw - 未经格式校验的原始输入。
 * @returns 已知能力名称；无法识别时返回 unknown。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：请求解析、响应构造或分页续读；纯协议计算，不读写正式知识。
 */
export function requestCapability(raw: unknown): Capability | 'unknown' {
  if (!isRecord(raw) || typeof raw.capability !== 'string')
    return 'unknown'
  return (READ_CAPABILITIES as readonly string[]).includes(raw.capability) || raw.capability === 'transaction' ? raw.capability as Capability : 'unknown'
}

/**
 * 为已校验请求取得显式预算或默认预算。
 *
 * @param request - 当前能力的请求；除入口解析函数外应已通过协议校验。
 * @returns 请求中给出的完整预算或默认预算。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：请求解析、响应构造或分页续读；纯协议计算，不读写正式知识。
 */
export function resolvedBudget(request: RuntimeRequest): Budget {
  return request.budget ?? DEFAULT_BUDGET
}

/**
 * 计算字符串或字节序列的 SHA-256 十六进制指纹。
 *
 * @param value - 待校验或规范化的输入值。
 * @returns 64 位小写十六进制 SHA-256 指纹。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：请求解析、响应构造或分页续读；纯协议计算，不读写正式知识。
 */
export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 分页续读位置，条目偏移与正文 UTF-8 字节偏移分开记录。 */
export interface CursorPosition extends JsonObject {
  /** 结果流的零基条目偏移，供下一页继续读取。 */
  itemOffset: number
  /** 当前正文中的 UTF-8 字节偏移，只能落在码点边界。 */
  bodyByteOffset?: number
}

/** 绑定协议、查询、知识快照与续读位置的游标核心数据。 */
interface CursorCore extends JsonObject {
  /** 生成游标时使用的 Runtime 协议标识。 */
  format: number
  /** 请求分派目标或响应所属能力。 */
  capability: string
  /** 请求参数的确定性指纹，用于拒绝跨查询复用游标。 */
  inputFingerprint: string
  /** 完整正式或候选 Context 文件树的 SHA-256 指纹。 */
  contextFingerprint: string
  /** 本次数据来源或活动事务状态的指纹。 */
  stateFingerprint: string
  /** 结果流的零基条目偏移，供下一页继续读取。 */
  itemOffset: number
  /** 当前正文中的 UTF-8 字节偏移，只能落在码点边界。 */
  bodyByteOffset?: number
}

/** 附带完整性哈希的游标载荷；哈希不代表身份认证。 */
interface CursorPayload extends CursorCore {
  /** 游标核心数据的完整性哈希，不是签名或认证凭据。 */
  integrityHash: string
}

/** 构造与查询输入和快照指纹绑定的游标核心。 */
function cursorCore(
  capability: Capability,
  input: CapabilityInput,
  contextFingerprint: string,
  stateFingerprint: string,
  position: CursorPosition,
): CursorCore {
  return {
    format: FORMAT,
    capability,
    inputFingerprint: sha256(compactJson(input as JsonValue)),
    contextFingerprint,
    stateFingerprint,
    itemOffset: position.itemOffset,
    ...(position.bodyByteOffset === undefined ? {} : { bodyByteOffset: position.bodyByteOffset }),
  }
}

/**
 * 把查询快照与续读位置编码为带完整性检查的 opaque 游标。
 *
 * @param capability - 响应或游标所属的能力名称。
 * @param input - 当前能力的已解析输入。
 * @param contextFingerprint - 完整 Context 树的当前指纹。
 * @param stateFingerprint - 本次查询额外依赖的数据状态指纹。
 * @param position - 结果条目与可选正文字节偏移。
 * @returns base64url 编码的续读令牌，绑定查询与快照但不提供身份认证。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：请求解析、响应构造或分页续读；纯协议计算，不读写正式知识。
 */
export function encodeCursor(
  capability: Capability,
  input: CapabilityInput,
  contextFingerprint: string,
  stateFingerprint: string,
  position: CursorPosition,
): string {
  // 绑定查询与快照的游标核心内容。
  const core = cursorCore(capability, input, contextFingerprint, stateFingerprint, position)
  // 附加完整性校验值后的游标载荷。
  const payload: CursorPayload = { ...core, integrityHash: sha256(compactJson(core as JsonValue)) }
  return Buffer.from(compactJson(payload), 'utf8').toString('base64url')
}

/**
 * 校验游标编码、完整性、查询和快照绑定，恢复续读位置。
 *
 * @param cursor - 前一页返回的续读令牌；首轮调用可不提供。
 * @param capability - 响应或游标所属的能力名称。
 * @param input - 当前能力的已解析输入。
 * @param contextFingerprint - 完整 Context 树的当前指纹。
 * @param stateFingerprint - 本次查询额外依赖的数据状态指纹。
 * @returns 已验证的续读位置；未提供游标时从首条开始。
 * @throws 编码错误抛出 CURSOR_INVALID；查询、快照或完整性不匹配抛出 CURSOR_STALE。
 * @remarks 调用阶段：请求解析、响应构造或分页续读；纯协议计算，不读写正式知识。
 */
export function decodeCursor(
  cursor: string | undefined,
  capability: Capability,
  input: CapabilityInput,
  contextFingerprint: string,
  stateFingerprint: string,
): CursorPosition {
  if (cursor === undefined)
    return { itemOffset: 0 }
  if (!/^[\w-]+$/.test(cursor))
    throw new RuntimeFault('CURSOR_INVALID', 'The continuation cursor is malformed or has been tampered with.')
  // 经过当前层格式校验的数据，供后续语义判断使用。
  let parsed: unknown
  try {
    // 本次读取或编码的原始字节序列。
    const bytes = Buffer.from(cursor, 'base64url')
    if (bytes.toString('base64url') !== cursor)
      throw new Error('non-canonical base64url')
    parsed = JSON.parse(bytes.toString('utf8'))
  }
  catch {
    throw new RuntimeFault('CURSOR_INVALID', 'The continuation cursor is malformed or has been tampered with.')
  }
  if (!isRecord(parsed))
    throw new RuntimeFault('CURSOR_INVALID', 'The continuation cursor is malformed or has been tampered with.')
  // 待验证对象实际包含的字段名集合。
  const keys = Object.keys(parsed).sort(compareCodeUnits)
  // 当前协议形状要求的完整字段名集合。
  const expectedKeys = [
    'capability',
    'contextFingerprint',
    'inputFingerprint',
    'integrityHash',
    'itemOffset',
    'format',
    'stateFingerprint',
    ...(parsed.bodyByteOffset === undefined ? [] : ['bodyByteOffset']),
  ].sort(compareCodeUnits)
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)
    || typeof parsed.integrityHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(parsed.integrityHash)
    || !Number.isSafeInteger(parsed.itemOffset)
    || (parsed.itemOffset as number) < 0
    || (parsed.bodyByteOffset !== undefined
      && (!Number.isSafeInteger(parsed.bodyByteOffset) || (parsed.bodyByteOffset as number) < 0))) {
    throw new RuntimeFault('CURSOR_INVALID', 'The continuation cursor is malformed or has been tampered with.')
  }
  // 校验后的续读位置，首次调用从零开始。
  const position: CursorPosition = {
    itemOffset: parsed.itemOffset as number,
    ...(parsed.bodyByteOffset === undefined ? {} : { bodyByteOffset: parsed.bodyByteOffset as number }),
  }
  // 绑定查询与快照的游标核心内容。
  const core = cursorCore(capability, input, contextFingerprint, stateFingerprint, position)
  // 基于当前查询和快照重新计算的完整性哈希字节。
  const expected = Buffer.from(sha256(compactJson(core as JsonValue)), 'hex')
  // 游标中记录的完整性哈希字节，参与定时安全比较。
  const actual = Buffer.from(parsed.integrityHash, 'hex')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new RuntimeFault('CURSOR_STALE', 'The continuation cursor does not match this query or Context tree.')
  if (parsed.format !== core.format
    || parsed.capability !== core.capability
    || parsed.inputFingerprint !== core.inputFingerprint
    || parsed.contextFingerprint !== core.contextFingerprint
    || parsed.stateFingerprint !== core.stateFingerprint) {
    throw new RuntimeFault('CURSOR_STALE', 'The continuation cursor does not match this query or Context tree.')
  }
  return position
}

/**
 * 按紧凑 JSON 的 UTF-8 字节数估算响应 token 数。
 *
 * @param value - 待校验或规范化的输入值。
 * @returns 紧凑 JSON 字节数除以三后向上取整的估算值。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：请求解析、响应构造或分页续读；纯协议计算，不读写正式知识。
 */
export function estimateTokens(value: JsonValue): number {
  return Math.ceil(Buffer.byteLength(compactJson(value), 'utf8') / 3)
}

/** 一次预算分页的条目和可选续读位置。 */
export interface Page<T extends JsonValue> {
  /** 本页已通过全部预算检查的完整结果条目。 */
  readonly items: readonly T[]
  /** 下页应继续的位置；缺省表示结果流已完成。 */
  readonly nextPosition?: CursorPosition
}

/** 分页器用于构造真实响应及游标的调用方适配器。 */
export interface PaginationEnvelope<T extends JsonValue> {
  /** 把当前页条目组成完整响应的调用方回调。 */
  readonly response: (items: readonly T[], cursor?: string) => RuntimeResponse
  /** 绑定查询与快照的续读令牌，不是写入授权。 */
  readonly cursor: (position: CursorPosition) => string
}

/**
 * 检查完整响应是否同时满足字节与 token 预算。
 *
 * @param response - 按正文片段构造完整响应的回调。
 * @param budget - 当前响应允许的条目、字节和 token 上限。
 * @returns 完整响应的字节数及估算 token 数是否均在预算内。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：请求解析、响应构造或分页续读；纯协议计算，不读写正式知识。
 */
export function responseFits(response: RuntimeResponse, budget: Budget): boolean {
  // 从当前对象取得、尚待类型与内容校验的字段值。
  const value = response as unknown as JsonValue
  return Buffer.byteLength(stableJson(value), 'utf8') <= budget.bytes
    && estimateTokens(value) <= budget.estimatedTokens
}

/**
 * 按真实响应体积应用各维度预算，避免静默截断或无进展游标。
 *
 * @param items - 按确定顺序排列的待分页条目。
 * @param position - 结果条目与可选正文字节偏移。
 * @param budget - 当前响应允许的条目、字节和 token 上限。
 * @param envelope - 由调用方提供的完整响应及游标构造回调。
 * @returns 本页条目与可选下一位置，不静默丢弃未返回条目。
 * @throws 预算不足以容纳首条或封套时抛出 BUDGET_TOO_SMALL；单条超过硬限制时抛出 RESULT_ITEM_TOO_LARGE。
 * @remarks 调用阶段：请求解析、响应构造或分页续读；纯协议计算，不读写正式知识。
 */
export function paginate<T extends JsonValue>(
  items: readonly T[],
  position: CursorPosition,
  budget: Budget,
  envelope: PaginationEnvelope<T>,
): Page<T> {
  if (position.bodyByteOffset !== undefined)
    throw new RuntimeFault('CURSOR_INVALID', 'The continuation cursor points inside a body where only whole items are valid.')
  if (position.itemOffset > items.length)
    throw new RuntimeFault('CURSOR_INVALID', 'The continuation cursor points beyond the current result stream.')
  // 当前页已选中的条目，追加前按真实封套计算预算。
  const selected: T[] = []
  // 已构建的内部角色调用索引文本。
  let index = Math.min(position.itemOffset, items.length)
  for (; index < items.length; index += 1) {
    // 当前业务结果条目。
    const item = items[index] as T
    if (selected.length >= budget.items)
      break
    // 本次正在校验或推导的候选值。
    const candidate = [...selected, item]
    // 仍有未返回内容时应继续读取的位置。
    const nextPosition = index + 1 < items.length ? { itemOffset: index + 1 } : undefined
    // 下一页的续读令牌；缺省表示当前结果已读完。
    const cursor = nextPosition === undefined ? undefined : envelope.cursor(nextPosition)
    if (!responseFits(envelope.response(candidate, cursor), budget)) {
      if (selected.length === 0) {
        if (!responseFits(envelope.response([item], cursor), MAX_BUDGET))
          throw new RuntimeFault('RESULT_ITEM_TOO_LARGE', 'A single result item exceeds the Runtime output hard limits.')
        throw new RuntimeFault('BUDGET_TOO_SMALL', 'The requested output budget cannot contain the next complete result item.')
      }
      break
    }
    selected.push(item)
  }
  // 应用响应预算后选出的当前结果页。
  const page: Page<T> = { items: selected, ...(index < items.length ? { nextPosition: { itemOffset: index } } : {}) }
  // 下一页的续读令牌；缺省表示当前结果已读完。
  const cursor = page.nextPosition === undefined ? undefined : envelope.cursor(page.nextPosition)
  if (!responseFits(envelope.response(page.items, cursor), budget))
    throw new RuntimeFault('BUDGET_TOO_SMALL', 'The requested output budget cannot contain the required response envelope.')
  return page
}

/** 正文的 UTF-8 字节区间及对应文本，标明是否已读完。 */
export interface BodyChunk extends JsonObject {
  /** 当前条目或片段的文本内容。 */
  text: string
  /** 片段在完整正文中的起始 UTF-8 字节偏移，包含该位置。 */
  startByte: number
  /** 片段结束的 UTF-8 字节偏移，不包含该位置。 */
  endByte: number
  /** 完整正文的 UTF-8 字节总数。 */
  totalBytes: number
  /** 是否已到达当前正文末尾，不表示整个查询已结束。 */
  complete: boolean
}

/**
 * 在 Unicode 码点边界寻找满足响应预算的最大正文片段。
 *
 * @param body - 不含 front matter 的正文文本。
 * @param startByte - 从正文起点计算的 UTF-8 字节偏移。
 * @param budget - 当前响应允许的条目、字节和 token 上限。
 * @param response - 按正文片段构造完整响应的回调。
 * @param cursor - 前一页返回的续读令牌；首轮调用可不提供。
 * @returns 最大可容纳的正文片段与准确字节边界，至少推进一个码点。
 * @throws 偏移不在有效边界或预算无法推进时抛出 RuntimeFault，不返回停滞游标。
 * @remarks 调用阶段：请求解析、响应构造或分页续读；纯协议计算，不读写正式知识。
 */
export function fitBodyChunk(
  body: string,
  startByte: number,
  budget: Budget,
  response: (chunk: BodyChunk, cursor?: string) => RuntimeResponse,
  cursor: (endByte: number) => string | undefined,
): BodyChunk {
  // 正文各 Unicode 码点对应的累计 UTF-8 字节边界。
  const boundaries = [0]
  // 已扫描正文的累计 UTF-8 字节数。
  let byteOffset = 0
  for (const codePoint of body) {
    byteOffset += Buffer.byteLength(codePoint, 'utf8')
    boundaries.push(byteOffset)
  }
  // 起始字节偏移在码点边界数组中的位置。
  const startIndex = boundaries.indexOf(startByte)
  if (startIndex < 0 || startIndex === boundaries.length - 1)
    throw new RuntimeFault('CURSOR_INVALID', 'The continuation cursor does not point to a valid UTF-8 body boundary.')

  /** 根据字节边界构造正文片段及完成标记。 */
  const makeChunk = (endIndex: number): BodyChunk => {
    // 当前片段结束的 UTF-8 字节偏移，不包含该位置。
    const endByte = boundaries[endIndex] as number
    // 当前片段是否覆盖到正文末尾。
    const complete = endByte === byteOffset
    return {
      text: Buffer.from(body, 'utf8').subarray(startByte, endByte).toString('utf8'),
      startByte,
      endByte,
      totalBytes: byteOffset,
      complete,
    }
  }
  /** 检查给定结束边界构造的完整响应是否满足指定预算。 */
  const fitsAt = (endIndex: number, limit: Budget): boolean => {
    // 用于计算完整响应体积的临时正文片段。
    const chunk = makeChunk(endIndex)
    return responseFits(response(chunk, cursor(chunk.endByte)), limit)
  }
  if (!fitsAt(startIndex + 1, MAX_BUDGET))
    throw new RuntimeFault('RESULT_ITEM_TOO_LARGE', 'A body code point and its result envelope exceed the Runtime output hard limits.')
  if (!fitsAt(startIndex + 1, budget))
    throw new RuntimeFault('BUDGET_TOO_SMALL', 'The requested output budget cannot contain a progressing body chunk.')

  // 二分搜索中已知能够放入预算的结束边界下界。
  let low = startIndex + 1
  // 二分搜索中尚需检查的结束边界上界。
  let high = boundaries.length - 1
  while (low < high) {
    // 本轮二分搜索试探的正文结束边界。
    const middle = Math.ceil((low + high) / 2)
    if (fitsAt(middle, budget))
      low = middle
    else
      high = middle - 1
  }
  return makeChunk(low)
}
