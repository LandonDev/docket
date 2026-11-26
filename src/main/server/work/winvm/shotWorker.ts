import { Worker } from 'node:worker_threads'

/**
 * The Windows VM's 4 fps picture, made off the server's loop (picture.ts `VmPreviews`; docs/agents/work-winvm.md).
 *
 * The picture was a PNG from QMP, read whole and decoded, sized and encoded by Electron's `nativeImage` on the
 * server's loop, four times a second while any tile watched. Now QEMU writes the screen as PPM (raw pixels: no
 * PNG to compress on its side or decode on ours), a worker thread reads the file, shrinks it to the tile's size
 * and hands back a small BGRA bitmap, and the loop only encodes that bitmap as JPEG (a tile of 640 by 400, not
 * the screen's 2560 by 1600). Electron's encoder lives in the main process alone, so that last small step stays
 * there. `vmFrames` falls back to the PNG path for good the first time the PPM path fails.
 */

export interface Bitmap {
  /** BGRA, 4 bytes a pixel, rows top down */
  bgra: Uint8Array
  width: number
  height: number
}

/**
 * A PPM (P6, 8 bits a channel) as a BGRA bitmap no longer than `maxEdge` on its long side: each output pixel the
 * mean of the block of input pixels it covers. Pure and self-contained: the worker runs this function's own text.
 */
export function ppmToBgra(ppm: Uint8Array, maxEdge: number): Bitmap {
  // The header: "P6", width, height, maxval, each after whitespace or a `#` comment, then one whitespace byte.
  let at = 0
  const token = (): string => {
    for (;;) {
      while (at < ppm.length && (ppm[at] === 32 || ppm[at] === 10 || ppm[at] === 13 || ppm[at] === 9)) at++
      if (ppm[at] !== 35) break
      while (at < ppm.length && ppm[at] !== 10) at++
    }
    let text = ''
    while (at < ppm.length && !(ppm[at] === 32 || ppm[at] === 10 || ppm[at] === 13 || ppm[at] === 9)) text += String.fromCharCode(ppm[at++]!)
    return text
  }
  if (token() !== 'P6') throw new Error('not a PPM picture')
  const width = Number(token())
  const height = Number(token())
  const max = Number(token())
  at++
  if (!(width > 0 && height > 0) || max !== 255 || width > 16384 || height > 16384) throw new Error('not a PPM picture this reads')
  if (ppm.length - at < width * height * 3) throw new Error('the PPM picture is cut short')
  const k = Math.min(1, maxEdge / Math.max(width, height))
  const w = Math.max(1, Math.round(width * k))
  const h = Math.max(1, Math.round(height * k))
  const bgra = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * height) / h)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h))
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * width) / w)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w))
      let r = 0
      let g = 0
      let b = 0
      for (let sy = y0; sy < y1; sy++) {
        let i = at + (sy * width + x0) * 3
        for (let sx = x0; sx < x1; sx++) {
          r += ppm[i]!
          g += ppm[i + 1]!
          b += ppm[i + 2]!
          i += 3
        }
      }
      const n = (y1 - y0) * (x1 - x0)
      const o = (y * w + x) * 4
      bgra[o] = Math.round(b / n)
      bgra[o + 1] = Math.round(g / n)
      bgra[o + 2] = Math.round(r / n)
      bgra[o + 3] = 255
    }
  }
  return { bgra, width: w, height: h }
}

/** The worker: reads the shot, removes it, shrinks it, hands the bitmap back with its buffer. */
const workerSource = (): string => `
const { parentPort } = require('node:worker_threads')
const { readFileSync, rmSync } = require('node:fs')
const ppmToBgra = ${ppmToBgra.toString()}
parentPort.on('message', ({ id, file, maxEdge }) => {
  try {
    let bytes
    try { bytes = readFileSync(file) } finally { rmSync(file, { force: true }) }
    const { bgra, width, height } = ppmToBgra(bytes, maxEdge)
    parentPort.postMessage({ id, bgra, width, height }, [bgra.buffer])
  } catch (error) {
    parentPort.postMessage({ id, error: String(error && error.message || error) })
  }
})
`

/** One worker thread for the VM's shots, started at the first shot and stopped with the last watcher. */
export class ShotWorker {
  private worker: Worker | null = null
  private next = 0
  private readonly waiting = new Map<number, { resolve: (bitmap: Bitmap) => void; reject: (error: Error) => void }>()

  /** The PPM at `file` as a small bitmap; the file is read and removed in the worker, never on the loop. */
  shrink(file: string, maxEdge: number): Promise<Bitmap> {
    const worker = (this.worker ??= this.start())
    return new Promise<Bitmap>((resolve, reject) => {
      const id = ++this.next
      this.waiting.set(id, { resolve, reject })
      worker.postMessage({ id, file, maxEdge })
    })
  }

  stop(): void {
    const worker = this.worker
    this.worker = null
    this.fail(new Error('the picture stopped'))
    void worker?.terminate()
  }

  private fail(error: Error): void {
    for (const wait of this.waiting.values()) wait.reject(error)
    this.waiting.clear()
  }

  private start(): Worker {
    const worker = new Worker(workerSource(), { eval: true })
    worker.unref()
    worker.on('message', (m: { id: number; bgra?: Uint8Array; width?: number; height?: number; error?: string }) => {
      const wait = this.waiting.get(m.id)
      if (!wait) return
      this.waiting.delete(m.id)
      if (m.error || !m.bgra) wait.reject(new Error(m.error ?? 'the shot came back empty'))
      else wait.resolve({ bgra: m.bgra, width: m.width!, height: m.height! })
    })
    const gone = (error: Error): void => {
      if (this.worker === worker) this.worker = null
      this.fail(error)
    }
    worker.on('error', gone)
    worker.on('exit', () => gone(new Error('the shot worker ended')))
    return worker
  }
}

export interface Frame {
  /** JPEG, base64 */
  data: string
  width: number
  height: number
}

export interface VmFrameDeps {
  /** where QEMU writes the shots (0700, the caller makes it) */
  dir(): string
  /** QMP's screendump of the screen to `file` as PPM */
  ppm(file: string): Promise<void>
  worker: Pick<ShotWorker, 'shrink' | 'stop'>
  /** a small bitmap as JPEG, base64 (Electron's encoder, on the loop: the bitmap is the tile's size) */
  jpeg(bitmap: Bitmap): string | Promise<string>
  /** the path before this one: a PNG shot, decoded and encoded on the loop */
  fallback(maxEdge: number): Promise<Frame>
  log?: (line: string) => void
}

/**
 * One frame of the VM's screen no longer than `maxEdge`: through the worker, or, from the first failure of that
 * path on (a QEMU that writes no PPM, a worker that will not start), through the PNG path as before.
 */
export function vmFrames(d: VmFrameDeps): { frame(maxEdge: number): Promise<Frame>; stop(): void } {
  let ppm = true
  let n = 0
  return {
    async frame(maxEdge) {
      if (ppm) {
        try {
          const file = `${d.dir()}/shot-${++n % 4}.ppm`
          await d.ppm(file)
          const bitmap = await d.worker.shrink(file, maxEdge)
          return { data: await d.jpeg(bitmap), width: bitmap.width, height: bitmap.height }
        } catch (error) {
          ppm = false
          d.worker.stop()
          d.log?.(`winvm picture: the PPM path failed (${(error as Error).message}); PNG from here on`)
        }
      }
      return d.fallback(maxEdge)
    },
    stop: () => d.worker.stop()
  }
}
