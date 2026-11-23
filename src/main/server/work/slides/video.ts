import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Converter, ConvertRun } from '../formats/jobs'
import { tailOf } from '../formats/tools'

/**
 * A deck's slides as pictures and as a video of them (docs/agents/work-slides.md "Preview and export"), made from
 * the deck's own PDF: `pdf → slidepics` draws chosen pages as PNG or JPEG with the toolchain's pdf-tools (pypdfium2
 * and Pillow), packed as a zip he saves or as one joined file the next job reads; `slidepics → slidevideo` lays
 * those pictures in a row with ffmpeg, each for some seconds with a crossfade between, silent. Both run as
 * separate processes through the conversion runner, as every ffmpeg job of the media pillar does.
 */

/** As `String.raw`: no backtick and no dollar-brace in the Python. */
export const SLIDEPICS_PY = String.raw`"""temp-code slide pictures (src/main/server/work/slides/video.ts).
  pics <in.pdf> <out> <opts.json>
Pages of the PDF as PNG or JPEG, packed as a zip (names from the options) or
joined: a 4-byte count, an 8-byte length each, then each picture. A refusal
is one line on stderr starting "tc-error: " and exit 3."""
import json
import os
import struct
import sys
import zipfile


def refuse(text):
    sys.stderr.write("tc-error: " + text + "\n")
    sys.exit(3)


def main():
    src, out, optf = sys.argv[2], sys.argv[3], sys.argv[4]
    with open(optf) as f:
        o = json.load(f)
    import pypdfium2 as pdfium
    try:
        doc = pdfium.PdfDocument(src)
    except pdfium.PdfiumError as err:
        refuse("The slides could not be read: " + str(err))
    total = len(doc)
    files = []
    for i, n in enumerate(o["pages"]):
        if n < 1 or n > total:
            refuse("Page %d is not in the slides: they have %d." % (n, total))
        page = doc[n - 1]
        w, h = page.get_size()
        width = o["width"]
        height = o.get("height") or max(1, int(round(h * width / w)))
        img = page.render(scale=width / w).to_pil()
        if img.size != (width, height):
            img = img.resize((width, height))
        path = "pic-%d" % i
        if o["type"] == "jpeg":
            img.convert("RGB").save(path, format="JPEG", quality=o.get("quality", 90))
        else:
            img.save(path, format="PNG")
        files.append(path)
        page.close()
    if o["pack"] == "zip":
        with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:
            for name, path in zip(o["names"], files):
                z.write(path, name)
    else:
        with open(out, "wb") as f:
            f.write(struct.pack(">I", len(files)))
            for path in files:
                f.write(struct.pack(">Q", os.path.getsize(path)))
            for path in files:
                with open(path, "rb") as g:
                    while True:
                        chunk = g.read(1 << 20)
                        if not chunk:
                            break
                        f.write(chunk)


main()
`

/** A picture's name inside the zip: a plain file name, never a path. */
const PIC_NAME = /^[\w .()-]{1,120}\.(png|jpg)$/
// Options may come from another host's key: pages, sizes and names are bounded and checked.
const PicsOptions = z
  .object({
    pages: z.array(z.number().int().min(1).max(100_000)).min(1).max(5000),
    width: z.number().int().min(16).max(3840),
    height: z.number().int().min(16).max(2160).optional(),
    type: z.enum(['png', 'jpeg']),
    quality: z.number().int().min(40).max(95).optional(),
    pack: z.enum(['zip', 'join']),
    names: z.array(z.string().regex(PIC_NAME)).optional()
  })
  .strict()
  .refine((o) => o.pack !== 'zip' || o.names?.length === o.pages.length, 'a zip names every picture')
export type PicsOptions = z.input<typeof PicsOptions>

const VideoOptions = z
  .object({
    seconds: z.number().min(1).max(600),
    fade: z.number().min(0).max(2),
    fps: z.union([z.literal(24), z.literal(25), z.literal(30)])
  })
  .strict()
export type VideoOptions = z.input<typeof VideoOptions>

/** The pictures of one `join` pack, in order. */
export function readJoined(path: string): Buffer[] {
  const all = readFileSync(path)
  const bad = (): Error => new Error('the slide pictures were cut short')
  if (all.length < 4) throw bad()
  const n = all.readUInt32BE(0)
  if (n > 5000 || all.length < 4 + 8 * n) throw bad()
  const out: Buffer[] = []
  let at = 4 + 8 * n
  for (let i = 0; i < n; i++) {
    const len = Number(all.readBigUInt64BE(4 + 8 * i))
    if (at + len > all.length) throw bad()
    out.push(all.subarray(at, at + len))
    at += len
  }
  if (at !== all.length) throw bad()
  return out
}

const sec = (s: number): string => String(Math.round(s * 1000) / 1000)

/**
 * ffmpeg's line for a video of `frames`, each shown `seconds`, a crossfade of `fade` seconds between two, silent.
 * Each picture but the last is held `fade` longer, and the k-th fade starts at k × seconds, so the whole runs
 * exactly frames × seconds (decision 8: 12 slides, 5 s, 60 s).
 */
