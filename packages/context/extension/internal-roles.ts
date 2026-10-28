import type {
  ContributionContext,
  Extension,
  ExtensionBuildContext,
  ExtensionDiscoverContext,
  ExtensionValidateContext,
  JsonObject,
  PackageContribution,
  PlatformContributor,
} from '@aaplugin/kit/sdk'
import type { ClaudePackageComponent } from '@aaplugin/platform-claude-code'
import type { CursorPackageComponent } from '@aaplugin/platform-cursor'
import type { OpenCodePackageComponent } from '@aaplugin/platform-opencode'
import { defineExtension } from '@aaplugin/kit/sdk'
import { PLATFORM_ID as ANTIGRAVITY } from '@aaplugin/platform-antigravity'
import { PLATFORM_ID as CLAUDE_CODE } from '@aaplugin/platform-claude-code'
import { PLATFORM_ID as CODEX } from '@aaplugin/platform-codex'
import { PLATFORM_ID as CURSOR } from '@aaplugin/platform-cursor'
import { PLATFORM_ID as OPENCODE } from '@aaplugin/platform-opencode'
import { PLATFORM_ID as PI } from '@aaplugin/platform-pi'

// Extension 独占的角色正文资源根目录。
const ROOT = 'internal-roles'

/** Extension 拥有的角色身份、模型偏好和工具说明。 */
interface RoleMetadata {
  /** Extension 固定角色身份，决定规范资源文件名。 */
  readonly id: 'investigator' | 'recorder' | 'reflector'
  /** 便于路由和选择的简短说明。 */
  readonly description: string
  /** 宿主允许时采用的模型偏好，不是 Runtime 强制设置。 */
  readonly model: 'inherit' | 'capable'
  /** 角色的工具偏好或宿主原生声明，不替代写入范围授权。 */
  readonly tools: readonly string[]
}

/** 静态角色元数据与唯一的规范 Markdown 正文。 */
interface InternalRole extends RoleMetadata {
  /** 已规范化的文档正文，不包含 front matter。 */
  readonly body: string
}

/** Extension 固定角色集合及其跨平台模型、工具偏好。 */
const ROLE_METADATA: readonly RoleMetadata[] = Object.freeze([
  Object.freeze({
    id: 'investigator',
    description: 'Establish verifiable engineering facts from code, configuration, and history.',
    model: 'capable',
    tools: Object.freeze(['Read', 'Glob', 'Grep', 'Bash']),
  }),
  Object.freeze({
    id: 'recorder',
    description: 'Author and converge formal repository knowledge only in a transaction candidate.',
    model: 'capable',
    tools: Object.freeze(['Read', 'Glob', 'Grep', 'Write', 'Edit']),
  }),
  Object.freeze({
    id: 'reflector',
    description: 'Capture recurring engineering feedback as reusable temporary evidence.',
    model: 'inherit',
    tools: Object.freeze(['Read', 'Glob', 'Grep', 'Write']),
  }),
])

// 按规范文件名索引角色元数据，拒绝未知角色文件。
const METADATA_BY_FILE = new Map(ROLE_METADATA.map(role => [`${role.id}.md`, role]))

