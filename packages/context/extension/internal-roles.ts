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
import type {
  ClaudePackageComponent,
} from '@aaplugin/platform-claude-code'
import type { InternalRoleSource } from './internal-role-parser.js'
import { defineExtension } from '@aaplugin/kit/sdk'
import { PLATFORM_ID as CLAUDE_CODE } from '@aaplugin/platform-claude-code'
import { PLATFORM_ID as CODEX } from '@aaplugin/platform-codex'
import { parseInternalRole } from './internal-role-parser.js'

/** The exact Internal Roles this product defines. */
const REQUIRED = ['investigator', 'recorder', 'reflector'] as const

/** Extension-owned source root, relative to the canonical source directory. */
const ROOT = 'internal-roles'

/** @returns code-unit ordering, so output never depends on the host locale. */
function compare(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

/**
 * Renders a role as a Codex-private runtime resource.
 *
 * This is product data read back through the runtime protocol. It is deliberately not a Skill,
 * not an Agent, and not a runtime entry: Codex plugins cannot register agents, and generating
 * an `agent-*` Skill would claim a capability the host does not have.
 *
 * @param role the parsed role.
 * @returns the file contents.
 */
function codexResource(role: InternalRoleSource): string {
  const header = [
    '---',
    `id: ${role.id}`,
    `description: ${role.description}`,
    'delivery: private-runtime-resource',
    '---',
  ].join('\n')
  return `${header}\n\n${role.body}\n`
}

/** Discovers role sources from the Extension's exclusive root. */
async function discover(context: ExtensionDiscoverContext): Promise<readonly InternalRoleSource[]> {
  const directory = context.roots[ROOT]
  if (directory === undefined)
    return []

  const roles: InternalRoleSource[] = []
  for (const entry of await context.sources.list(directory)) {
    if (entry.type !== 'file' || !entry.name.endsWith('.md'))
      throw new Error(`Internal Role sources must be flat Markdown files; found "${entry.name}".`)

    const role = parseInternalRole(await context.sources.readText(entry.file), entry.name)
    if (`${role.id}.md` !== entry.name)
      throw new Error(`Internal Role id must match its filename; "${entry.name}" declares "${role.id}".`)
    roles.push(role)
  }
  return roles.sort((left, right) => compare(left.id, right.id))
}

/** Subject declaration returned by validation. */
interface RoleSubject {
  readonly subject: string
  readonly capabilities: readonly string[]
}

/** Validates that exactly the three required roles exist, and declares their subjects. */
function validate(
  context: ExtensionValidateContext,
  roles: Readonly<readonly InternalRoleSource[]>,
): { readonly state: readonly InternalRoleSource[], readonly subjects: readonly RoleSubject[] } {
  const ids = roles.map(role => role.id)
  if (ids.join(' ') !== [...REQUIRED].join(' ')) {
    context.diagnostics.report({
      code: 'CONTEXT_ROLE_SET_INVALID',
      severity: 'error',
      message: `Exactly ${REQUIRED.join(', ')} Internal Roles are required.`,
      hint: 'Add or remove a file under the internal-roles source root so the set matches exactly.',
    })
  }

  /** A canonical Agent with the same ID would collide during Claude finalization. */
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

/**
 * Contributes Claude Code native Agents.
 *
 * The payload is the Platform's own public component type. Claude validates it, renders
 * `agents/<id>.md`, and writes the manifest field itself, so this contributor must not emit
 * the asset or patch the document.
 */
const claudeContributor: PlatformContributor<readonly InternalRoleSource[], ClaudePackageComponent> = Object.freeze({
  platform: CLAUDE_CODE,
  platformApiVersion: '1' as const,
  contribute(
    _context: ContributionContext,
    roles: Readonly<readonly InternalRoleSource[]>,
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
          ...(role.tools.length === 0 ? {} : { tools: role.tools }),
        },
      })),
      compatibility: roles.map(role => ({
        subject: `internal-role:${role.id}`,
        capability: 'role-delivery',
        level: 'native' as const,
        reason: 'Claude Code receives the role as a native Agent with its own context.',
      })),
    }
  },
})

/**
 * Contributes Codex private runtime resources.
 *
 * Codex rejects any non-empty Platform Component Contribution, so the role travels as an
 * ordinary Extension-owned asset instead. The path cannot collide with the Core runtime
 * output because the runtime entry key is `context`, never `agents`.
 */
const codexContributor: PlatformContributor<readonly InternalRoleSource[], JsonObject> = Object.freeze({
  platform: CODEX,
  platformApiVersion: '1' as const,
  async contribute(
    context: ContributionContext,
    roles: Readonly<readonly InternalRoleSource[]>,
  ): Promise<PackageContribution<JsonObject>> {
    const assets = []
    for (const role of roles) {
      assets.push({
        path: `runtime/agents/${role.id}.md`,
        asset: await context.assets.fromBytes({
          bytes: codexResource(role),
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
        reason: 'Codex plugins cannot register agents, so the role is delivered as runtime data and executed inline.',
      })),
    }
  },
})

/** Creates the Internal Roles Extension. */
export default function internalRoles(): Extension<
  JsonObject,
  readonly InternalRoleSource[],
  readonly InternalRoleSource[],
  readonly InternalRoleSource[]
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
        build: (_context: ExtensionBuildContext, roles: Readonly<readonly InternalRoleSource[]>) => ({ state: [...roles] }),
        contributors: [
          claudeContributor,
          codexContributor,
        ] as readonly PlatformContributor<readonly InternalRoleSource[], JsonObject>[],
      }
    },
  })
}
