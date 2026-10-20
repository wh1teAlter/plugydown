import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { parse } from 'yaml'
import deliveries from '../delivery.json' with { type: 'json' }
import runtimeSchema from '../public/schemas/runtime.schema.json' with { type: 'json' }

const roleIds = ['investigator', 'recorder', 'reflector']
const conforms = new Ajv2020({ strict: true }).compile(runtimeSchema)
const protocol = 'plugydown.context.runtime/v1'

export async function snapshot(root: string): Promise<Record<string, { mode: number, sha256: string }>> {
  const entries: Record<string, { mode: number, sha256: string }> = {}
  async function walk(directory: string): Promise<void> {
    for (const name of (await fs.readdir(path.join(root, directory))).sort()) {
      const relative = path.posix.join(directory, name)
      const file = path.join(root, relative)
      const info = await fs.lstat(file)
      assert(!info.isSymbolicLink(), `Unexpected symlink: ${relative}`)
      if (info.isDirectory()) {
        await walk(relative)
      }
      else {
        assert(info.isFile(), `Unexpected special file: ${relative}`)
        entries[relative] = { mode: info.mode & 0o777, sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') }
      }
    }
  }
  await walk('')
  return entries
}

function request(file: string, cwd: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [file], { cwd, timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(error)
        return
      }
      try {
        assert.equal(stderr, '')
        const response: unknown = JSON.parse(stdout)
        assert(conforms(response), JSON.stringify(conforms.errors))
        resolve(response)
      }
      catch (error) {
        reject(error)
      }
    })
    child.stdin!.end(JSON.stringify({ protocol, capability: 'repository.inspect', input: {} }))
  })
}

/** Read-only checks of the exact unit that the release workflow publishes. */
export async function verifyDelivery(packageRoot: string, platform: keyof typeof deliveries, businessRoot: string) {
  const unit = path.join(packageRoot, 'dist', platform, deliveries[platform])
  const content = platform === 'opencode' ? path.join(unit, '.opencode') : unit
  const files = await snapshot(unit)
  const main = path.join(content, 'runtime/context/main.mjs')
  assert.equal((await fs.lstat(main)).mode & 0o777, 0o755)
  const license = await fs.readFile(path.join(content, 'runtime/context/THIRD_PARTY_LICENSES.txt'), 'utf8')
  assert.match(license, /yaml/)
  for (const name of ['runtime', 'document', 'meta']) {
    assert.deepEqual(await fs.readFile(path.join(unit, `schemas/${name}.schema.json`)), await fs.readFile(path.join(packageRoot, `public/schemas/${name}.schema.json`)))
  }
  const skills = Object.keys(files).filter(file => file.endsWith('/SKILL.md'))
  assert(skills.length > 0)
  for (const skill of skills) {
    assert.equal(path.resolve(unit, path.dirname(skill), '../../runtime/context/main.mjs'), main)
    assert.equal((await fs.lstat(path.resolve(unit, path.dirname(skill), '../../runtime/agents/index.md'))).isFile(), true)
  }
  const operatingSkill = await fs.readFile(path.join(content, 'skills/context/SKILL.md'), 'utf8')
  assert(operatingSkill.includes('../../runtime/agents/index.md'))
  const index = await fs.readFile(path.join(content, 'runtime/agents/index.md'), 'utf8')
  assert(index.includes(`Platform: ${platform}.`))
  const native = ['claude-code', 'cursor', 'opencode'].includes(platform)
  for (const id of roleIds) {
    const relative = native ? `../../agents/${id}.md` : `./${id}.md`
    assert(index.includes(`[${id}](${relative})`))
    const roleFile = path.resolve(content, 'runtime/agents', relative)
    const role = await fs.readFile(roleFile, 'utf8')
    const source = await fs.readFile(path.join(packageRoot, `src/internal-roles/${id}.md`), 'utf8')
    assert.equal(role.slice(role.indexOf('\n---\n') + 5).trim(), source.trim())
    const metadata = parse(role.split('\n---\n')[0]!.slice(4))
    if (!native) {
      assert.equal(metadata.delivery, 'private-runtime-resource')
      assert(!skills.some(skill => skill.includes(id)), 'Private roles must not become public Skills')
    }
    if (platform === 'opencode') {
      assert.equal(metadata.mode, 'subagent')
      assert.deepEqual(metadata.permission, { edit: id === 'investigator' ? 'deny' : 'allow', bash: id === 'investigator' ? 'allow' : 'deny', task: 'deny', webfetch: 'deny' })
    }
    if (platform === 'cursor')
      assert.deepEqual(Object.keys(metadata).sort(), ['description', 'name'])
  }
  if (platform === 'claude-code') {
    const manifest = JSON.parse(await fs.readFile(path.join(unit, '.claude-plugin/plugin.json'), 'utf8'))
    assert.deepEqual(manifest.agents, roleIds.map(id => `./agents/${id}.md`))
    assert.equal(JSON.parse(await fs.readFile(path.join(unit, '.claude-plugin/marketplace.json'), 'utf8')).plugins[0].source, './')
  }
  if (platform === 'cursor') {
    const manifest = JSON.parse(await fs.readFile(path.join(unit, '.cursor-plugin/plugin.json'), 'utf8'))
    assert.equal(manifest.agents, './agents/*.md')
  }
  if (platform === 'pi') {
    const manifest = JSON.parse(await fs.readFile(path.join(unit, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.pi, { skills: ['./skills'], prompts: ['./prompts'], extensions: ['./extensions/aaplugin-hooks.mjs'] })
  }
  const response = await request(main, businessRoot)
  assert.deepEqual(response, {
    protocol,
    capability: 'repository.inspect',
    status: 'success',
    data: { context: { state: 'absent', sourceState: 'unchecked' }, meta: { state: 'absent' } },
  })
  return { main: await fs.readFile(main), license }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const packageRoot = path.resolve(import.meta.dirname, '..')
  if (process.argv[2] === '--snapshot') {
    process.stdout.write(`${JSON.stringify(await snapshot(path.join(packageRoot, 'dist')))}\n`)
  }
  else {
    const { tmpdir } = await import('node:os')
    const business = await fs.mkdtemp(path.join(tmpdir(), 'plugydown-delivery-business-'))
    try {
      await fs.mkdir(path.join(business, '.git'))
      let first: Awaited<ReturnType<typeof verifyDelivery>> | undefined
      for (const platform of Object.keys(deliveries) as (keyof typeof deliveries)[]) {
        const result = await verifyDelivery(packageRoot, platform, business)
        if (first !== undefined)
          assert.deepEqual(result, first, 'Runtime and license bytes must agree across Platforms')
        first = result
        process.stdout.write(`${platform}: delivery verified\n`)
      }
    }
    finally {
      await fs.rm(business, { recursive: true, force: true })
    }
  }
}
