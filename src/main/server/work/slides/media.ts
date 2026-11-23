import { createHash, randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DeckPoint, ShowMedia } from '@shared/contract-work-slides'

/**
 * A slide's video and sound in a show (docs/agents/work-slides.md "Video and sound"): taken out of the deck's
 * package once (`pptx → slidemedia`), made an .mp4 the app plays when it cannot play the file as it is
 * (`slidemedia → playable`, ffmpeg as a process of its own), and kept by the hash of its bytes, so a slide edited
 * around a long video never makes it again. Each shape's note (`<key>.json`) names its playable file and type.
 */

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

export interface MediaSlide {
  id: number
  draws?: string
  shapes: ReadonlyArray<{ id: number; kind?: string; media?: 'video' | 'audio'; quad?: [DeckPoint, DeckPoint, DeckPoint, DeckPoint] }>
}

/** A media shape's note: by the slide's picture hash (which holds the media's bytes) and the shape. */
const noteKey = (draws: string, shape: number): string => sha(`media:${draws}:${shape}`)
interface Note {
  file: string
  type: string
  size: number
}

/** The kept playable file of a slide's media shape; null while it is not made. */
export function mediaFile(dir: string, s: MediaSlide, shape: number): { path: string; rev: string; size: number; type: string } | null {
  if (!s.draws) return null
  try {
    const note = JSON.parse(readFileSync(join(dir, `${noteKey(s.draws, shape)}.json`), 'utf8')) as Note
    const path = join(dir, note.file)
    return { path, rev: note.file.slice(0, 16), size: statSync(path).size, type: note.type }
  } catch {
    return null
  }
}

/** A slide's media as a show reads it; undefined for a slide with none. */
export function showMedia(dir: string, s: MediaSlide): ShowMedia[] | undefined {
  const list = s.shapes.flatMap((sh): ShowMedia[] => {
    if (sh.kind !== 'media' || !sh.quad) return []
    const file = mediaFile(dir, s, sh.id)
    return [{ shape: sh.id, kind: sh.media === 'audio' ? 'audio' : 'video', quad: sh.quad, ...(file ? { file: { rev: file.rev, size: file.size, type: file.type } } : {}) }]
  })
  return list.length ? list : undefined
}

/** A file's type by its first bytes, as the app's player is told it. */
export function sniffType(head: Buffer, video: boolean): string {
  const at = (i: number, s: string): boolean => head.subarray(i, i + s.length).toString('latin1') === s
  if (at(4, 'ftyp')) return video ? 'video/mp4' : 'audio/mp4'
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return video ? 'video/webm' : 'audio/webm'
  if (at(0, 'OggS')) return video ? 'video/ogg' : 'audio/ogg'
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'audio/wav'
  if (at(0, 'fLaC')) return 'audio/flac'
  if (at(0, 'ID3') || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return 'audio/mpeg'
  return video ? 'video/mp4' : 'audio/mp4'
}

function headOf(path: string): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(16)
    const n = readSync(fd, buf, 0, 16, 0)
    return buf.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

function hashFileOf(path: string): string {
  const h = createHash('sha256')
  const fd = openSync(path, 'r')
  const buf = Buffer.alloc(1 << 20)
  try {
    for (let n: number; (n = readSync(fd, buf, 0, buf.length, null)) > 0; ) h.update(buf.subarray(0, n))
  } finally {
    closeSync(fd)
  }
  return h.digest('hex')
}

export interface MediaDeps {
  /** where the media are kept: the deck's own folder, so a shared library's file keeps them in its item */
  dir: string
  /** takes a shape's media out of the deck (the `pptx → slidemedia` converter) */
  extract(slide: number, shape: number, output: string, signal?: AbortSignal): Promise<void>
  /** the file as the app can play it (the `slidemedia → playable` converter) */
  playable(input: string, output: string, signal?: AbortSignal): Promise<void>
  log?: (line: string) => void
  onMade?: () => void
}

/** How many playable files a deck keeps, newest first. */
export const MEDIA_KEPT = 24

/**
 * Takes out and makes playable every media shape of the deck not yet kept. One that cannot be made playable (no
 * ffmpeg here) is kept as it is, and the app plays it if it can. Answers how many were made.
 */
export async function makeMedia(deps: MediaDeps, slides: readonly MediaSlide[], signal?: AbortSignal): Promise<number> {
  let made = 0
  for (const s of slides) {
    for (const sh of s.shapes) {
      if (sh.kind !== 'media' || !s.draws || mediaFile(deps.dir, s, sh.id)) continue
      signal?.throwIfAborted()
      mkdirSync(deps.dir, { recursive: true, mode: 0o700 })
      const tag = randomUUID().slice(0, 8)
      const src = join(deps.dir, `.src-${tag}`)
      const play = join(deps.dir, `.play-${tag}`)
      try {
        await deps.extract(s.id, sh.id, src, signal)
        const file = `${hashFileOf(src)}.play`
        const path = join(deps.dir, file)
        if (!existsSync(path)) {
          try {
            await deps.playable(src, play, signal)
          } catch (err) {
            if (signal?.aborted) throw err
            deps.log?.(`slides: a slide's media is kept as it is: ${err instanceof Error ? err.message : String(err)}`)
            copyFileSync(src, play)
          }
          renameSync(play, path)
        } else utimesSync(path, new Date(), new Date())
        const note: Note = { file, type: sniffType(headOf(path), sh.media !== 'audio'), size: statSync(path).size }
        const tmp = join(deps.dir, `.note-${tag}`)
        writeFileSync(tmp, JSON.stringify(note))
        renameSync(tmp, join(deps.dir, `${noteKey(s.draws, sh.id)}.json`))
        made++
        deps.onMade?.()
      } catch (err) {
        if (signal?.aborted) throw err
        deps.log?.(`slides: a slide's media was not taken out: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        rmSync(src, { force: true })
        rmSync(play, { force: true })
      }
    }
  }
  if (made) pruneMedia(deps.dir, MEDIA_KEPT)
  return made
}

/** Keeps the newest `keep` playable files and the notes that name them. */
export function pruneMedia(dir: string, keep: number): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  const at = (f: string): number => {
    try {
      return statSync(join(dir, f)).mtimeMs
    } catch {
      return 0
    }
  }
  const files = names.filter((f) => f.endsWith('.play')).sort((a, b) => at(b) - at(a))
  const gone = new Set(files.slice(keep))
  for (const f of gone) rmSync(join(dir, f), { force: true })
  for (const f of names.filter((n) => n.endsWith('.json'))) {
    try {
      if (gone.has((JSON.parse(readFileSync(join(dir, f), 'utf8')) as Note).file)) rmSync(join(dir, f), { force: true })
    } catch {
      rmSync(join(dir, f), { force: true })
    }
  }
}
