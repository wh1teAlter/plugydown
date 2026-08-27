/** Wire identifier for the private runtime protocol. Versioned independently of the plugin. */
export const PROTOCOL = 'plugydown.context.runtime/v1'

/** Front matter schema constant carried by every formal document. */
export const DOCUMENT_SCHEMA = 'plugydown.context.document/v1'

/** Ledger schema constant carried by `meta.json`. */
export const META_SCHEMA = 'plugydown.context.meta/v1'

/** Formal knowledge root, relative to the repository root. */
export const KNOWLEDGE_ROOT = 'context'

/** Disposable working area, relative to the repository root. Never a source of truth. */
export const SCRATCH_ROOT = '.scratch'

/** Validity ledger path, relative to the repository root. */
export const META_PATH = `${KNOWLEDGE_ROOT}/meta.json`

/** Session state block name preserved across host context compaction. */
export const STATE_KEY = 'PLUGYDOWN_CONTEXT_STATE'

/** Directories a Domain may contain, mapped to the document kinds they accept. */
export const DOMAIN_CATEGORIES = {
  design: ['architecture', 'decision'],
  manual: ['guide', 'reference'],
  reflections: ['reflection'],
} as const

/** Every logical document kind. */
export const DOCUMENT_KINDS = [
  'domain',
  'architecture',
  'decision',
  'guide',
  'reference',
  'reflection',
] as const

/** Runtime capability groups callable over the protocol. */
export const CAPABILITIES = [
  'repository.inspect',
  'frontier.query',
  'graph.validate',
  'delta.compute',
  'growth.measure',
  'feedback.match',
  'role.envelope',
  'transaction.run',
] as const

/**
 * Prune suggestion threshold, as a fraction of the last convergence baseline.
 *
 * ponytail: calibration knob, not a product invariant. A single ratio is testable at its
 * boundary; a composite score is not.
 */
export const GROWTH_GATE_RATIO = 0.5
