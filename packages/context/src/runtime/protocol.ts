import type { Budget, Capability, Diagnostic, JsonObject, RuntimeRequest, RuntimeResponse, Status } from './types.js'
import { CAPABILITIES, PROTOCOL } from './constants.js'
import { CODES, RuntimeError } from './errors.js'

/** Capability lookup used to reject unknown names before any work happens. */
const KNOWN = new Set<string>(CAPABILITIES)

/** @returns whether a value is a plain JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @returns a non-empty string, or undefined when the field is absent. */
function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined)
    return undefined
  if (typeof value !== 'string' || value.length === 0)
    throw new RuntimeError(CODES.REQUEST_MALFORMED, `Request field "${field}" must be a non-empty string.`)
  return value
}

/** @returns a JSON object, or undefined when the field is absent. */
function optionalObject(value: unknown, field: string): JsonObject | undefined {
  if (value === undefined)
    return undefined
  if (!isObject(value))
    throw new RuntimeError(CODES.REQUEST_MALFORMED, `Request field "${field}" must be an object.`)
  return value as JsonObject
}

/** @returns a validated budget, or undefined when the field is absent. */
function optionalBudget(value: unknown): Budget | undefined {
  const raw = optionalObject(value, 'budget')
  if (raw === undefined)
    return undefined

  const budget: { -readonly [K in keyof Budget]: Budget[K] } = {}
  for (const field of ['items', 'bytes', 'estimatedTokens'] as const) {
    const limit = raw[field]
    if (limit === undefined)
      continue
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)
      throw new RuntimeError(CODES.REQUEST_MALFORMED, `Budget field "${field}" must be a positive integer.`)
    budget[field] = limit
  }
  return budget
}

/**
 * Parses and validates an inbound request.
 *
 * Validation is total: a request that reaches a capability handler has already been proven
 * well-formed, so handlers never re-check the envelope.
 *
 * @param raw the parsed JSON request.
 * @returns the validated request.
 * @throws RuntimeError when the envelope is malformed or the capability is unknown.
 */
export function parseRequest(raw: unknown): RuntimeRequest {
  if (!isObject(raw))
    throw new RuntimeError(CODES.REQUEST_MALFORMED, 'A runtime request must be a JSON object.')
  if (raw.protocol !== PROTOCOL)
    throw new RuntimeError(CODES.PROTOCOL_MISMATCH, `A runtime request must declare protocol "${PROTOCOL}".`)
  if (typeof raw.capability !== 'string' || !KNOWN.has(raw.capability))
    throw new RuntimeError(CODES.CAPABILITY_UNKNOWN, 'A runtime request must name a known capability.')

  const runId = optionalText(raw.runId, 'runId')
  const cursor = optionalText(raw.cursor, 'cursor')
  const scope = optionalObject(raw.scope, 'scope')
  const params = optionalObject(raw.params, 'params')
  const budget = optionalBudget(raw.budget)

  return {
    protocol: PROTOCOL,
    capability: raw.capability as Capability,
    ...(runId === undefined ? {} : { runId }),
    ...(scope === undefined ? {} : { scope }),
    ...(budget === undefined ? {} : { budget }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(params === undefined ? {} : { params }),
  }
}

/** Fields a capability handler may contribute to its response. */
export interface ResponseInit {
  readonly status: Status
  readonly summary?: string
  readonly reportPath?: string
  readonly cursor?: string
  readonly diagnostics?: readonly Diagnostic[]
  readonly data?: JsonObject
}

/**
 * Builds a response envelope.
 *
 * @param capability the capability that produced the result.
 * @param init the handler's contribution.
 * @returns a complete response.
 */
export function buildResponse(capability: string, init: ResponseInit): RuntimeResponse {
  return {
    protocol: PROTOCOL,
    capability,
    status: init.status,
    ...(init.summary === undefined ? {} : { summary: init.summary }),
    ...(init.reportPath === undefined ? {} : { reportPath: init.reportPath }),
    ...(init.cursor === undefined ? {} : { cursor: init.cursor }),
    ...(init.diagnostics === undefined || init.diagnostics.length === 0 ? {} : { diagnostics: init.diagnostics }),
    ...(init.data === undefined ? {} : { data: init.data }),
  }
}

/**
 * Builds a `failed` response from a diagnostic.
 *
 * @param capability the capability that failed, or a placeholder when it was never resolved.
 * @param diagnostic the redacted diagnostic.
 * @returns a complete failure response.
 */
export function failureResponse(capability: string, diagnostic: Diagnostic): RuntimeResponse {
  return buildResponse(capability, {
    status: 'failed',
    summary: diagnostic.message,
    diagnostics: [diagnostic],
  })
}
