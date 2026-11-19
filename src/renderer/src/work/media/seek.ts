import { frameAt, frameCentre, frameCount, tableFps, type FrameTable } from "@shared/contract-work-media";

/**
 * Frame-accurate seeking on a `<video>` (docs/agents/work-media.md).
 * A note is a frame index, so the viewer never seeks to a frame's start time:
 * decoders round that to the frame before it 5 to 12 times in 16. It seeks
 * to the centre of the frame's interval, waits for `seeked` and the next
 * frame callback, and names the frame from the callback's `mediaTime`, which
 * matched the picture every time the formats research measured it.
 */

/** How long to wait for a frame callback after `seeked`: a seek that lands on the frame already shown may not send one. */
const FRAME_WAIT_MS = 300;

interface State {
  /** Bumped by every seek, so an older one knows a newer one took over. */
  seq: number;
  /** The frame the newest seek is heading for, while it runs. */
  target: number | null;
  /** The last frame a callback reported, and `currentTime` at that moment. */
  shown: { frame: number; time: number } | null;
}
const states = new WeakMap<HTMLVideoElement, State>();
const stateOf = (v: HTMLVideoElement): State => {
  let s = states.get(v);
  if (!s) states.set(v, (s = { seq: 0, target: null, shown: null }));
  return s;
};

/**
 * The frame a callback's `mediaTime` names. It is the frame's start as the
 * container stores it, which Electron 39 reported just under the table's
 * start for 7 frames in 16 (microsecond and millisecond rounding); a
 * quarter of a frame on lands well inside the frame it means.
 */
export const frameOfMediaTime = (table: FrameTable, mediaTime: number): number => frameAt(table, mediaTime + 0.25 / (tableFps(table) || 24));

const note = (v: HTMLVideoElement, table: FrameTable, mediaTime: number): number => {
  const frame = frameOfMediaTime(table, mediaTime);
  stateOf(v).shown = { frame, time: v.currentTime };
  return frame;
};

/** The frame on screen: the last callback's, while `currentTime` has not moved since; else the one `currentTime` falls in. */
export function shownFrame(video: HTMLVideoElement, table: FrameTable): number {
  const s = stateOf(video).shown;
  return s && Math.abs(s.time - video.currentTime) < 1e-4 ? s.frame : frameAt(table, video.currentTime);
}

/** The next frame callback's `mediaTime` (null when the element has none, or once cancelled), and its cancel. */
function nextFrame(video: HTMLVideoElement): { time: Promise<number | null>; cancel: () => void } {
  if (typeof video.requestVideoFrameCallback !== "function") return { time: Promise.resolve(null), cancel: () => {} };
  let id = 0;
  let cancel = (): void => {};
  const time = new Promise<number | null>((resolve) => {
    id = video.requestVideoFrameCallback((_now, meta) => resolve(meta.mediaTime));
    cancel = () => {
      video.cancelVideoFrameCallback(id);
      resolve(null);
    };
  });
  return { time, cancel };
}

/** Resolves on `seeked`, a media error or the signal; at once when nothing is seeking. */
function settled(video: HTMLVideoElement, signal?: AbortSignal): Promise<void> {
  if (!video.seeking || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      for (const e of ["seeked", "error", "emptied"]) video.removeEventListener(e, done);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    for (const e of ["seeked", "error", "emptied"]) video.addEventListener(e, done);
    signal?.addEventListener("abort", done);
  });
}

/**
 * Shows frame `n` (clamped to the table) and resolves with the frame the
 * element reports showing. A newer seek, or the signal, ends the wait
 * early: this one then resolves with what is shown at that moment and
 * never throws.
 */
export async function seekToFrame(video: HTMLVideoElement, table: FrameTable, n: number, signal?: AbortSignal): Promise<number> {
  const s = stateOf(video);
  const seq = ++s.seq;
  const last = Math.max(0, frameCount(table) - 1);
  const target = Math.max(0, Math.min(last, Math.round(n)));
  video.pause();
  if (!video.seeking && s.target === null && shownFrame(video, table) === target) return target;
  s.target = target;
  // Asked before the seek starts, so the callback for the new frame is not missed.
  const frame = nextFrame(video);
  video.currentTime = frameCentre(table, target);
  await settled(video, signal);
  const timer = setTimeout(frame.cancel, seq === s.seq && !signal?.aborted ? FRAME_WAIT_MS : 0);
  const mediaTime = await frame.time;
  clearTimeout(timer);
  if (seq === s.seq) s.target = null;
  return mediaTime === null ? shownFrame(video, table) : note(video, table, mediaTime);
}

/**
 * Steps `delta` frames from the one on screen, or from where a running seek
 * is heading, so quick presses add up. Never `currentTime += 1/fps`: that
 * lands on the wrong frame most of the time.
 */
export function stepFrame(video: HTMLVideoElement, table: FrameTable, delta: number): Promise<number> {
  const s = stateOf(video);
  const from = s.target ?? shownFrame(video, table);
  return seekToFrame(video, table, from + delta);
}

/**
 * Reports the frame shown, once per change, from frame callbacks: while
 * playing and after every seek. Returns its stop.
 */
export function watchFrames(video: HTMLVideoElement, table: FrameTable, onFrame: (n: number) => void): () => void {
  if (typeof video.requestVideoFrameCallback !== "function") return () => {};
  let last = -1;
  let id = 0;
  let stopped = false;
  const tick: VideoFrameRequestCallback = (_now, meta) => {
    if (stopped) return;
    const n = note(video, table, meta.mediaTime);
    if (n !== last) onFrame((last = n));
    id = video.requestVideoFrameCallback(tick);
  };
  id = video.requestVideoFrameCallback(tick);
  return () => {
    stopped = true;
    video.cancelVideoFrameCallback?.(id);
  };
}
