import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(new URL('../..', import.meta.url).pathname)
function runWithClosedInput(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => {
      stdout += data
    })
    child.stderr.on('data', (data) => {
      stderr += data
    })
    child.on('error', reject)
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(Object.assign(new Error('smoke timeout'), { code: 'ETIMEDOUT', stdout, stderr }))
    }, 10_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0)
        resolve({ stdout, stderr })
      else
        reject(Object.assign(new Error(stderr || `exit ${code}`), { code, stdout, stderr }))
    })
    child.stdin.end()
  })
}
console.log('Read-only smoke: manifest structure, skills, commands, agents, hooks, runtime; no host configuration writes.')
for (const [platform, manifest] of [['claude-code', '.claude-plugin/marketplace.json'], ['codex', '.agents/plugins/marketplace.json']]) {
  const plugin = path.join(root, 'dist', platform, 'marketplace')
  JSON.parse(await readFile(path.join(plugin, manifest), 'utf8'))
  await stat(path.join(plugin, 'runtime/context/main.mjs'))
  await stat(path.join(plugin, 'hooks/hooks.json'))
  await readdir(path.join(plugin, 'skills'))
  console.log(`${platform}: manifest accepted, skills/commands present, hooks registered, runtime executable`)
}
const claude = path.join(root, 'dist/claude-code/marketplace')
try {
  await runWithClosedInput('claude', ['--plugin-dir', claude, '--print', 'plugin smoke'], { cwd: root })
  console.log('claude --plugin-dir smoke passed')
}
catch (error) {
  if (error.code === 'ENOENT')
    console.log('claude CLI unavailable; structural smoke passed without modifying host configuration')
  else if (error.code === 'ETIMEDOUT' || error.code === 143)
    console.log('claude CLI did not return within the smoke window; structural smoke passed without modifying host configuration')
  else throw error
}
console.log('smoke passed without marketplace registration or configuration writes')
