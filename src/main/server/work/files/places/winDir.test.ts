import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { DIR_HELPER_CS, WinDirHost } from './winDir'

/** The folder helper's Node side (winDir.ts): one process, a line a folder, answers by id in any order. The C# itself is proven in the rig. */

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A stand-in helper: answers each folder line with what `answer` says, or holds it. */
function fakeHelper(answer: (id: number, path: string) => string | null): { spawned: () => ChildProcess; asked: string[] } {
  const asked: string[] = []
  const spawned = (): ChildProcess => {
    const proc = new EventEmitter() as ChildProcess
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    Object.assign(proc, { stdin, stdout })
    let buffer = ''
    stdin.on('data', (d: Buffer) => {
      buffer += d.toString()
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const [id, path] = buffer.slice(0, nl).split('\t') as [string, string]
        buffer = buffer.slice(nl + 1)
        asked.push(path)
        const line = answer(Number(id), path)
        if (line !== null) setTimeout(() => stdout.write(`${line}\n`), path.endsWith('slow') ? 20 : 0)
      }
    })
    return proc
  }
  return { spawned, asked }
}

const host = (helper: ReturnType<typeof fakeHelper>, compile?: () => Promise<void>): WinDirHost => {
  const at = mkdtempSync(join(tmpdir(), 'tc-windir-'))
  dirs.push(at)
  return new WinDirHost({ exe: join(at, 'dir.exe'), csc: 'csc', compile: compile ?? (async (_c, _s, out) => void (await import('node:fs')).writeFileSync(out, '')), spawnHelper: helper.spawned, log: () => {} })
}

describe('the folder helper', () => {
  it('answers each folder by its id, several at once, in whatever order they finish', async () => {
    const helper = fakeHelper((id, path) => JSON.stringify({ id, rows: [[path.split('\\').pop(), 0, 7, 1_700_000_000_000, 32]] }))
    const h = host(helper)
    const [slow, fast] = await Promise.all([h.read('J:\\Bench\\slow'), h.read('J:\\Bench\\fast')])
    expect(slow).toEqual([['slow', 0, 7, 1_700_000_000_000, 32]])
    expect(fast).toEqual([['fast', 0, 7, 1_700_000_000_000, 32]])
    expect(helper.asked).toEqual(['J:\\Bench\\slow', 'J:\\Bench\\fast'])
  })

  it("says the folder's own failure", async () => {
    const h = host(fakeHelper((id) => JSON.stringify({ id, error: 'UnauthorizedAccessException: Access to the path is denied.' })))
    await expect(h.read('J:\\Locked')).rejects.toThrow('Access to the path is denied')
  })

  it('answers null for good when it cannot be compiled, so the folder is read the slow way', async () => {
    let tries = 0
    const h = host(
      fakeHelper(() => null),
      async () => {
        tries++
        throw new Error('csc.exe is not there')
      }
    )
    expect(await h.read('J:\\Bench')).toBeNull()
    expect(await h.read('J:\\Bench')).toBeNull()
    expect(tries).toBe(1)
  })

  it('is a C# program of one class that reads a folder once and writes a line', () => {
    expect(DIR_HELPER_CS).toContain('EnumerateFileSystemInfos()')
    // csc.exe 4.0 reads C# 5: no interpolated strings, no expression bodies.
    expect(DIR_HELPER_CS).not.toMatch(/\$"|=>/)
  })
})

describe('what Settings and doctor.get say of folders on mapped drives', () => {
  it('names the slow path and why, on Windows alone', async () => {
    const { folderReader } = await import('./winDir')
    const broken = host(fakeHelper(() => null), async () => Promise.reject(new Error('csc.exe was refused by policy')))
    expect(folderReader('win32', broken)).toMatchObject({ mode: 'not started' })
    expect(await broken.read('J:\\Bench')).toBeNull()
    expect(folderReader('win32', broken)).toEqual({ mode: 'row by row', words: 'Read row by row, which is slower: Windows did not let Docket make its folder reader.', why: 'csc.exe was refused by policy' })
    const working = host(fakeHelper((id) => JSON.stringify({ id, rows: [] })))
    await working.read('J:\\Bench')
    expect(folderReader('win32', working)).toMatchObject({ mode: 'one read', words: 'Read in one go.' })
    expect(folderReader('darwin', working)).toBeNull()
  })
})
