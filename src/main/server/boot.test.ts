import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const appended: string[] = []
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  appendFileSync: (file: string) => void appended.push(file)
}))

afterEach(() => {
  appended.length = 0
  vi.restoreAllMocks()
})

describe('the boot trail', () => {
  it('a boot step is written to the boot log at once; a slow request makes no synchronous write', async () => {
    const { BOOT_LOG, bootMark, bootNote } = await import('./boot')
    const said: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => void said.push(line))
    bootMark('db-open')
    expect(appended).toEqual([BOOT_LOG])
    bootNote('slow-request', 'session.list 900ms')
    expect(appended).toEqual([BOOT_LOG])
    expect(said[1]).toMatch(/^\[boot\] \d+ slow-request session\.list 900ms$/)
  })

  it("the server's slow-request line is the note, never the mark", () => {
    const index = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    expect(index).toContain("bootNote('slow-request'")
    expect(index).not.toContain("bootMark('slow-request'")
  })
})