/** 按码元比较名称，使角色发现结果与区域设置无关。 */
function compare(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

/** 从 Extension 资源根读取且仅接受规定的角色 Markdown 文件。 */
async function discover(context: ExtensionDiscoverContext): Promise<readonly InternalRole[]> {
  // 本次操作拥有或读取的目录路径。
  const directory = context.roots[ROOT]
  if (directory === undefined)
    return []

  // 本次目录扫描或快照结果集合。
  const entries = await context.sources.list(directory)
  // 本次构建发现并持有的角色集合。
  const roles: InternalRole[] = []
  for (const entry of entries) {
    // 从规范角色文件名或 front matter 取得的交付元数据。
    const metadata = METADATA_BY_FILE.get(entry.name)
    if (metadata === undefined)
      throw new Error(`Unknown Internal Role source "${entry.name}".`)
    if (entry.type !== 'file')
      throw new Error(`Internal Role "${entry.name}" must be a regular UTF-8 Markdown file.`)
    // 当前文档正文，不包含 front matter。
    const body = await context.sources.readText(entry.file)
    if (body.trim().length === 0)
      throw new Error(`Internal Role "${entry.name}" must have a non-empty Markdown body.`)
    roles.push({ ...metadata, body })
  }
  return roles.sort((left, right) => compare(left.id, right.id))
}

/** 向构建器声明的角色资源主体及所需交付能力。 */
interface RoleSubject {
  /** 由 Extension 拥有的构建资源主体标识。 */
  readonly subject: string
  /** 该资源需要的平台能力名称。 */
  readonly capabilities: readonly string[]
}

/** 校验角色集合完整性和 Agent 命名冲突，通过构建诊断报告缺口。 */
function validate(
  context: ExtensionValidateContext,
  roles: Readonly<readonly InternalRole[]>,
): {
  /** 当前数据或所有权分支的判别值。 */
  readonly state: readonly InternalRole[]
  /** 提交给构建器进行兼容性判断的资源主体。 */
  readonly subjects: readonly RoleSubject[]
} {
  // Extension 规定必须完整交付的角色 ID 集合。
  const expected = ROLE_METADATA.map(role => role.id)
  // 本次实际发现的角色 ID 集合。
  const actual = roles.map(role => role.id)
  if (actual.join('\0') !== expected.join('\0')) {
    context.diagnostics.report({
      code: 'CONTEXT_ROLE_SET_INVALID',
      severity: 'error',
      message: `Exactly ${expected.join(', ')} Internal Roles are required.`,
      hint: 'Restore the exact canonical Markdown set under src/internal-roles/.',
    })
  }
  for (const role of roles) {
    if (context.project.agents.some(agent => agent.id === role.id)) {
      context.diagnostics.report({
        code: 'CONTEXT_ROLE_AGENT_COLLISION',
        severity: 'error',
        message: `Internal Role "${role.id}" collides with a canonical Agent of the same ID.`,
      })
    }
  }
  return {
    state: [...roles],
    subjects: roles.map(role => ({ subject: `internal-role:${role.id}`, capabilities: ['role-delivery'] })),
  }
}

// 将规范角色交付为 Claude Code 原生 Agent 的贡献器。
const claudeContributor: PlatformContributor<readonly InternalRole[], ClaudePackageComponent> = Object.freeze({
  platform: CLAUDE_CODE,
  platformApiVersion: '1' as const,
  /**
   * 在平台贡献阶段交付原生角色或私有资源，并返回调用索引及兼容性说明。
   *
   * @param context - AAPlugin 提供的当前构建阶段上下文。
   * @param roles - 由前置发现或校验阶段传入的角色集合。
   * @returns 平台组件、资源资产与兼容性事实，由构建器负责最终写入。
   * @throws 资源创建失败交由 AAPlugin 构建生命周期报告，不自行修改平台产物。
   * @remarks 调用阶段：由 AAPlugin 配置或对应构建生命周期调用；产物写入由框架负责。
   */
  async contribute(
    context: ContributionContext,
    roles: Readonly<readonly InternalRole[]>,
  ): Promise<PackageContribution<ClaudePackageComponent>> {
    return {
      assets: [await roleIndex(context, roles, CLAUDE_CODE, 'runtime', 'native')],
      components: roles.map(role => ({
        subject: `internal-role:${role.id}`,
        value: {
          kind: 'native-agent' as const,
          id: role.id,
          description: role.description,
          body: role.body,
          model: role.model,
          tools: role.tools,
        },
      })),
      compatibility: roles.map(role => ({
        subject: `internal-role:${role.id}`,
        capability: 'role-delivery',
        level: 'native' as const,
        reason: 'Claude Code receives the canonical role as a native Agent.',
      })),
    }
  },
})

/** 为不支持原生角色的宿主生成私有 Markdown 资源。 */
function privateRoleResource(role: InternalRole): string {
  return [
    '---',
    `id: ${role.id}`,
    `description: ${role.description}`,
    'delivery: private-runtime-resource',
    `model: ${role.model}`,
    `tools: ${role.tools.join(', ')}`,
    '---',
    '',
    role.body.replace(/\n*$/, ''),
    '',
  ].join('\n')
}

/** 生成 Extension 拥有的角色调用索引，使规范 Skill 不依赖宿主差异。 */
async function roleIndex(
  context: ContributionContext,
  roles: readonly InternalRole[],
  platform: string,
  directory: string,
  delivery: 'native' | 'inline',
) {
  // 根据宿主交付方式选择的角色调用说明。
  const guidance = delivery === 'native'
    ? [
        'Delegate the same Role Brief to the named native Agent. Agent definition paths below are relative to this index.',
        platform === CLAUDE_CODE
          ? 'Claude Code receives the role model and tool metadata through its native Agent configuration.'
          : platform === OPENCODE
            ? 'OpenCode uses its default model. Read/glob/grep are enabled; Investigator may use bash, Recorder and Reflector may use edit. The webfetch and task tools are disabled. Bash can still write files or access the network; the Brief governs those actions. Edit covers writing and editing; the Brief narrows allowed paths.'
            : 'Cursor uses its default model and tools. Model preferences and the listed tool names are guidance; this Plugin does not enforce per-role tool grants.',
      ]
    : [
        'Read the matching private Markdown resource relative to this index, then execute its Role Brief inline.',
        'Switch explicitly between Recorder authorship and Investigator review; do not present inline review as an independently executed Agent.',
        'Model preferences and tool names are guidance only; this delivery does not configure an independent model or restrict host tools.',
      ]
  // 生成角色调用索引所需的完整 Markdown 文本。
  const bytes = [
    '# Internal role invocation',
    '',
    `Platform: ${platform}.`,
    '',
    ...guidance,
    '',
    'Prefer a capable model for Investigator and Recorder when the host permits choosing one; Reflector may inherit. The Role Brief and Main Assistant remain the authority for allowed writes and final approval. Native tool settings do not enforce candidate-only filesystem access.',
    '',
    '| Role | Definition | Model preference | Tool guidance (Claude names) |',
    '| --- | --- | --- | --- |',
    ...roles.map(role => `| ${role.id} | [${role.id}](${delivery === 'native' ? '../../agents/' : './'}${role.id}.md) | ${role.model} | ${role.tools.join(', ')} |`),
    '',
  ].join('\n')
  return {
    path: `${directory}/agents/index.md`,
    asset: await context.assets.fromBytes({
      bytes,
      origin: { operation: 'internal-role-index', subjects: roles.map(role => `internal-role:${role.id}`) },
    }),
  }
}

// 将规范角色交付为 Cursor 原生 Agent 的贡献器。
const cursorContributor: PlatformContributor<readonly InternalRole[], CursorPackageComponent> = Object.freeze({
  platform: CURSOR,
  platformApiVersion: '1' as const,
  /**
   * 在平台贡献阶段交付原生角色或私有资源，并返回调用索引及兼容性说明。
   *
   * @param context - AAPlugin 提供的当前构建阶段上下文。
   * @param roles - 由前置发现或校验阶段传入的角色集合。
   * @returns 平台组件、资源资产与兼容性事实，由构建器负责最终写入。
   * @throws 资源创建失败交由 AAPlugin 构建生命周期报告，不自行修改平台产物。
   * @remarks 调用阶段：由 AAPlugin 配置或对应构建生命周期调用；产物写入由框架负责。
   */
  async contribute(
    context: ContributionContext,
    roles: Readonly<readonly InternalRole[]>,
  ): Promise<PackageContribution<CursorPackageComponent>> {
    return {
      assets: [await roleIndex(context, roles, CURSOR, 'runtime', 'native')],
      components: roles.map(role => ({
        subject: `internal-role:${role.id}`,
        value: { kind: 'native-agent' as const, id: role.id, description: role.description, body: role.body },
      })),
      compatibility: roles.map(role => ({
        subject: `internal-role:${role.id}`,
        capability: 'role-delivery',
        level: 'native' as const,
        reason: 'Cursor receives a native Agent; model and tool preferences remain invocation guidance.',
      })),
    }
  },
})

// 将规范角色交付为 OpenCode 原生子代理的贡献器。
const openCodeContributor: PlatformContributor<readonly InternalRole[], OpenCodePackageComponent> = Object.freeze({
  platform: OPENCODE,
  platformApiVersion: '1' as const,
  /**
   * 在平台贡献阶段交付原生角色或私有资源，并返回调用索引及兼容性说明。
   *
   * @param context - AAPlugin 提供的当前构建阶段上下文。
   * @param roles - 由前置发现或校验阶段传入的角色集合。
   * @returns 平台组件、资源资产与兼容性事实，由构建器负责最终写入。
   * @throws 资源创建失败交由 AAPlugin 构建生命周期报告，不自行修改平台产物。
   * @remarks 调用阶段：由 AAPlugin 配置或对应构建生命周期调用；产物写入由框架负责。
   */
  async contribute(
    context: ContributionContext,
    roles: Readonly<readonly InternalRole[]>,
  ): Promise<PackageContribution<OpenCodePackageComponent>> {
    return {
      assets: [await roleIndex(context, roles, OPENCODE, '.opencode/runtime', 'native')],
      components: roles.map(role => ({
        subject: `internal-role:${role.id}`,
        value: {
          kind: 'native-agent' as const,
          id: role.id,
          description: role.description,
          body: role.body,
          tools: {
            read: true,
            glob: true,
            grep: true,
            edit: role.tools.includes('Write') || role.tools.includes('Edit'),
            bash: role.tools.includes('Bash'),
            webfetch: false,
            task: false,
          },
        },
      })),
      compatibility: roles.map(role => ({
        subject: `internal-role:${role.id}`,
        capability: 'role-delivery',
        level: 'native' as const,
        reason: 'OpenCode receives a native Subagent with native tools and permissions; model preference and write scope remain guidance.',
      })),
    }
  },
})

/** 为使用私有 Markdown 的平台创建资源贡献器。 */
function privateContributor(platform: string): PlatformContributor<readonly InternalRole[], JsonObject> {
  return Object.freeze({
    platform,
    platformApiVersion: '1' as const,
    /**
     * 在平台贡献阶段交付原生角色或私有资源，并返回调用索引及兼容性说明。
     *
     * @param context - AAPlugin 提供的当前构建阶段上下文。
     * @param roles - 由前置发现或校验阶段传入的角色集合。
     * @returns 平台组件、资源资产与兼容性事实，由构建器负责最终写入。
     * @throws 资源创建失败交由 AAPlugin 构建生命周期报告，不自行修改平台产物。
     * @remarks 调用阶段：由 AAPlugin 配置或对应构建生命周期调用；产物写入由框架负责。
     */
    async contribute(context: ContributionContext, roles: Readonly<readonly InternalRole[]>) {
      // 本次平台贡献器要交给构建器的资源资产集合。
      const assets = [await roleIndex(context, roles, platform, 'runtime', 'inline')]
      for (const role of roles) {
        assets.push({
          path: `runtime/agents/${role.id}.md`,
          asset: await context.assets.fromBytes({
            bytes: privateRoleResource(role),
            origin: { operation: 'internal-role-resource', subjects: [`internal-role:${role.id}`] },
          }),
        })
      }
      return {
        assets,
        compatibility: roles.map(role => ({
          subject: `internal-role:${role.id}`,
          capability: 'role-delivery',
          level: 'transform' as const,
          transformation: 'private-runtime-resource',
          reason: `${platform} consumes the canonical role inline from a private runtime resource.`,
        })),
      }
    },
  })
}

/**
 * 创建内部角色 Extension，由六个平台贡献器交付同一份角色正文。
 *
 * @returns 交由 AAPlugin 管理生命周期与平台交付的 Extension 配置。
 * @throws 合法类型输入下不主动抛出业务异常。
 * @remarks 调用阶段：由 AAPlugin 配置或对应构建生命周期调用；产物写入由框架负责。
 */
export default function internalRoles(): Extension<
  JsonObject,
  readonly InternalRole[],
  readonly InternalRole[],
  readonly InternalRole[]
> {
  return defineExtension({
    id: 'internal-roles',
    apiVersion: '1',
    options: {},
    resourceRoots: [ROOT],
    /**
     * 为本次构建创建独立发现、校验、构建与平台贡献阶段。
     *
     * @returns 本次构建独立使用的生命周期处理器与平台贡献器。
     * @throws 合法类型输入下不主动抛出业务异常。
     * @remarks 调用阶段：由 AAPlugin 配置或对应构建生命周期调用；产物写入由框架负责。
     */
    createSession() {
      return {
        discover,
        validate,
        /** 将已校验角色复制为本次构建状态，避免跨会话共享可变集合。 */
        build: (_context: ExtensionBuildContext, roles: Readonly<readonly InternalRole[]>) => ({ state: [...roles] }),
        contributors: [
          claudeContributor,
          privateContributor(CODEX),
          cursorContributor,
          privateContributor(ANTIGRAVITY),
          openCodeContributor,
          privateContributor(PI),
        ] as readonly PlatformContributor<readonly InternalRole[], JsonObject>[],
      }
    },
  })
}
