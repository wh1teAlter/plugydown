import type { JsonValue } from './stable-json.js'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { handleRequest } from './handler.js'
import { FORMAT } from './protocol.js'
import { stableJson } from './stable-json.js'

// 单次标准输入请求的最大字节数，防止无界缓冲。
const MAX_REQUEST_BYTES = 1024 * 1024

/** 从标准输入读取唯一 JSON 请求，限制总字节数并严格解码 UTF-8。 */
async function readRequest(): Promise<unknown> {
  // 当前标准输入请求的分块缓冲集合。
  const chunks: Buffer[] = []
  // 当前已接收请求的累计字节数。
  let size = 0
  for await (const value of process.stdin) {
    // 当前读取或输出的字节、正文片段。
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
    size += chunk.length
    if (size > MAX_REQUEST_BYTES)
      throw new Error('REQUEST_SIZE_EXCEEDED')
    chunks.push(chunk)
  }
  // 本次读取或编码的原始字节序列。
  const bytes = Buffer.concat(chunks)
  // 从请求字节严格解码出的 JSON 文本。
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return JSON.parse(source) as unknown
}

/** 构造传输层失败对象，不混用 Runtime 的产品状态。 */
function transportFailure(code: string): JsonValue {
  return {
    transport: 'plugydown.context.runtime.transport',
    format: FORMAT,
    status: 'failed',
    diagnostics: [{ code, severity: 'error', message: 'The Runtime request could not be transported safely.' }],
  }
}

/** 处理一次标准输入请求并写出唯一响应；传输失败时设置非零退出码。 */
async function main(): Promise<void> {
  try {
    // 当前能力按协议构造的结果响应。
    const response = await handleRequest(process.cwd(), await readRequest())
    process.stdout.write(stableJson(response as unknown as JsonValue))
  }
  catch (error) {
    // 对外公开的传输故障码，不泄漏底层异常消息。
    const code = error instanceof Error && error.message === 'REQUEST_SIZE_EXCEEDED'
      ? 'REQUEST_SIZE_EXCEEDED'
      : 'TRANSPORT_INVALID'
    process.stdout.write(stableJson(transportFailure(code)))
    process.exitCode = 1
  }
}

await main()
