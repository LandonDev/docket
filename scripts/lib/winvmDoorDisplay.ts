/**
 * The pure parts of scripts/e2e-winvm-door-display.ts: whether the exe is the one built from a tree with M3c in it,
 * where the proof page's button sits in a picture, a PNG's size, and the rows the run writes.
 */

/** M3c: "The Windows guest can read and set its display mode through the door." */
export const M3C_COMMIT = '620adc7ebe4edc3aa727584d9ed1e0ea7d1b18df'

/** What `--build-exe` writes beside the exe it built: the commit it was built from and the file's sha256. */
export interface ExeStamp {
  commit: string
  sha256: string
  builtAt: string
}

/** Why the exe may not be used, or null: it must carry the stamp of a build from a tree that holds M3c, unchanged since. */
export function exeRefusal(o: { exe: string | null; sha256: string | null; stamp: ExeStamp | null; holdsM3c: boolean }): string | null {
  if (!o.exe) return 'no tc-computer.exe: build it with --build-exe first'
  if (!o.stamp) return `${o.exe} has no build stamp (${o.exe}.build.json): build it with --build-exe`
  if (o.sha256 !== o.stamp.sha256) return `${o.exe} is not the file its stamp names (sha256 ${o.sha256} against ${o.stamp.sha256}): build it again with --build-exe`
  if (!o.holdsM3c) return `${o.exe} was built from ${o.stamp.commit}, which does not hold M3c (${M3C_COMMIT.slice(0, 9)})`
  return null
}

/** The proof page's button colour: no other pixel of Edge or Windows is this. */
export const BUTTON_RGB = [255, 0, 255] as const

/**
 * The centre of the pixels within `tolerance` of `rgb` in an RGBA picture, as whole pixels, with how many matched;
 * null when fewer than `least` did (the button is not on screen).
 */
export function colourCentre(rgba: Uint8Array, width: number, height: number, rgb: readonly [number, number, number], tolerance = 24, least = 64): { x: number; y: number; pixels: number } | null {
  let [x0, y0, x1, y1, n] = [width, height, -1, -1, 0]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (Math.abs(rgba[i]! - rgb[0]) > tolerance || Math.abs(rgba[i + 1]! - rgb[1]) > tolerance || Math.abs(rgba[i + 2]! - rgb[2]) > tolerance) continue
      n++
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
  }
  return n < least ? null : { x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2), pixels: n }
}

/** A PNG's size from its header; null when it is not a PNG. */
export function pngSize(png: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (png.length < 24 || sig.some((b, i) => png[i] !== b)) return null
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength)
  return { width: v.getUint32(16), height: v.getUint32(20) }
}

/** The page Edge opens: one magenta button, "Add one", and a count the box keeps (each POST is one click). */
export function proofPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Door display proof</title>
<style>body{font:24px Segoe UI,sans-serif;margin:48px}button{font:28px Segoe UI,sans-serif;width:420px;height:180px;border:0;background:rgb(${BUTTON_RGB.join(',')});color:#fff}</style></head>
<body><button id="add">Add one</button><p>Count: <span id="count">0</span></p>
<script>document.getElementById('add').onclick=async()=>{const r=await fetch('/add',{method:'POST'});document.getElementById('count').textContent=await r.text()}</script>
</body></html>`
}

export interface Row {
  step: string
  ok: boolean
  /** what was seen: modes, sizes, counts, times in ms */
  [key: string]: unknown
}

/** The run's whole answer: every row, and whether all of them passed. Times are recorded, never judged. */
export function summary(rows: readonly Row[]): { ok: boolean; failed: string[]; rows: readonly Row[] } {
  const failed = rows.filter((r) => !r.ok).map((r) => r.step)
  return { ok: failed.length === 0, failed, rows }
}

/** A mode as one word: `3456x2234@200`. */
export const modeWord = (m: { width: number; height: number; scale: number }): string => `${m.width}x${m.height}@${m.scale}`
