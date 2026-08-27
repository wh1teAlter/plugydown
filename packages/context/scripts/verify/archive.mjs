import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = path.resolve(new URL('../..', import.meta.url).pathname)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function snapshot(directory) {
  const result = {}
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(file)
      }
      else {
        const fileStat = await stat(file)
        result[path.relative(directory, file)] = { hash: digest(await readFile(file)), mode: fileStat.mode & 0o777 }
      }
    }
  }
  await walk(directory)
  return result
}
for (const platform of ['claude-code', 'codex']) {
  const source = path.join(root, 'dist', platform, 'marketplace')
  const temp = await mkdtemp(path.join(os.tmpdir(), 'plugydown-archive-'))
  const archive = path.join(temp, `${platform}.tar`)
  const unpack = path.join(temp, 'unpack')
  await run('tar', ['-cf', archive, '-C', source, '.'])
  await run('mkdir', ['-p', unpack])
  await run('tar', ['-xf', archive, '-C', unpack])
  const before = await snapshot(source)
  const after = await snapshot(unpack)
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    console.error(`archive mismatch: ${platform}`)
    process.exit(1)
  }
  await rm(temp, { recursive: true, force: true })
}
console.log('archive byte-equivalence passed for claude-code and codex')
