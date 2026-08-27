import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(new URL('../..', import.meta.url).pathname)
const targets = ['src', 'public', 'scripts', 'tests', 'README.md', 'dist']
const forbidden = [
  `.${'llm' + 'doc'}-tmp`,
  `@tokenroll/${'ac' + 'plugin'}`,
  'ac' + 'plugin',
  'LLM' + 'DOC_STATE',
  `${'llm' + 'doc'}.${'document'}/v1`,
  `${'llm' + 'doc'}.${'meta'}/v1`,
]
const files = []
async function walk(target) {
  const { lstat } = await import('node:fs/promises')
  const targetStat = await lstat(target)
  if (targetStat.isFile()) {
    files.push(target)
    return
  }
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git')
      continue
    await walk(path.join(target, entry.name))
  }
}
for (const target of targets) {
  try {
    await walk(path.join(root, target))
  }
  catch {}
}
const hits = []
for (const file of files) {
  const text = await readFile(file, 'utf8')
  for (const needle of forbidden) {
    if (text.includes(needle))
      hits.push(`${path.relative(root, file)}: ${needle}`)
  }
  if (/(?:^|\/)skills\/agent-[^/]+\//.test(path.relative(root, file)))
    hits.push(`${path.relative(root, file)}: agent-*`)
}
if (hits.length) {
  console.error(hits.join('\n'))
  process.exit(1)
}
console.log(`forbidden scan passed (${files.length} files)`)
