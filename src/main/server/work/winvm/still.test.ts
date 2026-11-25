import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Caller } from '../modules'
import { STILL_EDGE, stillRefusal, VmStill } from './still'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("the VM's still", () => {
  it('keeps the screen as a JPEG at most 1920 on its edge, in place of the last; none before the first', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'still-')), 'winvm', 'picture')
    dirs.push(dir)
    const edges: number[] = []
    let shot = 0
    const still = new VmStill({
      dir,
      screenshot: async () => Buffer.from(`png${++shot}`),
      jpeg: async (png, edge) => (edges.push(edge), { data: png.toString('base64'), width: 1920, height: 1200 }),
      now: () => 42
    })
    expect(still.read()).toBeNull()
    await still.keep()
    await still.keep()
    expect(still.read()).toEqual({ data: Buffer.from('png2').toString('base64'), width: 1920, height: 1200, at: 42 })
    expect(edges).toEqual([STILL_EDGE, STILL_EDGE])
  })

  it('goes to whoever may watch the VM: a client key with approve, never a thread, a read-only key or the box\'s own socket', () => {
    const remote = (caps: string[], audience: 'client' | 'mcp' = 'client'): Caller => ({ kind: 'remote', caps, audience, keyId: 'k' })
    expect(stillRefusal(remote(['read', 'approve']), false)).toBeNull()
    expect(stillRefusal(remote(['read']), false)).toMatch(/needs approve/)
    expect(stillRefusal(remote(['read', 'approve'], 'mcp'), false)).toMatch(/needs approve/)
    expect(stillRefusal({ kind: 'model', caps: ['read', 'approve'] }, true)).toMatch(/not a thread/)
    expect(stillRefusal({ kind: 'local', caps: [] }, false)).toMatch(/own socket/)
    expect(stillRefusal({ kind: 'local', caps: [] }, true)).toBeNull()
  })
})
