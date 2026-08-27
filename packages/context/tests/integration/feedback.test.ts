import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL } from '../../src/runtime/constants.js'
import { run } from '../../src/runtime/runner.js'
import { createEmptyFixture, removeFixture } from '../helpers/fixture.js'

const created: string[] = []
afterEach(async () => Promise.all(created.splice(0).map(removeFixture)))

describe('feedback matching', () => {
  it('matches compact candidate metadata without automatic promotion', async () => {
    const root = await createEmptyFixture()
    created.push(root)
    const directory = path.join(root, '.scratch/feedback/candidates')
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, 'retry.json'), JSON.stringify({ id: 'retry-pattern', description: 'Retry policy correction', tags: ['reliability'], relations: ['service.retry'] }))
    const response = await run(root, { protocol: PROTOCOL, capability: 'feedback.match', params: { description: 'retry', tags: ['reliability'] } })
    expect(response.status).toBe('success')
    expect(response.data).toMatchObject({ autoPromotion: false, candidates: [{ id: 'retry-pattern' }] })
  })

  it('does not match malformed feedback as authoritative evidence', async () => {
    const root = await createEmptyFixture()
    created.push(root)
    const directory = path.join(root, '.scratch/feedback/active')
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, 'broken.json'), '{broken')
    const response = await run(root, { protocol: PROTOCOL, capability: 'feedback.match', params: { description: 'retry' } })
    expect(response.status).toBe('success')
    expect((response.data as Record<string, unknown>).candidates).toEqual([])
  })
})
