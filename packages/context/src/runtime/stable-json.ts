import type { JsonValue } from './types.js'

/**
 * Compares two strings by code unit.
 *
 * Locale-aware comparison is deliberately avoided: sort order must not depend on the machine
 * the runtime happens to run on.
 *
 * @param left first string.
 * @param right second string.
 * @returns negative, zero, or positive ordering.
 */
export function compareCodeUnits(left: string, right: string): number {
  if (left === right)
    return 0
  return left < right ? -1 : 1
}

/**
 * Recursively rebuilds a value with object keys in code-unit order.
 *
 * Array order is meaningful and is preserved; only object key order is normalized.
 *
 * @param value the value to normalize.
 * @returns an equal value with deterministic key ordering.
 */
export function sortValue(value: JsonValue): JsonValue {
  if (Array.isArray(value))
    return value.map(sortValue)
  if (value === null || typeof value !== 'object')
    return value

  const sorted: { [key: string]: JsonValue } = {}
  for (const key of Object.keys(value).sort(compareCodeUnits))
    sorted[key] = sortValue(value[key] as JsonValue)
  return sorted
}

/**
 * Serializes a value with deterministic key ordering.
 *
 * Two runs over equal data must produce identical bytes: reports and fingerprints depend on
 * it, and so does the byte-equivalence check applied to build output.
 *
 * @param value the value to serialize.
 * @returns deterministic JSON with a trailing newline.
 */
export function stableJson(value: JsonValue): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`
}
