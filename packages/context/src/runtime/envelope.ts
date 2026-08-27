import type { Budget, JsonObject } from './types.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { SCRATCH_ROOT } from './constants.js'

/** The three Internal Roles. */
export const ROLES = ['investigator', 'reflector', 'recorder'] as const

/** One Internal Role. */
export type Role = typeof ROLES[number]

/** How the host will execute the role. */
export type Execution = 'native-agent' | 'inline'

/** Everything one role invocation needs. */
export interface TaskEnvelope {
  readonly role: Role
  readonly goal: string
  readonly scope: JsonObject
  readonly runId?: string
  readonly sourceState?: string
  readonly inputs: readonly string[]
  readonly allowedReads: readonly string[]
  readonly allowedWrites: readonly string[]
  readonly outputContract: string
  readonly budget: Budget
  readonly stopConditions: readonly string[]
  /**
   * The authoritative role text.
   *
   * Present only where the host cannot dispatch a native agent. On Claude Code the same text
   * is already installed as a native Agent, so repeating it would duplicate the contract in
   * two places that could drift.
   */
  readonly roleBody?: string
}

/** Where each role may write. Everything else is read-only to it. */
const WRITE_ROOTS: Readonly<Record<Role, readonly string[]>> = {
  investigator: [`${SCRATCH_ROOT}/investigations`],
  reflector: [`${SCRATCH_ROOT}/feedback`],
  recorder: [`${SCRATCH_ROOT}/runs`],
}

/** Default stop conditions, phrased so a role can check them itself. */
const STOP_CONDITIONS: Readonly<Record<Role, readonly string[]>> = {
  investigator: [
    'Answering requires reading outside the allowed paths.',
    'The evidence contradicts itself and cannot be reconciled.',
    'The budget is exhausted before the questions are answered.',
  ],
  reflector: [
    'The candidate is a one-off with no reusable pattern.',
    'Recording it would require copying a transcript.',
  ],
  recorder: [
    'The evidence does not support the change.',
    'The change would leave uniquely locatable knowledge unreachable.',
    'The change would move outside the authorized scope.',
  ],
}

/** What each role must return. */
const OUTPUT_CONTRACTS: Readonly<Record<Role, string>> = {
  investigator: 'A report separating confirmed facts with evidence locations, inferences, unverified assumptions, and unknowns.',
  reflector: 'A temporary feedback entry with context, observed behavior, outcome, attempted correction, and reusability limits.',
  recorder: 'A transaction candidate, with every create, rewrite, merge, split, and delete accounted for.',
}

/** Inputs needed to build an envelope. */
export interface EnvelopeRequest {
  readonly role: Role
  readonly goal: string
  readonly scope?: JsonObject
  readonly runId?: string
  readonly sourceState?: string
  readonly inputs?: readonly string[]
  readonly allowedReads?: readonly string[]
  readonly budget?: Budget
  /** How the calling host executes roles. */
  readonly execution: Execution
}

/** @returns whether a string is a usable role name. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

/**
 * Reads the role body a host needs when it cannot dispatch a native agent.
 *
 * @param pluginRoot absolute plugin installation root.
 * @param role the role.
 * @returns the role body, or undefined when the resource is absent.
 */
export async function readRoleBody(pluginRoot: string, role: Role): Promise<string | undefined> {
  try {
    const source = await fs.readFile(path.join(pluginRoot, 'runtime', 'agents', `${role}.md`), 'utf8')
    const body = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(source)?.[1]
    return body === undefined ? source.trim() : body.trim()
  }
  catch {
    return undefined
  }
}

/**
 * Builds the task envelope for one role invocation.
 *
 * The envelope is identical on both platforms except for `roleBody`. That single difference is
 * the whole platform gap: Claude dispatches an installed Agent into its own context, Codex
 * executes the same text inline in the main context. Everything else — goal, scope, allowed
 * paths, output contract, budget, stop conditions — is shared, so the two hosts cannot drift.
 *
 * @param request what the caller wants the role to do.
 * @param roleBody authoritative role text, required for inline execution.
 * @returns the envelope.
 */
export function buildEnvelope(request: EnvelopeRequest, roleBody?: string): TaskEnvelope {
  return {
    role: request.role,
    goal: request.goal,
    scope: request.scope ?? {},
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    ...(request.sourceState === undefined ? {} : { sourceState: request.sourceState }),
    inputs: [...(request.inputs ?? [])],
    allowedReads: [...(request.allowedReads ?? ['.'])],
    allowedWrites: [...WRITE_ROOTS[request.role]],
    outputContract: OUTPUT_CONTRACTS[request.role],
    budget: request.budget ?? { items: 40, bytes: 512 * 1024, estimatedTokens: 60_000 },
    stopConditions: [...STOP_CONDITIONS[request.role]],
    ...(request.execution === 'inline' && roleBody !== undefined ? { roleBody } : {}),
  }
}

/** @returns an envelope as a JSON payload. */
export function envelopeToJson(envelope: TaskEnvelope): JsonObject {
  return {
    role: envelope.role,
    goal: envelope.goal,
    scope: envelope.scope,
    ...(envelope.runId === undefined ? {} : { runId: envelope.runId }),
    ...(envelope.sourceState === undefined ? {} : { sourceState: envelope.sourceState }),
    inputs: [...envelope.inputs],
    allowedReads: [...envelope.allowedReads],
    allowedWrites: [...envelope.allowedWrites],
    outputContract: envelope.outputContract,
    budget: {
      ...(envelope.budget.items === undefined ? {} : { items: envelope.budget.items }),
      ...(envelope.budget.bytes === undefined ? {} : { bytes: envelope.budget.bytes }),
      ...(envelope.budget.estimatedTokens === undefined ? {} : { estimatedTokens: envelope.budget.estimatedTokens }),
    },
    stopConditions: [...envelope.stopConditions],
    ...(envelope.roleBody === undefined ? {} : { roleBody: envelope.roleBody }),
  }
}
