import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { canvasSourcePath, type CanvasSource } from '@shared/work'
import { errorText } from '@shared/work/ids'
import { KEYNOTE_EXPORT, type SlideImportExt } from '@shared/work/slideFormats'
import { macBridgeLandingRoot } from '../../macBridgeLanding'
import type { WorkCtx } from '../modules'
import { libreOffice } from '../formats'
import { NoConverterError, NotReadyError } from '../formats/jobs'
import { hasMagic, ItemFileError } from '../pdf/file'

export const SLIDES_IMPORT_CONVERTERS = ['pps', 'ppsx', 'key'].map((ext) => libreOffice(ext, 'pptx'))

export const NOT_KEYNOTE = 'This is not a Keynote deck.'

/** Files may seat a snapshot made by the legacy Teams view as an ordinary file item. */
export function isTeamsSnapshot(dataDir: string, source: CanvasSource): boolean {
  const path = canvasSourcePath(source)
  if (!path) return false
  const real = (name: string): string => {
    try {
      return realpathSync(name)
    } catch {
      return name
    }
  }
  const root = join(macBridgeLandingRoot(dataDir), 'teams-files')
  const inside = (base: string, file: string): boolean => {
    const at = relative(base, file)
    return !!at && at !== '..' && !at.startsWith(`..${sep}`) && !isAbsolute(at)
  }
  return inside(root, path) || inside(real(root), real(path))
}

/** What a snapshot was made from: the original's size, time and bytes when it was converted. */
interface Stamp {
  size: number
  mtimeMs: number
  sha256: string
}

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

function keptStamp(path: string): Stamp | null {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8')) as Stamp
    return typeof s.size === 'number' && typeof s.mtimeMs === 'number' && typeof s.sha256 === 'string' ? s : null
  } catch {
    return null
  }
}

function keepStamp(path: string, stamp: Stamp): void {
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`
  writeFileSync(tmp, JSON.stringify(stamp), { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * A Keynote deck as it lies on disk: one file is a zip (Keynote '09 and later); a package is a folder. Anything else
 * (a `server.key`, a PEM key) is refused before a byte of it reaches a converter.
 */
function keynoteForm(path: string): 'file' | 'package' {
  if (statSync(path).isDirectory()) {
    if (['Index.zip', 'Index', 'index.apxl', 'index.apxl.gz'].some((name) => existsSync(join(path, name)))) return 'package'
  } else if (hasMagic(path, 'zip')) return 'file'
  throw new ItemFileError(NOT_KEYNOTE)
}

/** Whether a conversion failed because of the file itself, not because the converter was missing, busy, slow or stopped. */
const importFailed = (err: unknown, signal?: AbortSignal): boolean =>
  !signal?.aborted && !(err instanceof NoConverterError) && !(err instanceof NotReadyError) && !/timed out|cancelled|not installed/i.test(errorText(err))

/**
 * The converted `.pptx` of an imported deck, made in `dir` (the caller holds the deck's queue). Nobody edits it, so
 * when the original changed since (its size or time moved and its bytes differ) it is made again.
 */
export async function convertedDeck(ctx: Pick<WorkCtx, 'convert'>, input: string, dir: string, from: SlideImportExt, job: { shared?: true }, signal?: AbortSignal): Promise<string> {
  // A package folder is a real Keynote deck the converter cannot take as one file: his way on is Keynote's own export.
  if (from === 'key' && keynoteForm(input) === 'package') throw new ItemFileError(KEYNOTE_EXPORT)
  const path = join(dir, 'deck.pptx')
  const stampPath = join(dir, 'source.json')
  const now = statSync(input)
  if (now.isDirectory()) throw new ItemFileError('That is a folder, not a deck.')
  const kept = existsSync(path) ? keptStamp(stampPath) : null
  if (kept && kept.size === now.size && kept.mtimeMs === now.mtimeMs) return path
  const bytes = sha(input)
  if (kept && kept.size === now.size && kept.sha256 === bytes) {
    keepStamp(stampPath, { size: now.size, mtimeMs: now.mtimeMs, sha256: bytes })
    return path
  }
  const tmp = join(dir, `${randomUUID()}.pptx`)
  try {
    await ctx.convert({ from, to: 'pptx', input, output: tmp, ...job, signal })
    if (!hasMagic(tmp, 'zip')) throw new ItemFileError('The converter did not make a PowerPoint deck.')
    signal?.throwIfAborted()
    renameSync(tmp, path)
    // Stamped with the original as it was before the conversion began: a change made meanwhile converts again.
    keepStamp(stampPath, { size: now.size, mtimeMs: now.mtimeMs, sha256: bytes })
    return path
  } catch (err) {
    if (from === 'key' && importFailed(err, signal)) throw new ItemFileError(KEYNOTE_EXPORT)
    throw err
  } finally {
    rmSync(tmp, { force: true })
  }
}
