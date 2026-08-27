import type { CAPABILITIES, DOCUMENT_KINDS } from './constants.js'

/** A capability group the runtime can serve. */
export type Capability = typeof CAPABILITIES[number]

/** A logical document kind. */
export type DocumentKind = typeof DOCUMENT_KINDS[number]

/**
 * Terminal status of a runtime call.
 *
 * `incomplete` means evidence or authorization was insufficient — the caller may supply more.
 * `failed` means a tool, schema, I/O, or recovery error occurred. They are never interchangeable.
 */
export type Status = 'success' | 'incomplete' | 'failed'

/** Severity of a structured diagnostic. */
export type Severity = 'error' | 'warning' | 'info'

/** JSON value, used where the payload shape belongs to a specific capability. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** JSON object, used for capability-owned payloads. */
export interface JsonObject { [key: string]: JsonValue }

/** Simultaneous item, byte, and conservative token limits applied to every batch. */
export interface Budget {
  readonly items?: number
  readonly bytes?: number
  readonly estimatedTokens?: number
}

/** One structured, redacted diagnostic. */
export interface Diagnostic {
  readonly code: string
  readonly severity: Severity
  readonly message: string
}

/** An inbound runtime request. */
export interface RuntimeRequest {
  readonly protocol: string
  readonly capability: Capability
  readonly runId?: string
  readonly scope?: JsonObject
  readonly budget?: Budget
  readonly cursor?: string
  readonly params?: JsonObject
}

/** An outbound runtime response. */
export interface RuntimeResponse {
  readonly protocol: string
  readonly capability: string
  readonly status: Status
  readonly summary?: string
  readonly reportPath?: string
  readonly cursor?: string
  readonly diagnostics?: readonly Diagnostic[]
  readonly data?: JsonObject
}