export function videoArgs(o: { frames: readonly string[]; seconds: number; fade: number; fps: number; output: string; threads: number }): string[] {
  const n = o.frames.length
  if (n === 0) throw new Error('a video needs at least one slide')
  const fade = n > 1 ? Math.min(o.fade, o.seconds / 2) : 0
  const inputs = o.frames.flatMap((f, i) => ['-loop', '1', '-framerate', String(o.fps), '-t', sec(o.seconds + (i < n - 1 ? fade : 0)), '-i', f])
  const graph = o.frames.map((_, i) => `[${i}:v]setsar=1,format=yuv420p[s${i}]`)
  let last = 's0'
  if (n > 1 && fade > 0) {
    for (let k = 1; k < n; k++) {
      graph.push(`[${last}][s${k}]xfade=transition=fade:duration=${sec(fade)}:offset=${sec(k * o.seconds)}[x${k}]`)
      last = `x${k}`
    }
  } else if (n > 1) {
    graph.push(`${o.frames.map((_, i) => `[s${i}]`).join('')}concat=n=${n}:v=1:a=0[x]`)
    last = 'x'
  }
  return [
    ...['-hide_banner', '-nostdin', '-y', '-v', 'error', '-threads', String(o.threads)],
    ...inputs,
    ...['-filter_complex', graph.join(';'), '-map', `[${last}]`, '-an'],
    ...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(o.fps), '-movflags', '+faststart', '-f', 'mp4', o.output]
  ]
}

/** How long a video of `slides` runs at `seconds` a slide: the fades overlap the held pictures, so no more than that. */
export const videoSeconds = (slides: number, seconds: number): number => slides * seconds

/** An .mp4's length in seconds from its movie header (`mvhd`); null where there is none to read. */
export function mp4Seconds(path: string): number | null {
  const size = statSync(path).size
  const fd = openSync(path, 'r')
  try {
    // A fast-start file holds its header at the front; any other at its end.
    for (const start of [0, Math.max(0, size - (8 << 20))]) {
      const buf = Buffer.alloc(Math.min(size - start, 8 << 20))
      readSync(fd, buf, 0, buf.length, start)
      const at = buf.indexOf('mvhd')
      if (at < 0 || at + 32 > buf.length) continue
      const base = at + 4
      const v1 = buf[base] === 1
      const scale = buf.readUInt32BE(base + (v1 ? 20 : 12))
      const length = v1 ? Number(buf.readBigUInt64BE(base + 24)) : buf.readUInt32BE(base + 16)
      return scale > 0 ? length / scale : null
    }
    return null
  } finally {
    closeSync(fd)
  }
}

async function runPics(job: { input: string; output: string; options?: unknown }, run: ConvertRun): Promise<{ warnings: string[] }> {
  const parsed = PicsOptions.safeParse(job.options ?? {})
  if (!parsed.success) throw new Error('the pictures are not asked for rightly')
  const py = run.tools.bin('pdf-tools')
  if (!py) throw new Error('pdf-tools is not installed here')
  const script = join(run.tmp, 'tc_pics.py')
  const opts = join(run.tmp, 'pics.json')
  const out = join(run.tmp, 'out.bin')
  writeFileSync(script, SLIDEPICS_PY)
  writeFileSync(opts, JSON.stringify(parsed.data))
  const r = await run.run(py, ['-I', script, 'pics', job.input, out, opts], { timeoutMs: 20 * 60_000, cwd: run.tmp })
  if (r.code !== 0 || !existsSync(out)) throw new Error(/tc-error: (.+)/.exec(r.out)?.[1]?.trim() || `pdf-tools could not draw the slides: ${tailOf(r.out) || `exit ${r.code}`}`)
  copyFileSync(out, job.output)
  return { warnings: [] }
}

async function runVideo(job: { input: string; output: string; options?: unknown }, run: ConvertRun): Promise<{ warnings: string[] }> {
  const parsed = VideoOptions.safeParse(job.options ?? {})
  if (!parsed.success) throw new Error('the video is not asked for rightly')
  const ffmpeg = run.tools.bin('ffmpeg')
  if (!ffmpeg) throw new Error('ffmpeg is not installed here')
  const dir = join(run.tmp, 'frames')
  mkdirSync(dir)
  const frames = readJoined(job.input).map((pic, i) => {
    const path = join(dir, `${String(i).padStart(5, '0')}.png`)
    writeFileSync(path, pic)
    return path
  })
  const out = join(run.tmp, 'out.mp4')
  const r = await run.run(ffmpeg, videoArgs({ frames, ...parsed.data, output: out, threads: run.threads }), { timeoutMs: 60 * 60_000, gentle: true, cwd: run.tmp })
  if (r.code !== 0 || !existsSync(out)) throw new Error(`ffmpeg could not make the video: ${tailOf(r.out) || `exit ${r.code}`}`)
  copyFileSync(out, job.output)
  return { warnings: [] }
}

export const VIDEO_CONVERTERS: Converter[] = [
  { from: 'pdf', to: 'slidepics', needs: 'pdf-tools', threads: 1, run: runPics },
  { from: 'slidepics', to: 'slidevideo', needs: 'ffmpeg', threads: 4, run: runVideo }
]
