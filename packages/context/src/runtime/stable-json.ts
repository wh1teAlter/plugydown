/** JSON values accepted by the Runtime wire and deterministic files. */
export type JsonValue
  = | null
    | boolean
    | number
    | string
    | JsonValue[]
    | { [key: string]: JsonValue }

/** A JSON object with no prototype-dependent semantics. */
export interface JsonObject { [key: string]: JsonValue }

/** Locale-independent code-unit ordering. */
export function compareCodeUnits(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

/** Recursively orders object keys while preserving meaningful array order. */
export function stableValue(value: JsonValue): JsonValue {
  if (Array.isArray(value))
    return value.map(stableValue)
  if (value === null || typeof value !== 'object')
    return value

  const sorted: JsonObject = {}
  for (const key of Object.keys(value).sort(compareCodeUnits))
    sorted[key] = stableValue(value[key] as JsonValue)
  return sorted
}

/** Serializes deterministic, human-readable JSON with one trailing LF. */
export function stableJson(value: JsonValue): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`
}

/** Serializes compact deterministic JSON for hashes and opaque cursors. */
export function compactJson(value: JsonValue): string {
  return JSON.stringify(stableValue(value))
}
