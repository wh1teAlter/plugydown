import type { JsonValue } from './stable-json.js'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { handleRequest } from './handler.js'
import { stableJson } from './stable-json.js'

const MAX_REQUEST_BYTES = 1024 * 1024

async function readRequest(): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
    size += chunk.length
    if (size > MAX_REQUEST_BYTES)
      throw new Error('REQUEST_SIZE_EXCEEDED')
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks)
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return JSON.parse(source) as unknown
}

function transportFailure(code: string): JsonValue {
  return {
    transport: 'plugydown.context.runtime.transport/v1',
    status: 'failed',
    diagnostics: [{ code, severity: 'error', message: 'The Runtime request could not be transported safely.' }],
  }
}

async function main(): Promise<void> {
  try {
    const response = await handleRequest(process.cwd(), await readRequest())
    process.stdout.write(stableJson(response as unknown as JsonValue))
  }
  catch (error) {
    const code = error instanceof Error && error.message === 'REQUEST_SIZE_EXCEEDED'
      ? 'REQUEST_SIZE_EXCEEDED'
      : 'TRANSPORT_INVALID'
    process.stdout.write(stableJson(transportFailure(code)))
    process.exitCode = 1
  }
}

await main()
