/**
 * The pure parts of scripts/e2e-winvm-resize.ts: the Fit ask that means a size, and one row of the proof from what
 * a stream saw. Times are on the engine's clock, in microseconds.
 */
import { GUEST_MIN_POINTS, guestSizeFor } from '../../src/shared/video/guestSize'

export interface Size {
  width: number
  height: number
}

/** The proof's sizes: Windows' own, the page's 2560×1600, and the MacBook's screen at 200%. */
export const RESIZE_SIZES: Size[] = [
  { width: 1920, height: 1200 },
  { width: 2560, height: 1600 },
  { width: 3456, height: 2234 }
]

/** A Fit ask (room in points and the window's scale, Sharp) whose guest mode is `size`: at 2× where half of it is room enough, else at 1×. */
export function fitAsk(size: Size): { width: number; height: number; scale: number } {
  const half = { width: size.width / 2, height: size.height / 2 }
  return half.width >= GUEST_MIN_POINTS.width && half.height >= GUEST_MIN_POINTS.height ? { ...half, scale: 2 } : { ...size, scale: 1 }
}

/** Whether `fitAsk` means the size it was made for, by the rule both ends share. */
export const fitMeans = (size: Size): boolean => {
  const a = fitAsk(size)
  const m = guestSizeFor({ width: a.width, height: a.height }, a.scale, 'sharp')
  return m.width === size.width && m.height === size.height
}

export interface SeenFrame {
  us: number
  w: number
  h: number
}

export interface ResizeRow {
  asked: string
  /** the guest's answer: its size and scale, or why it did not take */
  took: string
  /** the code the stream before closed with (4108 `resized`), or null when it stayed open */
  closed: number | null
  /** from the ask to the first frame at the asked size on the stream opened after it, in ms */
  firstFrameMs: number | null
  /** frames on that stream at the asked size, and at any other */
  atSize: number
  otherSize: number
}

export function resizeRow(o: { asked: Size; took: string; askUs: number; closed: number | null; frames: readonly SeenFrame[] }): ResizeRow {
  const at = (f: SeenFrame): boolean => f.w === o.asked.width && f.h === o.asked.height
  const first = o.frames.find((f) => at(f) && f.us >= o.askUs)
  return {
    asked: `${o.asked.width}x${o.asked.height}`,
    took: o.took,
    closed: o.closed,
    firstFrameMs: first ? Math.round((first.us - o.askUs) / 100) / 10 : null,
    atSize: o.frames.filter(at).length,
    otherSize: o.frames.filter((f) => !at(f)).length
  }
}
