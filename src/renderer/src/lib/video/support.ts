import { VIDEO_MAX_EDGE, VIDEO_MIN_EDGE } from "@server/shared/contract-video";

/**
 * What a place needs to know before the viewer's own code is loaded
 * (docs/agents/live-video.md "The viewer"): whether this window can play a
 * stream at all, and how large a picture to ask for.
 */

/** A worker, WebCodecs, and a canvas that can be handed to the worker. */
export function videoSupported(): boolean {
  return typeof Worker !== "undefined" && typeof VideoDecoder !== "undefined" && typeof HTMLCanvasElement !== "undefined" && "transferControlToOffscreen" in HTMLCanvasElement.prototype;
}

/** The edge to ask for: the place's width in device pixels, rounded up to 64, inside the wire's bounds. */
export function videoEdge(cssWidth: number, dpr: number): number {
  const want = Math.ceil((Math.max(1, cssWidth) * Math.max(1, dpr)) / 64) * 64;
  return Math.min(VIDEO_MAX_EDGE, Math.max(VIDEO_MIN_EDGE, want));
}

/** A place that grew this much past the edge the stream was opened at has it opened again, larger, once the resize has been quiet this long. */
export const REGROW = 1.25;
export const REGROW_QUIET_MS = 500;
/**
 * A stream every place of which has shrunk below this share of the edge it was opened at is opened again, smaller,
 * once that has held this long: a pop-out left alone does not hold a 4K stream open.
 */
export const SHRINK = 0.6;
export const SHRINK_QUIET_MS = 5000;

/** The edge a place asks for next, given the one it asked for: the same until it grows past REGROW or shrinks below SHRINK. */
export function nextEdge(asked: number | null, want: number): number {
  if (asked === null || want > asked * REGROW || want < asked * SHRINK) return want;
  return asked;
}

/** The device pixels per CSS pixel of the window an element is in: the pop-out's own, which may be on another screen. */
export function pixelRatioOf(el: Element | null | undefined): number {
  const view = el?.ownerDocument?.defaultView ?? (typeof window === "undefined" ? null : window);
  return view?.devicePixelRatio || 1;
}

/** The widest a frame is drawn in a column: its own pixels. A narrower column scales it down. */
export const sharpWidth = (frameWidth: number, dpr: number): number => frameWidth / Math.max(1, dpr);
