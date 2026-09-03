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
import { defineExtension } from '@aaplugin/kit/sdk'
import { PLATFORM_ID as CLAUDE_CODE } from '@aaplugin/platform-claude-code'
import { PLATFORM_ID as CODEX } from '@aaplugin/platform-codex'

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
  contribute(
    _context: ContributionContext,
    roles: Readonly<readonly InternalRole[]>,
  ): PackageContribution<ClaudePackageComponent> {
    return {
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

function codexRoleResource(role: InternalRole): string {
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

const codexContributor: PlatformContributor<readonly InternalRole[], JsonObject> = Object.freeze({
  platform: CODEX,
  platformApiVersion: '1' as const,
  async contribute(
    context: ContributionContext,
    roles: Readonly<readonly InternalRole[]>,
  ): Promise<PackageContribution<JsonObject>> {
    const assets = []
    for (const role of roles) {
      assets.push({
        path: `runtime/agents/${role.id}.md`,
        asset: await context.assets.fromBytes({
          bytes: codexRoleResource(role),
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
        reason: 'Codex consumes the canonical role inline from a private runtime resource.',
      })),
    }
  },
})

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
        contributors: [claudeContributor, codexContributor] as readonly PlatformContributor<readonly InternalRole[], JsonObject>[],
      }
    },
  })
}
