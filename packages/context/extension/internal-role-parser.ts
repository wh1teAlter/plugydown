/** Front matter and body of one Internal Role source file. */
export interface InternalRoleSource {
  readonly id: string
  readonly description: string
  readonly model: 'inherit' | 'fast' | 'capable'
  readonly tools: readonly string[]
  readonly body: string
}

/** Front matter field names this parser accepts. */
const KEY = /^[a-z][a-z0-9]*$/i

/** Lowercase kebab-case Role IDs. */
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Front matter delimiters, tolerating a byte order mark and CRLF. */
const FRONT_MATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/** Canonical model classes AAPlugin accepts. */
const MODELS = new Set(['inherit', 'fast', 'capable'])

/**
 * Parses one Internal Role Markdown file.
 *
 * The parser deliberately accepts only the small field set the two platforms both need. A
 * role body must stay platform-neutral: command, mode, scope, budgets, and temporary paths
 * belong to the task envelope, not to the role text.
 *
 * @param source raw file contents.
 * @param label stable label used in error messages; never a physical path.
 * @returns the parsed role.
 * @throws Error when the file is not a valid role definition.
 */
export function parseInternalRole(source: string, label: string): InternalRoleSource {
  const match = FRONT_MATTER.exec(source)
  if (match === null)
    throw new Error(`Internal Role "${label}" must begin with a YAML front matter block.`)

  const fields = new Map<string, string>()
  const lines = (match[1] ?? '').split('\n')
  let current: string | undefined

  for (const line of lines) {
    if (line.trim().length === 0)
      continue
    /** String scanning avoids the backtracking a `\s*(.*)` pair would allow. */
    const trimmed = line.trim()
    if (trimmed.startsWith('- ') || trimmed === '-') {
      if (current === undefined)
        throw new Error(`Internal Role "${label}" has a list item outside any field.`)
      const value = trimmed.slice(1).trim()
      const existing = fields.get(current) ?? ''
      fields.set(current, existing.length === 0 ? value : `${existing},${value}`)
      continue
    }

    const separator = line.indexOf(':')
    const name = separator < 0 ? '' : line.slice(0, separator).trim()
    if (separator > 0 && KEY.test(name)) {
      current = name
      fields.set(current, line.slice(separator + 1).trim())
      continue
    }
    throw new Error(`Internal Role "${label}" has an unsupported front matter line.`)
  }

  for (const field of fields.keys()) {
    if (!['id', 'description', 'model', 'tools'].includes(field))
      throw new Error(`Internal Role "${label}" declares unknown field "${field}".`)
  }

  const id = fields.get('id') ?? ''
  if (!ID.test(id))
    throw new Error(`Internal Role "${label}" must declare a lowercase kebab-case id.`)

  const description = fields.get('description') ?? ''
  if (description.length === 0 || /[\r\n\t]/.test(description))
    throw new Error(`Internal Role "${label}" must declare a non-empty single-line description.`)

  const model = fields.get('model') ?? 'inherit'
  if (!MODELS.has(model))
    throw new Error(`Internal Role "${label}" declares an unknown model class.`)

  const declaredTools = fields.get('tools') ?? ''
  const tools = declaredTools.length === 0
    ? []
    : declaredTools.split(',').map(tool => tool.trim()).filter(tool => tool.length > 0)
  if (new Set(tools).size !== tools.length)
    throw new Error(`Internal Role "${label}" declares duplicate tools.`)

  const body = (match[2] ?? '').trim()
  if (body.length === 0)
    throw new Error(`Internal Role "${label}" must have a non-empty body.`)

  return { id, description, model: model as InternalRoleSource['model'], tools, body }
}
