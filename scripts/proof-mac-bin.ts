/**
 * A delete in a library on a Mac, proven with the code's own bin (src/main/server/work/files/bin.ts, `macBin`):
 * dummy files only, in a folder of his OneDrive named "TempCode proof" (docs/agents/work-files.md "A delete in
 * a library"). Nothing else in the library is opened, read, changed or deleted.
 *
 *   bun scripts/proof-mac-bin.ts [library]     (default ~/Library/CloudStorage/OneDrive-purdue.edu)
 *
 * A file and a folder go to the Trash and are found there whole; each is put back where it was; a file put back
 * beside a new one of its name takes "(restored)"; a second Put back of the same thing is refused; and, where
 * `fileproviderctl evict` makes a file cloud-only, what the Trash does with it is said. The dummy folder ends in the
 * Trash, through the same call. Exits 1 on the first step that does not hold.
 */
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { macBin, NOT_IN_TRASH_BIN } from '../src/main/server/work/files/bin'

const LIB = process.argv[2] ?? join(homedir(), 'Library', 'CloudStorage', 'OneDrive-purdue.edu')
const DIR = join(LIB, `TempCode proof ${randomUUID().slice(0, 8)}`)
const log = (...a: unknown[]): void => console.log(`[proof ${new Date().toISOString().slice(11, 19)}]`, ...a)
function ok(cond: boolean, what: string, got: unknown): void {
  if (!cond) {
    console.error(`FAILED: ${what}\n${JSON.stringify(got, null, 2)}`)
    process.exit(1)
  }
  log(`ok: ${what}`)
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('The Finder Trash proof needs a Mac')
  if (!existsSync(LIB)) throw new Error(`No library at ${LIB}`)
  const bin = macBin()
  mkdirSync(join(DIR, 'TempCode proof folder'), { recursive: true })
  const file = join(DIR, 'TempCode proof.txt')
  writeFileSync(file, 'a dummy')
  writeFileSync(join(DIR, 'TempCode proof folder', 'in.txt'), 'in it')
  // Give OneDrive a moment to take the new things, as a person's delete would come later.
  await new Promise((r) => setTimeout(r, 15_000))

  const inBin = await bin.put(file, 'p1')
  log(`the file lies at ${inBin}`)
  ok(!existsSync(file) && !!inBin && existsSync(inBin) && readFileSync(inBin, 'utf8') === 'a dummy', 'a file goes to the Trash, whole, and the Trash says where', { inBin })
  const folder = join(DIR, 'TempCode proof folder')
  const dirBin = await bin.put(folder, 'p2')
  log(`the folder lies at ${dirBin}`)
  ok(!existsSync(folder) && !!dirBin && readFileSync(join(dirBin, 'in.txt'), 'utf8') === 'in it', 'a folder goes to the Trash, whole', { dirBin })

  const back = await bin.back!(inBin!, file, 'p3')
  ok(back === file && readFileSync(file, 'utf8') === 'a dummy' && !existsSync(inBin!), 'Put back: the file is where it was, whole', { back })
  mkdirSync(folder)
  const dirBack = await bin.back!(dirBin!, folder, 'p4')
  ok(dirBack === join(DIR, 'TempCode proof folder (restored)') && readFileSync(join(dirBack, 'in.txt'), 'utf8') === 'in it', 'Put back beside a new one of its name: "(restored)", whole', { dirBack })
  let twice = ''
  try {
    await bin.back!(dirBin!, folder, 'p5')
  } catch (err) {
    twice = (err as Error).message
  }
  ok(twice === NOT_IN_TRASH_BIN, 'a second Put back of the same thing is refused', twice)

  // A file kept only online, where the File Provider can make one.
  const cloud = join(DIR, 'TempCode proof cloud.txt')
  writeFileSync(cloud, 'online only')
  await new Promise((r) => setTimeout(r, 30_000))
  let evicted = false
  try {
    execFileSync('fileproviderctl', ['evict', cloud], { stdio: 'pipe', timeout: 60_000 })
    evicted = true
  } catch (error) {
    log(`SKIP cloud-only file: ${(error as Error).message.split('\n')[0]}`)
  }
  if (evicted) {
    try {
      const where = await bin.put(cloud, 'p6')
      ok(!!where && existsSync(where), 'the cloud-only dummy reaches the Trash', where)
      await bin.back!(where!, cloud, 'p7')
      ok(existsSync(cloud) && readFileSync(cloud, 'utf8') === 'online only', 'the cloud-only dummy returns whole', cloud)
    } catch (error) {
      ok(existsSync(cloud), 'a refused cloud-only dummy stays in the library', error)
      log(`the bin refused the cloud-only dummy: ${(error as Error).message}`)
    }
  }

  // The dummy folder leaves the library the same way: to the Trash.
  log(`the dummy folder ends in the Trash at ${await bin.put(DIR, 'p8')}`)
  log('ALL HELD')
}

main().catch((err) => {
  console.error(`FAILED: the proof threw\n${err instanceof Error ? err.stack : err}`)
  process.exit(1)
})
