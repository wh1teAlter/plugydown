import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const root = path.resolve(new URL('../..', import.meta.url).pathname)
const run = promisify(execFile)
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
        result[path.relative(directory, file)] = { hash: createHash('sha256').update(await readFile(file)).digest('hex'), mode: fileStat.mode & 0o777 }
      }
    }
  }
  await walk(directory)
  return result
}
const first = await snapshot(path.join(root, 'dist'))
const firstInspect = (await run(path.join(root, 'node_modules/.bin/aaplugin'), ['inspect', '--json'], { cwd: root })).stdout
await run(path.join(root, 'node_modules/.bin/aaplugin'), ['build'], { cwd: root })
const second = await snapshot(path.join(root, 'dist'))
const secondInspect = (await run(path.join(root, 'node_modules/.bin/aaplugin'), ['inspect', '--json'], { cwd: root })).stdout
if (JSON.stringify(first) !== JSON.stringify(second) || firstInspect !== secondInspect) {
  console.error('determinism mismatch')
  process.exit(1)
}
console.log('determinism scan passed')
