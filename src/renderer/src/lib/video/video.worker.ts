/// <reference lib="webworker" />
import type { FromWorker, ToWorker } from "./messages";
import { StreamPlayer, type PlayerDeps, type Surface } from "./player";

/**
 * The viewer's worker (docs/agents/live-video.md "The viewer"): every live
 * stream of a window lives here, with its socket and its decoder, and draws
 * on the canvases the window handed over, on this thread's own frame clock.
 * React work in the window cannot make the video stutter, and the video
 * costs the window's thread nothing but a count four times a second.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: FromWorker): void => scope.postMessage(message);

/** How often the counts go to the window, and stalled streams are looked for. */
const COUNT_MS = 250;

class CanvasSurface implements Surface<VideoFrame> {
  private readonly ctx: OffscreenCanvasRenderingContext2D | null;
  stream: number | null = null;

  constructor(private readonly canvas: OffscreenCanvas) {
    this.ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  }

  draw(frame: VideoFrame, width: number, height: number): void {
    // the canvas holds the stream's own pixels: sized by the frame, never stretched here
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.ctx?.drawImage(frame, 0, 0, width, height);
  }
}

const players = new Map<number, { player: StreamPlayer<VideoFrame>; counted: number; at: number }>();
const surfaces = new Map<number, CanvasSurface>();

let waking = false;
const tick = (): void => {
  waking = false;
  const now = performance.now();
  let again = false;
  for (const { player } of players.values()) again = player.refresh(now) || again;
  if (again) wake();
};
function wake(): void {
  if (waking) return;
  waking = true;
  // the display's own clock where the worker has one; a hidden window's stops, and the presenter then passes frames over as they come
  if (typeof scope.requestAnimationFrame === "function") scope.requestAnimationFrame(tick);
  else setTimeout(tick, 8);
}

const deps: PlayerDeps<VideoFrame> = {
  socket: (url, protocols) => new WebSocket(url, protocols) as never,
  decoder: (init) => {
    const decoder = new VideoDecoder(init);
    return {
      configure: (config) => decoder.configure(config),
      decode: (chunk) => decoder.decode(new EncodedVideoChunk(chunk)),
      close: () => decoder.close(),
    };
  },
  supported: async (config) => (await VideoDecoder.isConfigSupported(config)).supported === true,
  now: () => performance.now(),
  wake,
};

function open(stream: number, url: string): void {
  players.get(stream)?.player.close();
  const player = new StreamPlayer<VideoFrame>(url, deps, {
    drawn: (width, height) => post({ t: "drawn", stream, width, height }),
    closed: (code, fault) => {
      if (players.get(stream)?.player !== player) return;
      players.delete(stream);
      post({ t: "closed", stream, code, ...(fault ? { fault } : {}) });
    },
  });
  players.set(stream, { player, counted: 0, at: performance.now() });
  for (const surface of surfaces.values()) if (surface.stream === stream) player.show(surface);
}

scope.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.t === "open") open(message.stream, message.url);
  else if (message.t === "close") {
    const entry = players.get(message.stream);
    players.delete(message.stream);
    entry?.player.close();
  } else if (message.t === "surface") surfaces.set(message.surface, new CanvasSurface(message.canvas));
  else if (message.t === "bind") {
    const surface = surfaces.get(message.surface);
    if (!surface) return;
    if (surface.stream !== null) players.get(surface.stream)?.player.hide(surface);
    surface.stream = message.stream;
    if (message.stream !== null) players.get(message.stream)?.player.show(surface);
  } else if (message.t === "forget") {
    const surface = surfaces.get(message.surface);
    if (surface?.stream != null) players.get(surface.stream)?.player.hide(surface);
    surfaces.delete(message.surface);
  }
};

setInterval(() => {
  const now = performance.now();
  for (const [stream, entry] of [...players]) {
    entry.player.check(now);
    const frames = entry.player.frames;
    if (frames === entry.counted) {
      entry.at = now;
      continue;
    }
    post({ t: "count", stream, frames, fps: Math.round(((frames - entry.counted) * 1000) / Math.max(1, now - entry.at)) });
    entry.counted = frames;
    entry.at = now;
  }
}, COUNT_MS);
