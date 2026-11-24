import { execFile } from 'node:child_process'
import { lstatSync, type Stats } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'

/**
 * A computer's own bin, for a delete in a library on this host's disk (docs/agents/work-files.md "A delete in a
 * library"). `put` sends a file or folder there, never deleting it for good (a thing the bin will not take is
 * refused, and left), and answers where it lies in the bin, or null when the bin does not say. `back` puts a thing
 * from the bin where it was, never over anything, and answers its path; absent where the bin cannot be asked so.
 * Node alone, no other module of the app: a Mac proof runs it as it is (scripts/proof-mac-bin.ts).
 */
export interface SystemBin {
  put(path: string, op: string): Promise<string | null>
  back?(bin: string, to: string, op: string): Promise<string>
}

/**
 * The Mac's Trash through the Foundation call the Finder's own Move to Trash makes (`trashItemAtURL`), from
 * AppleScriptObjC: where the volume has no Trash it fails and leaves the thing, rather than delete it; it answers
 * where the thing now lies ("OK:<path>") or why not ("NO:<words>"). JXA's out-parameters crash osascript after the
 * move (macOS 27.2, 2026-11-23), so it is not used.
 */
export const MAC_TRASH = [
  'use framework "Foundation"',
  'on run argv',
  "set fm to current application's NSFileManager's defaultManager()",
  "set {ok, outURL, err} to fm's trashItemAtURL:(current application's NSURL's fileURLWithPath:(item 1 of argv)) resultingItemURL:(reference) |error|:(reference)",
  'if ok and outURL is missing value then return "OK:"',
  "if ok then return \"OK:\" & ((outURL's |path|()) as text)",
  "return \"NO:\" & ((err's localizedDescription()) as text)",
  'end run'
]

/** What MAC_TRASH answered: where the thing lies, null when the Trash did not say, or the Trash's refusal. */
export function macTrashAnswer(stdout: string): { at: string | null } | { refused: string } {
  const said = stdout.trim()
  if (said.startsWith('OK:')) return { at: said.slice(3) || null }
  return { refused: said.startsWith('NO:') ? said.slice(3) : said }
}

const lstatOr = (path: string): Stats | null => {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

/** The sentence a refusing bin's words make: the thing was left where it is. */
export function binRefused(name: string, bin: string, err: unknown): Error {
  const said = (err instanceof Error ? err.message : String(err)).replace(/^[\s\S]*execution error: /, '').replace(/ \(-?\d+\)\s*$/, '').trim()
  return new Error(`${name} could not go to the ${bin}, so it was left where it is${said ? `: ${said}` : '.'}`)
}

/** "notes.txt" put back beside one of its name: "notes (restored).txt", then "notes (restored) 2.txt", as freeName says it. */
export function restoredName(name: string, i: number): string {
  const ext = extname(name)
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name
  return `${stem} (restored)${i > 1 ? ` ${i}` : ''}${ext !== name ? ext : ''}`
}

export const NOT_IN_TRASH_BIN = 'That is not in the Trash any more.'
export const FOLDER_GONE = 'The folder it was in is gone. Put it back from the Trash.'

const FROM_MAC_TRASH = 'The item could not be put back here. Put it back from the Trash.'

// Darwin's RENAME_EXCL (0x4) rejects an existing destination in the same syscall, even for an empty folder.
// The system JavaScript bridge passes two C strings and reads an int. There are no out-parameters.
const MAC_MOVE = [
  'ObjC.bindFunction("renamex_np", ["int", ["string", "string", "unsigned int"]])',
  'function run(argv) { return $.renamex_np(argv[0], argv[1], 4) }'
].join('\n')

function macMoveExclusive(from: string, to: string): Promise<boolean> {
  return new Promise((resolve, reject) =>
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_MOVE, from, to], { timeout: 60_000 }, (err, stdout) => {
      if (err) return reject(new Error(FROM_MAC_TRASH, { cause: err }))
      const status = String(stdout).trim()
      if (status === '0' || status === '-1') return resolve(status === '0')
      reject(new Error(FROM_MAC_TRASH))
    })
  )
}

/** The Mac's Trash. Put Back uses an exclusive rename, retrying with a "(restored)" name if another item is there. */
export function macBin(): SystemBin {
  return {
    put: (path) =>
      new Promise((resolve, reject) =>
        execFile('osascript', [...MAC_TRASH.flatMap((line) => ['-e', line]), path], { timeout: 60_000 }, (err, stdout) => {
          if (err) return reject(binRefused(basename(path), 'Trash', err))
          const got = macTrashAnswer(String(stdout))
          if ('refused' in got) reject(binRefused(basename(path), 'Trash', new Error(got.refused)))
          else resolve(got.at)
        })
      ),
    async back(bin, to) {
      if (!lstatOr(bin)) throw new Error(NOT_IN_TRASH_BIN)
      const dir = dirname(to)
      if (!lstatOr(dir)?.isDirectory()) throw new Error(FOLDER_GONE)
      for (let i = 0; i < 20; i++) {
        const at = join(dir, i === 0 ? basename(to) : restoredName(basename(to), i))
        if (lstatOr(at)) continue
        if (await macMoveExclusive(bin, at)) return at
        if (lstatOr(at)) continue
        if (!lstatOr(bin)) throw new Error(NOT_IN_TRASH_BIN)
        if (!lstatOr(dir)?.isDirectory()) throw new Error(FOLDER_GONE)
        throw new Error(FROM_MAC_TRASH)
      }
      throw new Error(`Too many things named like ${basename(to)} are there already.`)
    }
  }
}

/** Linux's own bin (`gio trash`), which never deletes for good; it cannot be asked to put a thing back by path. */
export function gioBin(): SystemBin {
  return { put: (path) => new Promise((resolve, reject) => execFile('gio', ['trash', '--', path], { timeout: 60_000 }, (err) => (err ? reject(binRefused(basename(path), 'Trash', err)) : resolve(null)))) }
}
