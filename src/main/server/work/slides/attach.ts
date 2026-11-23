import { appendFileSync, copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { extname, isAbsolute, join } from 'node:path'
import type { SlideOp } from '@shared/contract-work-slides'
import { joinStep } from './deck'

/**
 * The files an edit brings to a deck (docs/agents/work-slides.md "Files an
 * edit brings"): a picture or a video for an `insert`. The file is kept in
 * the deck's `attach/` folder (`dir` below: view.ts `deckDir(…, 'attach')`)
 * under a name the host gives (a token), and an edit names it by that token
 * and nothing else: never a path. When the edit runs, the files ride with
 * the deck as one input, so a job another host runs has them too.
 */

const PICTURES = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff']
const VIDEOS = ['mp4', 'm4v', 'mov', 'wmv', 'avi', 'mpg', 'mpeg']
export const ATTACH_TOKEN = new RegExp(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(${[...PICTURES, ...VIDEOS].join('|')})$`)
export const PICTURE_MAX = 50 * 1024 * 1024
export const VIDEO_MAX = 500 * 1024 * 1024
/** A file brought and never used (an upload he walked away from) goes after this. */
const UNUSED_MS = 60 * 60_000

const extOf = (name: string): string => extname(name).slice(1).toLowerCase()
const capOf = (ext: string): number => (VIDEOS.includes(ext) ? VIDEO_MAX : PICTURE_MAX)
const sizeWords = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`

function tokenFor(name: string): string {
  const ext = extOf(name)
  if (!PICTURES.includes(ext) && !VIDEOS.includes(ext)) throw new Error(`${name} is not a picture or a video a deck can hold (PNG, JPEG, GIF, BMP, TIFF; MP4, MOV, WMV, AVI, MPEG).`)
  return `${randomUUID()}.${ext}`
}

/** One piece of a file he is adding by hand: the first piece names it and is answered its token, each next piece follows on. */
export function attachPiece(dir: string, piece: { name: string; token?: string; data: Buffer }): { token: string } {
  const token = piece.token ?? tokenFor(piece.name)
  if (!ATTACH_TOKEN.test(token)) throw new Error('That is not a file being added to this deck.')
  const path = join(dir, token)
  if (piece.token !== undefined && !existsSync(path)) throw new Error('That is not a file being added to this deck.')
  const cap = capOf(extOf(token))
  const size = (existsSync(path) ? statSync(path).size : 0) + piece.data.length
  if (size > cap) {
    rmSync(path, { force: true })
    throw new Error(`${piece.name} is larger than ${sizeWords(cap)}, the most a deck here takes.`)
  }
  appendFileSync(path, piece.data, { mode: 0o600 })
  return { token }
}

/** A file on this host an agent's edit brings: copied in, so the edit still has it when the file moves on. */
export function attachFile(dir: string, path: string): string {
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isFile()) throw new Error(`There is no file at ${path}.`)
  const token = tokenFor(path)
  const cap = capOf(extOf(token))
  if (statSync(path).size > cap) throw new Error(`${path} is larger than ${sizeWords(cap)}, the most a deck here takes.`)
  copyFileSync(path, join(dir, token))
  return token
}

/**
 * The edits and the deck as an edit job takes them. Edits that bring no file go as they are. With files, the
 * input becomes the deck and its files as one (`pptxplus`, written to `joined`), and each edit names its file as
 * the job lays it out (`f0.png`). A token that is not a file of this deck is left as it is: the tool then says the
 * file did not come.
 */
export function withAttached(dir: string, joined: string, input: string, ops: SlideOp[]): { from: 'pptx' | 'pptxplus'; input: string; ops: SlideOp[]; files: string[]; done(): void } {
  if (!ops.some((op) => op.op === 'insert' && op.file !== undefined)) return { from: 'pptx', input, ops, files: [], done() {} }
  const files: string[] = []
  const paths: string[] = []
  const named = ops.map((op) => {
    if (op.op !== 'insert' || op.file === undefined || !ATTACH_TOKEN.test(op.file) || !existsSync(join(dir, op.file))) return op
    const name = `f${files.length}${extname(op.file)}`
    files.push(name)
    paths.push(join(dir, op.file))
    return { ...op, file: name }
  })
  if (!paths.length) return { from: 'pptx', input, ops: named, files, done() {} }
  joinStep([input, ...paths], joined)
  return { from: 'pptxplus', input: joined, ops: named, files, done: () => rmSync(joined, { force: true }) }
}

/** Lets go of the files no waiting edit names any more: at once for those an edit used, after an hour for one brought and never used. */
export function sweepAttached(dir: string, waiting: readonly SlideOp[], used: readonly string[] = []): void {
  const kept = new Set(waiting.flatMap((op) => (op.op === 'insert' && op.file ? [op.file] : [])))
  for (const name of readdirSync(dir)) {
    if (kept.has(name)) continue
    const path = join(dir, name)
    try {
      if (used.includes(name) || Date.now() - statSync(path).mtimeMs > UNUSED_MS) rmSync(path, { force: true })
    } catch {
      /* gone */
    }
  }
}
