import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DeckPoint } from '@shared/contract-work-slides'
import { makeMedia, mediaFile, pruneMedia, showMedia, sniffType, type MediaDeps, type MediaSlide } from './media'

/** A slide's video and sound: taken out once, made playable once by the hash of its bytes, and where a show reads it. */

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-slides-media-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const quad: [DeckPoint, DeckPoint, DeckPoint, DeckPoint] = [
  [0.1, 0.2],
  [0.5, 0.2],
  [0.5, 0.6],
  [0.1, 0.6]
]
const draws = (n: number): string => n.toString(16).padStart(64, '0')
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)])
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8)])

function rig(bytes: Record<string, Buffer>) {
  const calls: string[] = []
  const deps: MediaDeps = {
    dir: join(dir, 'media'),
    extract: async (slide, shape, output) => {
      calls.push(`extract ${slide}/${shape}`)
      writeFileSync(output, bytes[`${slide}/${shape}`])
    },
    playable: async (input, output) => {
      calls.push('playable')
      writeFileSync(output, readFileSync(input))
    },
    log: (line) => void calls.push(`log ${line}`),
    onMade: () => void calls.push('made')
  }
  return { deps, calls }
}

describe("a slide's media", () => {
  const slides: MediaSlide[] = [
    { id: 256, draws: draws(1), shapes: [{ id: 2, kind: 'text' }] },
    { id: 257, draws: draws(2), shapes: [{ id: 3, kind: 'media', media: 'video', quad }, { id: 4, kind: 'media', media: 'audio', quad }] }
  ]

  it('takes each out, makes it playable, and tells a show its type and where to read it', async () => {
    const { deps, calls } = rig({ '257/3': MP4, '257/4': WAV })
    expect(showMedia(deps.dir, slides[1])).toEqual([
      { shape: 3, kind: 'video', quad },
      { shape: 4, kind: 'audio', quad }
    ])
    expect(await makeMedia(deps, slides)).toBe(2)
    expect(calls).toEqual(['extract 257/3', 'playable', 'made', 'extract 257/4', 'playable', 'made'])
    const shown = showMedia(deps.dir, slides[1])!
    expect(shown[0].file).toMatchObject({ type: 'video/mp4', size: MP4.length })
    expect(shown[1].file).toMatchObject({ type: 'audio/wav', size: WAV.length })
    expect(mediaFile(deps.dir, slides[1], 3)?.path.startsWith(join(deps.dir, shown[0].file!.rev))).toBe(true)
    expect(showMedia(deps.dir, slides[0])).toBeUndefined()
  })

  it('makes the same bytes playable once, whatever slide holds them, and never again for the same slide', async () => {
    const { deps, calls } = rig({ '257/3': MP4, '257/4': MP4 })
    await makeMedia(deps, slides)
    expect(calls.filter((c) => c === 'playable')).toHaveLength(1)
    calls.length = 0
    expect(await makeMedia(deps, slides)).toBe(0)
    expect(calls).toEqual([])
  })

  it('keeps a clip as it is when it cannot be made playable here', async () => {
    const { deps, calls } = rig({ '257/3': MP4, '257/4': WAV })
    deps.playable = async () => {
      throw new Error('ffmpeg is not installed here')
    }
    expect(await makeMedia(deps, slides)).toBe(2)
    expect(calls.filter((c) => c.startsWith('log'))).toHaveLength(2)
    expect(showMedia(deps.dir, slides[1])![1].file?.type).toBe('audio/wav')
  })

  it('names a type by the first bytes', () => {
    expect(sniffType(MP4, true)).toBe('video/mp4')
    expect(sniffType(MP4, false)).toBe('audio/mp4')
    expect(sniffType(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), true)).toBe('video/webm')
    expect(sniffType(Buffer.from('ID3\x03'), false)).toBe('audio/mpeg')
    expect(sniffType(Buffer.from('OggS'), false)).toBe('audio/ogg')
  })

  it('keeps the newest clips and drops the notes of the ones it let go', async () => {
    const { deps } = rig({ '257/3': MP4, '257/4': WAV })
    await makeMedia(deps, slides)
    const old = readdirSync(deps.dir).find((f) => f.endsWith('.play') && readFileSync(join(deps.dir, f)).equals(MP4))!
    utimesSync(join(deps.dir, old), new Date(0), new Date(0))
    pruneMedia(deps.dir, 1)
    expect(mediaFile(deps.dir, slides[1], 3)).toBeNull()
    expect(mediaFile(deps.dir, slides[1], 4)).not.toBeNull()
  })
})
