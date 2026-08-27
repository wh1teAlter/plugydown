/** How a file changed relative to the comparison point. */
export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

/** One changed path. */
export interface Change {
  readonly path: string
  readonly kind: ChangeKind
  readonly staged: boolean
}

/** Repository state relevant to whether a baseline may advance. */
export interface GitState {
  readonly available: boolean
  readonly revision?: string
  /** True during merge, rebase, cherry-pick, bisect, or a detached sequencer state. */
  readonly midOperation: boolean
  readonly changes: readonly Change[]
}

/** @returns the status letter mapped to a change kind. */
function kindOf(letter: string): ChangeKind {
  switch (letter) {
    case 'A': return 'added'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case '?': return 'untracked'
    default: return 'modified'
  }
}

/**
 * Parses `git status --porcelain=v1 -z`.
 *
 * The NUL-delimited form is the only safe one: a path containing a newline or a quote breaks
 * the human-readable output, and knowledge repositories do contain such paths.
 *
 * @param stdout raw NUL-delimited status output.
 * @returns the parsed changes.
 */
export function parseStatus(stdout: string): readonly Change[] {
  const fields = stdout.split('\0')
  const changes: Change[] = []

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field === undefined || field.length < 4)
      continue

    const staged = field[0] ?? ' '
    const unstaged = field[1] ?? ' '
    const path = field.slice(3)
    if (path.length === 0)
      continue

    /** A rename carries its source path in the next NUL-delimited field. */
    if (staged === 'R' || unstaged === 'R')
      index += 1

    if (staged === '?' || unstaged === '?') {
      changes.push({ path, kind: 'untracked', staged: false })
      continue
    }
    if (staged !== ' ')
      changes.push({ path, kind: kindOf(staged), staged: true })
    if (unstaged !== ' ')
      changes.push({ path, kind: kindOf(unstaged), staged: false })
  }
  return changes
}

/**
 * Parses `git diff --name-status -z` for a committed range.
 *
 * @param stdout raw NUL-delimited diff output.
 * @returns the parsed changes, all marked as committed.
 */
export function parseNameStatus(stdout: string): readonly Change[] {
  const fields = stdout.split('\0').filter(field => field.length > 0)
  const changes: Change[] = []

  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index]
    if (status === undefined)
      continue
    const letter = status[0] ?? 'M'
    /** A rename status carries both the old and the new path. */
    const pathIndex = letter === 'R' ? index + 2 : index + 1
    const path = fields[pathIndex]
    index = pathIndex
    if (path !== undefined && path.length > 0)
      changes.push({ path, kind: kindOf(letter), staged: true })
  }
  return changes
}

/** Raw Git output the caller collected on the runtime's behalf. */
export interface GitInput {
  /** `git rev-parse HEAD`. */
  readonly revision?: string
  /** Output of `git status --porcelain=v1 -z --untracked-files=all`. */
  readonly status?: string
  /** Output of `git diff --name-status -z <baseline>..HEAD`. */
  readonly committed?: string
  /** Whether Git is mid-merge, rebase, cherry-pick, revert, or bisect. */
  readonly midOperation?: boolean
}

/**
 * Builds repository state from Git output the caller supplied.
 *
 * The runtime deliberately does not spawn `git` itself. Parsing is deterministic and testable;
 * collection needs process execution, an ambient PATH, and a real working directory, none of
 * which belong inside a bundled plugin runtime. The caller already has a shell.
 *
 * @param input raw Git output.
 * @returns the repository state the delta needs.
 */
export function gitStateFromInput(input: GitInput | undefined): GitState {
  if (input?.revision === undefined || input.revision.length === 0)
    return { available: false, midOperation: false, changes: [] }

  return {
    available: true,
    revision: input.revision,
    midOperation: input.midOperation === true,
    changes: [
      ...(input.committed === undefined ? [] : parseNameStatus(input.committed)),
      ...(input.status === undefined ? [] : parseStatus(input.status)),
    ],
  }
}
