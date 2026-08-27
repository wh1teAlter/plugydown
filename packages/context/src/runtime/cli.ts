import type { JsonValue } from './types.js'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { PROTOCOL } from './constants.js'
import { CODES, diagnostic } from './errors.js'
import { failureResponse } from './protocol.js'
import { run } from './runner.js'
import { stableJson } from './stable-json.js'

/** Largest request the runtime will accept, guarding against an unbounded pipe. */
const MAX_REQUEST_BYTES = 4 * 1024 * 1024

/**
 * Reads the whole request from stdin.
 *
 * @returns the raw request text.
 * @throws RuntimeError when the request exceeds the size limit.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of process.stdin) {
    const buffer = chunk as Buffer
    size += buffer.byteLength
    if (size > MAX_REQUEST_BYTES)
      throw new Error('request too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Writes a response and exits with the code its status implies. */
function emit(response: JsonValue, status: string): never {
  process.stdout.write(stableJson(response))
  process.exit(status === 'success' ? 0 : 1)
}

/**
 * Entry point.
 *
 * `--help` and `--version` answer without touching the repository, which makes the delivered
 * bundle checkable in a build test without constructing a fixture repository.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(stableJson({
      protocol: PROTOCOL,
      usage: 'Reads one JSON request on stdin and writes one JSON response on stdout.',
    }))
    process.exit(0)
  }

  if (argv.includes('--version')) {
    process.stdout.write(stableJson({ protocol: PROTOCOL }))
    process.exit(0)
  }

  let raw: unknown
  try {
    raw = JSON.parse(await readStdin())
  }
  catch {
    const response = failureResponse('unknown', diagnostic(CODES.REQUEST_MALFORMED, 'A runtime request must be readable JSON within the size limit.'))
    emit(response as unknown as JsonValue, response.status)
  }

  const response = await run(process.cwd(), raw)
  emit(response as unknown as JsonValue, response.status)
}

await main()
