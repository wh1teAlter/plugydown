import { execFile } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const cwd = new URL('../..', import.meta.url).pathname
const { stdout } = await run(path.join(cwd, 'node_modules/.bin/aaplugin'), ['inspect', '--json'], { cwd })
const report = JSON.parse(stdout)
const text = JSON.stringify(report)
const entries = report.compatibility ?? []
if (!Array.isArray(entries) || entries.some(entry => typeof entry.subject !== 'string' || typeof entry.platform !== 'string' || typeof entry.level !== 'string')) {
  console.error('compatibility report is missing explicit entries')
  process.exit(1)
}
if (text.includes('degraded') || text.includes('unsupported')) {
  console.error('compatibility report contains degraded or unsupported entries')
  process.exit(1)
}
console.log('compatibility scan passed')
