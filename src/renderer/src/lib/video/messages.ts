import { VIDEO_PATH, VIDEO_RETRIES, videoCloseShows, type VideoCloseFace } from "@server/shared/contract-video";
import type { PlayerFault } from "./player";

/**
 * What the window and the viewer's worker say to each other
 * (docs/agents/live-video.md "The viewer"), and the two rules both sides of
 * that line share: where a stream's socket is, and what a closed one does
 * next.
 */

/** Window to worker. A canvas is handed over once (`surface`) and then bound to a stream, or to none. */
export type ToWorker =
  | { t: "open"; stream: number; url: string }
  | { t: "close"; stream: number }
  | { t: "surface"; surface: number; canvas: OffscreenCanvas }
  | { t: "bind"; surface: number; stream: number | null }
  | { t: "forget"; surface: number };

/** Worker to window. */
export type FromWorker =
  | { t: "drawn"; stream: number; width: number; height: number }
  | { t: "count"; stream: number; frames: number; fps: number }
  | { t: "closed"; stream: number; code: number; fault?: PlayerFault };

/** The address of a stream's own socket on the host an RPC socket is connected to. */
export function streamUrl(rpcUrl: string, stream: string, ticket: string): string {
  const url = new URL(rpcUrl);
  url.pathname = `${VIDEO_PATH}${encodeURIComponent(stream)}`;
  url.search = "";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

/** How long before a dropped stream is opened again, by how many times it already was. */
export const RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 4000] as const;

export type AfterClose =
  /** open it again with a fresh ticket, after `delayMs` */
  | { then: "again"; delayMs: number }
  /** the stream is over: what the viewer shows in its place */
  | { then: "over"; face: Exclude<VideoCloseFace, "again">; retry?: true };

/**
 * What a viewer does when its stream closes. `tries` is how many times it
 * was opened again since a frame was last drawn. A stream that dropped
 * without a word, or was too slow, is opened again five times and then
 * gives way to the 4 fps picture; one the host ended is never opened again
 * by itself; one this machine cannot decode gives way at once.
 */
export function afterClose(code: number, fault: PlayerFault | undefined, tries: number): AfterClose {
  if (fault === "unsupported") return { then: "over", face: "picture" };
  const shows = fault ? { face: "again" as const } : videoCloseShows(code);
  if (shows.face !== "again") return { then: "over", face: shows.face, ...(shows.retry ? { retry: true as const } : {}) };
  if (tries >= VIDEO_RETRIES) return { then: "over", face: "picture" };
  return { then: "again", delayMs: RETRY_DELAYS_MS[Math.min(tries, RETRY_DELAYS_MS.length - 1)] };
}
