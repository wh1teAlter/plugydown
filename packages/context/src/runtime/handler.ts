import type { RuntimeRequest, RuntimeResponse } from './protocol.js'
import { deltaCompute } from './delta.js'
import { failureResponse, parseRequest, requestCapability, RuntimeFault } from './protocol.js'
import { feedbackMatch, frontierQuery, graphValidate, growthMeasure, repositoryInspect } from './queries.js'
import { transaction } from './transaction.js'

async function dispatch(root: string, request: RuntimeRequest): Promise<RuntimeResponse> {
  switch (request.capability) {
    case 'repository.inspect': return repositoryInspect(root, request)
    case 'frontier.query': return frontierQuery(root, request)
    case 'graph.validate': return graphValidate(root)
    case 'delta.compute': return deltaCompute(root, request)
    case 'growth.measure': return growthMeasure(root, request)
    case 'feedback.match': return feedbackMatch(root, request)
    case 'transaction': return transaction(root, request)
  }
}

/** Highest Runtime test seam shared with the one-shot CLI adapter. */
export async function handleRequest(root: string, request: unknown): Promise<RuntimeResponse> {
  const capability = requestCapability(request)
  try {
    const parsed = parseRequest(request)
    return await dispatch(root, parsed)
  }
  catch (error) {
    if (error instanceof RuntimeFault)
      return failureResponse(capability, error)
    throw error
  }
}
