import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ppmToBgra, ShotWorker, vmFrames, type Bitmap } from './shotWorker'

const dirs: string[] = []
const workers: ShotWorker[] = []
afterEach(() => {
  for (const worker of workers.splice(0)) worker.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A PPM of `width` by `height` whose pixel (x, y) is (x, y, 7). */
function ppm(width: number, height: number, header = `P6\n${width} ${height}\n255\n`): Uint8Array {
  const head = Buffer.from(header, 'latin1')
  const body = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) body.set([x, y, 7], (y * width + x) * 3)
  return Buffer.concat([head, body])
}

describe('a PPM shot as a small bitmap', () => {
  it('keeps a picture that already fits, as BGRA', () => {
    const { bgra, width, height } = ppmToBgra(ppm(3, 2), 640)
    expect([width, height]).toEqual([3, 2])
    // pixel (2, 1) is r=2 g=1 b=7
    expect([...bgra.slice((1 * 3 + 2) * 4, (1 * 3 + 2) * 4 + 4)]).toEqual([7, 1, 2, 255])
  })

  it('shrinks to the long edge asked, each pixel the mean of the block it covers', () => {
    const { bgra, width, height } = ppmToBgra(ppm(8, 4), 4)
    expect([width, height]).toEqual([4, 2])
    // output (1, 0) covers x 2..3, y 0..1: r mean 2.5 rounds to 3, g mean 0.5 rounds to 1
    expect([...bgra.slice(4, 8)]).toEqual([7, 1, 3, 255])
    expect(bgra.length).toBe(4 * 2 * 4)
  })

  it('reads a header with comments, and refuses what is not a whole 8-bit PPM', () => {
    expect(ppmToBgra(ppm(2, 2, 'P6\n# made by QEMU\n2 2\n255\n'), 64).width).toBe(2)
    expect(() => ppmToBgra(Buffer.from('P5\n2 2\n255\n'), 64)).toThrow(/not a PPM/)
    expect(() => ppmToBgra(Buffer.from('P6\n2 2\n65535\n'), 64)).toThrow(/not a PPM/)
    expect(() => ppmToBgra(ppm(4, 4).slice(0, 20), 64)).toThrow(/cut short/)
  })
})

describe('the shot worker', () => {
  it('reads the shot in its own thread, removes the file and hands back the bitmap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shot-'))
    dirs.push(dir)
    const file = join(dir, 'shot-1.ppm')
    writeFileSync(file, ppm(8, 4))
    const worker = new ShotWorker()
    workers.push(worker)
    const bitmap = await worker.shrink(file, 4)
    expect([bitmap.width, bitmap.height, bitmap.bgra.length]).toEqual([4, 2, 32])
    expect([...bitmap.bgra.slice(4, 8)]).toEqual([7, 1, 3, 255])
    expect(existsSync(file)).toBe(false)
    await expect(worker.shrink(join(dir, 'none.ppm'), 4)).rejects.toThrow()
  })
})

describe("the VM's frames", () => {
  const bitmap: Bitmap = { bgra: new Uint8Array(4), width: 1, height: 1 }
  const setup = (shrink: () => Promise<Bitmap>) => {
    const calls = { ppm: 0, fallback: 0, stopped: 0, jpeg: 0 }
    const logs: string[] = []
    const frames = vmFrames({
      dir: () => '/shots',
      ppm: async () => void calls.ppm++,
      worker: { shrink, stop: () => void calls.stopped++ },
      jpeg: () => (calls.jpeg++, 'anBn'),
      fallback: async () => (calls.fallback++, { data: 'cG5n', width: 2, height: 2 }),
      log: (line) => void logs.push(line)
    })
    return { frames, calls, logs }
  }

  it('makes a frame through the worker, the loop encoding only the small bitmap', async () => {
    const t = setup(async () => bitmap)
    expect(await t.frames.frame(640)).toEqual({ data: 'anBn', width: 1, height: 1 })
    expect(t.calls).toEqual({ ppm: 1, fallback: 0, stopped: 0, jpeg: 1 })
  })

  it('falls back to the PNG path at the first failure, and stays there', async () => {
    const t = setup(async () => {
      throw new Error('not a PPM picture')
    })
    expect(await t.frames.frame(640)).toEqual({ data: 'cG5n', width: 2, height: 2 })
    expect(await t.frames.frame(640)).toEqual({ data: 'cG5n', width: 2, height: 2 })
    expect(t.calls).toEqual({ ppm: 1, fallback: 2, stopped: 1, jpeg: 0 })
    expect(t.logs).toEqual(['winvm picture: the PPM path failed (not a PPM picture); PNG from here on'])
  })
})
