import { timecodeFrames, type FrameRate, type MediaAnchor, type MediaShape } from '@shared/contract-work-media'
import type { FrameioPost } from '@shared/contract-work-frameio'
import type { Principal } from '@shared/work'
import type { FioComment } from './api'

/**
 * A Frame.io comment and a media note, each into the other
 * (docs/agents/work-frameio.md, "Comments"). The research's table is the
 * map: `timestamp` is a frame, `duration` a run of frames, `anchor` the pin,
 * `annotation` the marks as stringified JSON in 0 to 1 of the picture with
 * their line size in pixels (ours is a share of the picture's height).
 */

/**
 * Frame.io's number for TempCode's frame 0. V4's migration guide says its
 * `timestamp` counts "starting from 1"; V2's spec said 0. Unproven on a real
 * account: the live test's first step settles it, and this one number
 * changes if it says 0.
 */
export const FRAME_BASE = 1

const RED = '#F22237'
const color = (c: unknown): string => (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : RED)
const unit = (n: unknown): number => Math.max(-0.5, Math.min(1.5, Number(n) || 0))
const share = (size: unknown, height: number): number => Math.max(0.0005, Math.min(0.1, (Number(size) || 4) / Math.max(1, height)))
const pixels = (width: number, height: number): number => Math.max(1, Math.round(width * height))

/** A comment's frame in TempCode's count, or undefined for one on no frame (an image, or the whole file). */
export function frameOfComment(t: FioComment['timestamp'], rate?: FrameRate): number | undefined {
  if (typeof t === 'number' && Number.isFinite(t)) return Math.max(0, Math.round(t) - FRAME_BASE)
  if (typeof t === 'string' && rate) {
    // A timecode counts from 00:00:00:00, the first frame.
    const n = timecodeFrames(t, rate)
    return n === null ? undefined : Math.max(0, n)
  }
  return undefined
}

/** One point of a stroke as Frame.io might send it: `[x, y]` or `{ x, y }`. */
const pointOf = (p: unknown): [number, number] | null => {
  if (Array.isArray(p) && p.length >= 2) return [unit(p[0]), unit(p[1])]
  if (p && typeof p === 'object' && 'x' in p && 'y' in p) return [unit((p as { x: unknown }).x), unit((p as { y: unknown }).y)]
  return null
}

/**
 * Frame.io's marks as ours. `rect`, `line` and `arrow` are documented; a
 * freehand stroke is not, so anything with a `points` list is read as a pen
 * and anything else is left out and counted in `skipped`.
 */
export function shapesOf(annotation: string | null | undefined, height: number): { shapes: MediaShape[]; skipped: number } {
  if (!annotation) return { shapes: [], skipped: 0 }
  let raw: unknown
  try {
    raw = JSON.parse(annotation)
  } catch {
    return { shapes: [], skipped: 1 }
  }
  const shapes: MediaShape[] = []
  let skipped = 0
  for (const s of Array.isArray(raw) ? raw : [raw]) {
    const o = (s ?? {}) as Record<string, unknown>
    const base = { color: color(o.color), width: share(o.size, height) }
    if (o.tool === 'rect') shapes.push({ tool: 'rect', ...base, x: unit(o.x), y: unit(o.y), w: unit(o.w), h: unit(o.h) })
    else if (o.tool === 'line') shapes.push({ tool: 'line', ...base, x1: unit(o.x1), y1: unit(o.y1), x2: unit(o.x2), y2: unit(o.y2) })
    // V2's guide gives an arrow's start and its run as `w` and `h`; the live test checks which way round.
    else if (o.tool === 'arrow') shapes.push({ tool: 'arrow', ...base, x1: unit(o.x), y1: unit(o.y), x2: unit(Number(o.x) + Number(o.w)), y2: unit(Number(o.y) + Number(o.h)) })
    else if (Array.isArray(o.points)) {
      const points = o.points.map(pointOf).filter((p): p is [number, number] => !!p)
      if (points.length) shapes.push({ tool: 'pen', ...base, points: points.slice(0, 5000) })
      else skipped++
    } else skipped++
  }
  return { shapes: shapes.slice(0, 200), skipped }
}

