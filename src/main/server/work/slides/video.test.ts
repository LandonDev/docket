import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mp4Seconds, readJoined, SLIDEPICS_PY, VIDEO_CONVERTERS, videoArgs, videoSeconds } from './video'

const frames = (n: number): string[] => Array.from({ length: n }, (_, i) => `/f/${i}.png`)
/** The `-t` each picture is held for, in order. */
const holds = (args: string[]): number[] => args.flatMap((a, i) => (a === '-t' ? [Number(args[i + 1])] : []))

describe('the video of the slides', () => {
  it('holds each slide its seconds and a fade longer but the last, fading at k × seconds: 12 slides of 5 s run 60 s', () => {
    const args = videoArgs({ frames: frames(12), seconds: 5, fade: 0.5, fps: 30, output: '/o.mp4', threads: 4 })
    expect(holds(args)).toEqual([...Array(11).fill(5.5), 5])
    const graph = args[args.indexOf('-filter_complex') + 1]!
    const offsets = [...graph.matchAll(/xfade=transition=fade:duration=0\.5:offset=(\d+)/g)].map((m) => Number(m[1]))
    expect(offsets).toEqual([5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
    // The chain's length: the last fade starts at 55 and the last slide is held 5 after it.
    expect(offsets.at(-1)! + holds(args).at(-1)!).toBe(60)
    expect(videoSeconds(12, 5)).toBe(60)
    expect(args.slice(args.indexOf('-map'), args.indexOf('-map') + 3)).toEqual(['-map', '[x11]', '-an'])
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart']))
    expect(args.at(-1)).toBe('/o.mp4')
  })

  it('is silent, takes one picture as it is, joins without a fade when asked, and never fades past half a slide', () => {
    const one = videoArgs({ frames: frames(1), seconds: 5, fade: 0.5, fps: 30, output: '/o.mp4', threads: 1 })
    expect(holds(one)).toEqual([5])
    expect(one[one.indexOf('-map') + 1]).toBe('[s0]')
    expect(one).toContain('-an')
    const cut = videoArgs({ frames: frames(3), seconds: 3, fade: 0, fps: 30, output: '/o.mp4', threads: 1 })
    expect(holds(cut)).toEqual([3, 3, 3])
    expect(cut[cut.indexOf('-filter_complex') + 1]).toContain('[s0][s1][s2]concat=n=3:v=1:a=0[x]')
    const short = videoArgs({ frames: frames(2), seconds: 1, fade: 2, fps: 30, output: '/o.mp4', threads: 1 })
    expect(short[short.indexOf('-filter_complex') + 1]).toContain('duration=0.5:offset=1')
    expect(() => videoArgs({ frames: [], seconds: 5, fade: 0.5, fps: 30, output: '/o.mp4', threads: 1 })).toThrow()
  })

  it("reads an mp4's length from its movie header, and the joined pictures as the script packs them", () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-video-'))
    try {
      const mvhd = Buffer.alloc(40)
      mvhd.write('mvhd', 4)
      mvhd.writeUInt32BE(1000, 4 + 4 + 12) // timescale, version 0
      mvhd.writeUInt32BE(60_000, 4 + 4 + 16) // duration
      writeFileSync(join(dir, 'a.mp4'), Buffer.concat([Buffer.from('....ftypisom'), mvhd]))
      expect(mp4Seconds(join(dir, 'a.mp4'))).toBe(60)
      writeFileSync(join(dir, 'none.mp4'), Buffer.from('nothing here'))
      expect(mp4Seconds(join(dir, 'none.mp4'))).toBeNull()

      const parts = [Buffer.from('one'), Buffer.from('second')]
      const head = Buffer.alloc(4 + 16)
      head.writeUInt32BE(2)
      head.writeBigUInt64BE(3n, 4)
      head.writeBigUInt64BE(6n, 12)
      writeFileSync(join(dir, 'j.bin'), Buffer.concat([head, ...parts]))
      expect(readJoined(join(dir, 'j.bin')).map(String)).toEqual(['one', 'second'])
      writeFileSync(join(dir, 'cut.bin'), Buffer.concat([head, parts[0]!]))
      expect(() => readJoined(join(dir, 'cut.bin'))).toThrow('cut short')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs as two jobs of their own tools, and the Python keeps out of the string what would end it', () => {
    expect(VIDEO_CONVERTERS.map((c) => `${c.from} → ${c.to} (${c.needs})`)).toEqual(['pdf → slidepics (pdf-tools)', 'slidepics → slidevideo (ffmpeg)'])
    expect(SLIDEPICS_PY).not.toMatch(/`|\$\{/)
  })
})
