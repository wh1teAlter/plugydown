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

const ROOT = 'internal-roles'

interface RoleMetadata {
  readonly id: 'investigator' | 'recorder' | 'reflector'
  readonly description: string
  readonly model: 'inherit' | 'capable'
  readonly tools: readonly string[]
}

interface InternalRole extends RoleMetadata {
  readonly body: string
}

/** Static platform metadata for the exact role set owned by this Extension. */
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

const METADATA_BY_FILE = new Map(ROLE_METADATA.map(role => [`${role.id}.md`, role]))

function compare(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

async function discover(context: ExtensionDiscoverContext): Promise<readonly InternalRole[]> {
  const directory = context.roots[ROOT]
  if (directory === undefined)
    return []

  const entries = await context.sources.list(directory)
  const roles: InternalRole[] = []
  for (const entry of entries) {
    const metadata = METADATA_BY_FILE.get(entry.name)
    if (metadata === undefined)
      throw new Error(`Unknown Internal Role source "${entry.name}".`)
    if (entry.type !== 'file')
      throw new Error(`Internal Role "${entry.name}" must be a regular UTF-8 Markdown file.`)
    const body = await context.sources.readText(entry.file)
    if (body.trim().length === 0)
      throw new Error(`Internal Role "${entry.name}" must have a non-empty Markdown body.`)
    roles.push({ ...metadata, body })
  }
  return roles.sort((left, right) => compare(left.id, right.id))
}

interface RoleSubject {
  readonly subject: string
  readonly capabilities: readonly string[]
}

function validate(
  context: ExtensionValidateContext,
  roles: Readonly<readonly InternalRole[]>,
): { readonly state: readonly InternalRole[], readonly subjects: readonly RoleSubject[] } {
  const expected = ROLE_METADATA.map(role => role.id)
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

const claudeContributor: PlatformContributor<readonly InternalRole[], ClaudePackageComponent> = Object.freeze({
  platform: CLAUDE_CODE,
  platformApiVersion: '1' as const,
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

/** An Extension-owned index lets the canonical Skill stay independent of host invocation rules. */
async function roleIndex(
  context: ContributionContext,
  roles: readonly InternalRole[],
  platform: string,
  directory: string,
  delivery: 'native' | 'inline',
) {
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

const cursorContributor: PlatformContributor<readonly InternalRole[], CursorPackageComponent> = Object.freeze({
  platform: CURSOR,
  platformApiVersion: '1' as const,
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

const openCodeContributor: PlatformContributor<readonly InternalRole[], OpenCodePackageComponent> = Object.freeze({
  platform: OPENCODE,
  platformApiVersion: '1' as const,
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

function privateContributor(platform: string): PlatformContributor<readonly InternalRole[], JsonObject> {
  return Object.freeze({
    platform,
    platformApiVersion: '1' as const,
    async contribute(context: ContributionContext, roles: Readonly<readonly InternalRole[]>) {
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
    createSession() {
      return {
        discover,
        validate,
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
