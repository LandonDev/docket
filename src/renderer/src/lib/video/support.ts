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