/**
 * Our marks as Frame.io's `annotation`, and what could not go as it is: an
 * ellipse goes as its box and a pen stroke as straight lines, since V4
 * documents neither.
 */
export function annotationOf(shapes: readonly MediaShape[], height: number): { annotation?: string; lossy: string[] } {
  const out: Record<string, unknown>[] = []
  const lossy = new Set<string>()
  for (const s of shapes) {
    const size = pixels(s.width, height)
    if (s.tool === 'rect') out.push({ tool: 'rect', color: s.color, size, x: s.x, y: s.y, w: s.w, h: s.h })
    else if (s.tool === 'line') out.push({ tool: 'line', color: s.color, size, x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 })
    else if (s.tool === 'arrow') out.push({ tool: 'arrow', color: s.color, size, x: s.x1, y: s.y1, w: s.x2 - s.x1, h: s.y2 - s.y1 })
    else if (s.tool === 'ellipse') {
      out.push({ tool: 'rect', color: s.color, size, x: s.cx - s.rx, y: s.cy - s.ry, w: 2 * s.rx, h: 2 * s.ry })
      lossy.add('an oval goes as its box')
    } else if (s.tool === 'pen') {
      for (let i = 1; i < s.points.length; i++) out.push({ tool: 'line', color: s.color, size, x1: s.points[i - 1][0], y1: s.points[i - 1][1], x2: s.points[i][0], y2: s.points[i][1] })
      lossy.add('a drawn line goes as straight lines')
    }
  }
  const annotation = out.length ? JSON.stringify(out) : undefined
  if (annotation && annotation.length > 200_000) throw new Error('The marks are too many for Frame.io: draw fewer.')
  return { ...(annotation ? { annotation } : {}), lossy: [...lossy] }
}

/** Who a comment is by: the person when it is his own account, else the Frame.io user. */
export const authorOf = (c: FioComment, me: string | undefined): Principal => (c.owner?.id && c.owner.id === me ? 'owner' : `external:frameio:${c.owner?.id ?? 'unknown'}`)

/** A comment as a note on one version: its anchor, words and author. */
export function noteOfComment(c: FioComment, o: { versionId: string; me?: string; height: number; rate?: FrameRate }): { anchor: MediaAnchor; body: string; by: Principal; resolved: boolean; external: { service: 'frameio'; id: string; author: string } } {
  const frame = frameOfComment(c.timestamp, o.rate)
  const { shapes } = shapesOf(c.annotation, o.height)
  const anchor: MediaAnchor = {
    versionId: o.versionId,
    ...(frame !== undefined ? { frame } : {}),
    ...(frame !== undefined && c.duration && c.duration > 1 ? { durationFrames: Math.round(c.duration) } : {}),
    ...(c.anchor ? { pin: { x: Math.max(0, Math.min(1, c.anchor.x)), y: Math.max(0, Math.min(1, c.anchor.y)) } } : {}),
    ...(shapes.length ? { shapes } : {})
  }
  return { anchor, body: c.text, by: authorOf(c, o.me), resolved: !!c.completed_at, external: { service: 'frameio', id: c.id, author: c.owner?.name ?? 'Frame.io' } }
}

/** A held comment as Frame.io's create body. */
export function commentBody(p: Extract<FrameioPost, { what: 'comment' }>): Record<string, unknown> {
  const { annotation } = annotationOf(p.shapes ?? [], p.height ?? 1080)
  return {
    text: p.text,
    ...(p.frame !== undefined ? { timestamp: p.frame + FRAME_BASE } : {}),
    ...(p.frame !== undefined && p.durationFrames ? { duration: p.durationFrames } : {}),
    ...(p.pin ? { anchor: p.pin } : {}),
    ...(annotation ? { annotation } : {})
  }
}
