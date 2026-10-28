import type { RuntimeRequest, RuntimeResponse } from './protocol.js'
import { deltaCompute } from './delta.js'
import { failureResponse, parseRequest, requestCapability, RuntimeFault } from './protocol.js'
import { feedbackMatch, frontierQuery, graphValidate, growthMeasure, repositoryInspect } from './queries.js'
import { transaction } from './transaction.js'

/** 将已通过协议校验的请求分派到对应的只读能力或事务入口。 */
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

/**
 * 校验并执行一次 Runtime 请求，将可预期的产品故障封装为协议响应。
 *
 * @param root - 业务仓库根目录。
 * @param request - 当前能力的请求；除入口解析函数外应已通过协议校验。
 * @returns 对应能力的产品响应；产品故障使用 failed 状态返回。
 * @throws 可预期 RuntimeFault 转为 failed 响应；未知异常继续抛出，交给传输适配层处理。
 * @remarks 调用阶段：CLI 或测试入口收到一个完整请求后；写入行为仅由 transaction 能力触发。
 */
export async function handleRequest(root: string, request: unknown): Promise<RuntimeResponse> {
  // 从请求中识别的能力名，用于分派或安全标注失败响应。
  const capability = requestCapability(request)
  try {
    // 经过当前层格式校验的数据，供后续语义判断使用。
    const parsed = parseRequest(request)
    return await dispatch(root, parsed)
  }
  catch (error) {
    if (error instanceof RuntimeFault)
      return failureResponse(capability, error)
    throw error
  }
}
