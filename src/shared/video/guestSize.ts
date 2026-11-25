import type { VideoDetail } from '../contract-video'

/**
 * The guest's mode for a viewer's room (docs/agents/live-video.md "The size ask"), one rule for both ends: the
 * viewer asks by it and the host's source takes it.
 *   sharp   guest pixels = points × min(dpr, 2), Windows at that scale (200% on a Retina screen)
 *   faster  guest pixels = points, Windows at 100%, drawn doubled
 * Even numbers; never under 1024×640 points (below that the picture scales); the shape held between 5:4 and 32:9
 * (outside it the picture keeps a matte). Over a cap the scale steps down 200, 175, 150, 125, 100, then the size.
 */

export interface Room {
  /** CSS points */
  width: number
  height: number
}

export interface GuestCaps {
  /** the host's `work.winvm.maxPixels` */
  maxPixels: number
  /** his Mac decodes H.264 in hardware to 4096×2400, and refuses 5120×2880 */
  maxWidth: number
  maxHeight: number
}

/** The guest's mode: its pixels and Windows' scale in percent. */
export interface GuestSize {
  width: number
  height: number
  scale: number
}

/** 3840×2400 until M0's numbers set the cap. */
export const GUEST_CAPS: GuestCaps = { maxPixels: 9_216_000, maxWidth: 4096, maxHeight: 2400 }
export const GUEST_MIN_POINTS: Room = { width: 1024, height: 640 }
export const GUEST_SCALES = [200, 175, 150, 125, 100] as const
const NARROWEST = 5 / 4
const WIDEST = 32 / 9

const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)

export function guestSizeFor(room: Room, dpr: number, detail: VideoDetail, caps: GuestCaps = GUEST_CAPS): GuestSize {
  let { width, height } = room
  if (width / height < NARROWEST) height = width / NARROWEST
  else if (width / height > WIDEST) width = height * WIDEST
  const up = Math.max(1, GUEST_MIN_POINTS.width / width, GUEST_MIN_POINTS.height / height)
  width *= up
  height *= up
  const top = detail === 'sharp' ? Math.min(dpr, 2) * 100 : 100
  const fits = (w: number, h: number): boolean => w <= caps.maxWidth && h <= caps.maxHeight && w * h <= caps.maxPixels
  for (const scale of GUEST_SCALES) {
    if (scale > top && scale > 100) continue
    const w = even((width * scale) / 100)
    const h = even((height * scale) / 100)
    if (fits(w, h)) return { width: w, height: h, scale }
  }
  // still over a cap at 100%: the size steps down, in its shape
  const k = Math.min(caps.maxWidth / width, caps.maxHeight / height, Math.sqrt(caps.maxPixels / (width * height)))
  return { width: even(width * k), height: even(height * k), scale: 100 }
}

/** A room rests this long before it is asked for. */
export const SIZE_REST_MS = 400
/** and must have moved this far, in points, from the room last asked for. */
export const SIZE_MOVE_POINTS = 16

/**
 * Whether a viewer asks for its room now: a window dragged to a size is one ask, at its end. `asked` is the room
 * of the last ask (null before the first), `restedMs` how long the room has held still.
 */
export function sizeAskDue(asked: Room | null, room: Room, restedMs: number): boolean {
  if (restedMs < SIZE_REST_MS) return false
  return !asked || Math.abs(room.width - asked.width) >= SIZE_MOVE_POINTS || Math.abs(room.height - asked.height) >= SIZE_MOVE_POINTS
}
