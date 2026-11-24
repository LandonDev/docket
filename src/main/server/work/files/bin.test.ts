import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { binRefused, FOLDER_GONE, MAC_TRASH, macBin, macTrashAnswer, NOT_IN_TRASH_BIN, restoredName } from './bin'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, lstatSync: vi.fn(fs.lstatSync) }
})

vi.mock('node:child_process', async (importOriginal) => {
  const child = await importOriginal<typeof import('node:child_process')>()
  if (process.platform === 'darwin') return child
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...child,
    // Run the same script on Linux, with a stand-in for the Darwin system call.
    execFile: (file: string, args: string[], _opts: unknown, done: (err: Error | null, stdout: string) => void) => {
      expect(file).toBe('/usr/bin/osascript')
      expect(args.slice(0, 3)).toEqual(['-l', 'JavaScript', '-e'])
      const result = runInNewContext(args[3] + '\nrun(argv)', {
        argv: args.slice(4),
        ObjC: { bindFunction: (name: string) => expect(name).toBe('renamex_np') },
        $: {
          renamex_np(from: string, to: string, flags: number) {
            expect(flags).toBe(4)
            if (fs.lstatSync(to, { throwIfNoEntry: false })) return -1
            fs.renameSync(from, to)
            return 0
          }
        }
      })
      done(null, String(result))
    }
  }
})

/** The Mac's bin (bin.ts): the Trash's answer read, its refusal said, and Put back by path on a scratch folder. */

describe("the Mac's Trash", () => {
  it('asks Foundation to trash an item through AppleScriptObjC', () => {
    expect(MAC_TRASH[0]).toBe('use framework "Foundation"')
    expect(MAC_TRASH.join('\n')).toContain('trashItemAtURL:')
    expect(MAC_TRASH.join('\n')).not.toContain('ObjC.import')
  })

  it('reads where the thing lies, a Trash that did not say, and a refusal', () => {
    expect(macTrashAnswer('OK:/Users/a/.Trash/Plan.docx\n')).toEqual({ at: '/Users/a/.Trash/Plan.docx' })
    expect(macTrashAnswer('OK:')).toEqual({ at: null })
    expect(macTrashAnswer('NO:The volume has no Trash.')).toEqual({ refused: 'The volume has no Trash.' })
  })

  it('says a refusal as a plain sentence: the thing was left where it is', () => {
    expect(binRefused('Plan.docx', 'Trash', new Error('Command failed: osascript … execution error: The volume has no Trash. (-1728)')).message).toBe('Plan.docx could not go to the Trash, so it was left where it is: The volume has no Trash.')
    expect(binRefused('Plan.docx', 'Trash', new Error('')).message).toBe('Plan.docx could not go to the Trash, so it was left where it is.')
  })

  it('names a thing put back beside one of its name as freeName does', () => {
    expect(restoredName('notes.txt', 1)).toBe('notes (restored).txt')
    expect(restoredName('notes.txt', 2)).toBe('notes (restored) 2.txt')
    expect(restoredName('Budgets', 1)).toBe('Budgets (restored)')
  })
})

describe('Put back from the Trash by path', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-bin-'))
    mkdirSync(join(dir, 'Trash'))
    mkdirSync(join(dir, 'Library'))
  })
  afterEach(() => {
    vi.mocked(lstatSync).mockReset()
    rmSync(dir, { recursive: true, force: true })
  })

  it('goes back where it was, beside a new one as "(restored)", and never twice', async () => {
    const bin = macBin()
    writeFileSync(join(dir, 'Trash', 'Plan.docx'), 'word')
    expect(await bin.back!(join(dir, 'Trash', 'Plan.docx'), join(dir, 'Library', 'Plan.docx'), 'op')).toBe(join(dir, 'Library', 'Plan.docx'))
    expect(readFileSync(join(dir, 'Library', 'Plan.docx'), 'utf8')).toBe('word')
    writeFileSync(join(dir, 'Trash', 'Plan.docx'), 'older')
    expect(await bin.back!(join(dir, 'Trash', 'Plan.docx'), join(dir, 'Library', 'Plan.docx'), 'op')).toBe(join(dir, 'Library', 'Plan (restored).docx'))
    expect(readFileSync(join(dir, 'Library', 'Plan.docx'), 'utf8')).toBe('word')
    await expect(bin.back!(join(dir, 'Trash', 'Plan.docx'), join(dir, 'Library', 'Plan.docx'), 'op')).rejects.toThrow(NOT_IN_TRASH_BIN)
  })

  it.each(['file', 'folder'])('keeps a %s that appears between the name check and Put Back', async (kind) => {
    const name = kind === 'folder' ? 'Budgets' : 'Plan.docx'
    const from = join(dir, 'Trash', name)
    const to = join(dir, 'Library', name)
    const sibling = join(dir, 'Library', restoredName(name, 1))
    if (kind === 'folder') {
      mkdirSync(from)
      writeFileSync(join(from, 'saved.txt'), 'in Trash')
    } else writeFileSync(from, 'in Trash')

    const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
    let syncedInode: number | undefined
    vi.mocked(lstatSync).mockImplementation(((path: string) => {
      if (path !== to || syncedInode !== undefined) return fs.lstatSync(path)
      try {
        return fs.lstatSync(path)
      } catch (err) {
        if (kind === 'folder') mkdirSync(to)
        else writeFileSync(to, 'from sync')
        syncedInode = statSync(to).ino
        throw err
      }
    }) as typeof lstatSync)

    expect(await macBin().back!(from, to, 'op')).toBe(sibling)
    expect(syncedInode).toBeDefined()
    expect(statSync(to).ino).toBe(syncedInode)
    if (kind === 'file') expect(readFileSync(to, 'utf8')).toBe('from sync')
    expect(readFileSync(kind === 'folder' ? join(sibling, 'saved.txt') : sibling, 'utf8')).toBe('in Trash')
    expect(existsSync(from)).toBe(false)
  })

  it('refuses where the folder it was in is gone', async () => {
    writeFileSync(join(dir, 'Trash', 'a.txt'), 'x')
    await expect(macBin().back!(join(dir, 'Trash', 'a.txt'), join(dir, 'Gone', 'a.txt'), 'op')).rejects.toThrow(FOLDER_GONE)
  })
})
