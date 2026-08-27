import type { Diagnostic, Severity } from './types.js'

/**
 * Stable diagnostic codes.
 *
 * Codes are the contract; messages are for humans and may be reworded. Neither ever carries
 * an absolute path, an environment value, or a credential.
 */
export const CODES = {
  PROTOCOL_MISMATCH: 'PROTOCOL_MISMATCH',
  REQUEST_MALFORMED: 'REQUEST_MALFORMED',
  CAPABILITY_UNKNOWN: 'CAPABILITY_UNKNOWN',
  CAPABILITY_UNIMPLEMENTED: 'CAPABILITY_UNIMPLEMENTED',
  PATH_ABSOLUTE: 'PATH_ABSOLUTE',
  PATH_TRAVERSAL: 'PATH_TRAVERSAL',
  PATH_UNEXPANDED_VARIABLE: 'PATH_UNEXPANDED_VARIABLE',
  PATH_NUL_BYTE: 'PATH_NUL_BYTE',
  PATH_EMPTY: 'PATH_EMPTY',
  PATH_SYMLINK_ESCAPE: 'PATH_SYMLINK_ESCAPE',
  PATH_SPECIAL_FILE: 'PATH_SPECIAL_FILE',
  GLOB_UNBOUNDED: 'GLOB_UNBOUNDED',
  KNOWLEDGE_ROOT_MISSING: 'KNOWLEDGE_ROOT_MISSING',
  META_UNREADABLE: 'META_UNREADABLE',
  INTERNAL: 'INTERNAL',
} as const

/** A stable diagnostic code. */
export type Code = typeof CODES[keyof typeof CODES]

/**
 * An error carrying a stable code.
 *
 * Anything thrown that is not a `RuntimeError` is reported as `INTERNAL` with a fixed message,
 * so an unexpected stack or path can never reach the caller.
 */
export class RuntimeError extends Error {
  constructor(readonly code: Code, message: string) {
    super(message)
    this.name = 'RuntimeError'
  }
}

/** @returns a structured diagnostic. */
export function diagnostic(code: Code, message: string, severity: Severity = 'error'): Diagnostic {
  return { code, severity, message }
}

/**
 * Converts any thrown value into a redacted diagnostic.
 *
 * @param error the thrown value.
 * @returns a diagnostic whose message is safe to return to the caller.
 */
export function redact(error: unknown): Diagnostic {
  if (error instanceof RuntimeError)
    return diagnostic(error.code, error.message)
  return diagnostic(CODES.INTERNAL, 'The runtime failed with an unexpected internal error.')
}
