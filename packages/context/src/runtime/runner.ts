import type { OperationResult } from './operations.js'
import type { RuntimeRequest, RuntimeResponse } from './types.js'
import { CODES, redact, RuntimeError } from './errors.js'
import { inspectRepository } from './inspect.js'
import { runDelta, runFeedbackMatch, runFrontier, runGrowth, runRoleEnvelope, runTransactionCapability, validateGraph } from './operations.js'
import { buildResponse, failureResponse, parseRequest } from './protocol.js'

/** Capabilities whose handlers do not exist yet. */
const UNIMPLEMENTED = 'This runtime capability is not implemented yet.'

/** @returns an operation result wrapped in a response envelope. */
function respond(capability: string, result: OperationResult): RuntimeResponse {
  return buildResponse(capability, {
    status: result.status,
    summary: result.summary,
    data: result.data,
    ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
  })
}

/**
 * Dispatches a validated request to its capability handler.
 *
 * @param root absolute repository root.
 * @param request the validated request.
 * @returns the capability's response.
 */
async function dispatch(root: string, request: RuntimeRequest): Promise<RuntimeResponse> {
  switch (request.capability) {
    case 'repository.inspect': {
      const data = await inspectRepository(root)
      const domains = Array.isArray(data.domains) ? data.domains.length : 0
      return buildResponse(request.capability, {
        status: 'success',
        summary: data.present === true
          ? `Formal knowledge is present with ${domains} Domain(s).`
          : 'Formal knowledge has not been initialized.',
        data,
      })
    }
    case 'graph.validate':
      return respond(request.capability, await validateGraph(root))
    case 'frontier.query':
      return respond(request.capability, await runFrontier(root, request))
    case 'delta.compute':
      return respond(request.capability, await runDelta(root, request))
    case 'growth.measure':
      return respond(request.capability, await runGrowth(root))
    case 'feedback.match':
      return respond(request.capability, await runFeedbackMatch(root, request))
    case 'role.envelope':
      return respond(request.capability, await runRoleEnvelope(request))
    case 'transaction.run':
      return respond(request.capability, await runTransactionCapability(root, request))
    default:
      throw new RuntimeError(CODES.CAPABILITY_UNIMPLEMENTED, UNIMPLEMENTED)
  }
}

/**
 * Runs one request end to end.
 *
 * Every failure path funnels through `redact`, so a caller can never observe a stack, an
 * absolute path, or an environment value regardless of what went wrong.
 *
 * @param root absolute repository root.
 * @param raw the parsed JSON request.
 * @returns a complete response; this function does not throw.
 */
export async function run(root: string, raw: unknown): Promise<RuntimeResponse> {
  let capability = 'unknown'
  try {
    const request = parseRequest(raw)
    capability = request.capability
    return await dispatch(root, request)
  }
  catch (error) {
    return failureResponse(capability, redact(error))
  }
}
