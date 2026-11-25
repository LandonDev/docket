/// <reference lib="webworker" />
import { VIDEO_CLOSE } from "@server/shared/contract-video";
import { LinkHealth } from "./linkHealth";
import type { FromWorker, ToWorker } from "./messages";
import { StreamPlayer, type PlayerDeps, type Surface } from "./player";

/**
 * The viewer's worker (docs/agents/live-video.md "The viewer"): every live
 * stream of a window lives here, with its socket and its decoder, and draws
 * on the canvases the window handed over, on this thread.
 * React work in the window cannot make the video stutter, and the video
 * reports frame counts, timing readings and cursor changes to the window.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: FromWorker): void => scope.postMessage(message);

/** How often the counts go to the window, and stalled streams are looked for. */
const COUNT_MS = 250;
const READING_MS = 1000;

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

interface Playing {
  player: StreamPlayer<VideoFrame>;
  counted: number;
  at: number;
  health: LinkHealth;
  readingAt: number;
  readingFrames: number;
  drive: boolean;
  timer?: ReturnType<typeof setTimeout>;
  deadline?: number;
}

const players = new Map<number, Playing>();
const links = new Map<number, LinkHealth>();
const surfaces = new Map<number, CanvasSurface>();

let waking = false;
const tick = (): void => {
  waking = false;
  const now = performance.now();
  let again = false;
  for (const { player, drive } of players.values()) if (!drive) again = player.refresh(now) || again;
  if (again) wake();
};
function wake(): void {
  if (waking) return;
  waking = true;
  // the display's own clock where the worker has one; a hidden window's stops, and the presenter then passes frames over as they come
  if (typeof scope.requestAnimationFrame === "function") scope.requestAnimationFrame(tick);
  else setTimeout(tick, 8);
}

const deps: Omit<PlayerDeps<VideoFrame>, "wake"> = {
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
};

function stopTimer(entry: Playing): void {
  clearTimeout(entry.timer);
  entry.timer = entry.deadline = undefined;
}

function schedule(entry: Playing): void {
  if (!entry.drive) return wake();
  const deadline = entry.player.nextDrawAt;
  if (deadline === entry.deadline) return;
  stopTimer(entry);
  if (deadline === undefined) return;
  entry.deadline = deadline;
  entry.timer = setTimeout(() => {
    entry.timer = entry.deadline = undefined;
    entry.player.refresh(performance.now());
    schedule(entry);
  }, Math.max(0, Math.ceil(deadline - performance.now())));
}

function close(stream: number): void {
  const entry = players.get(stream);
  if (!entry) return;
  players.delete(stream);
  stopTimer(entry);
  entry.player.close();
}

function open(stream: number, url: string, drive: boolean): void {
  close(stream);
  const health = links.get(stream) ?? new LinkHealth();
  health.restart();
  links.set(stream, health);
  const player = new StreamPlayer<VideoFrame>(url, { ...deps, wake: () => schedule(entry) }, {
    arrived: (at, late) => health.frame(at, late),
    cursor: (shape) => scope.postMessage({ t: "cursor", stream, shape } satisfies FromWorker, [shape.rgba.buffer as ArrayBuffer]),
    drawn: (width, height) => post({ t: "drawn", stream, width, height }),
    closed: (code, fault) => {
      if (players.get(stream) !== entry) return;
      players.delete(stream);
      stopTimer(entry);
      const now = performance.now();
      if (code === VIDEO_CLOSE.slow) health.slowClose(now);
      post({ t: "closed", stream, code, link: health.state(now), ...(fault ? { fault } : {}) });
    },
  }, drive);
  const now = performance.now();
  const entry: Playing = { player, drive, counted: 0, at: now, health, readingAt: now, readingFrames: 0 };
  players.set(stream, entry);
  for (const surface of surfaces.values()) if (surface.stream === stream) player.show(surface);
}

scope.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.t === "open") open(message.stream, message.url, !!message.drive);
  else if (message.t === "close") {
    close(message.stream);
    links.delete(message.stream);
  }
  else if (message.t === "watch") {
    const entry = players.get(message.stream);
    if (!entry) return;
    entry.drive = false;
    entry.player.watch();
    stopTimer(entry);
    if (entry.player.nextDrawAt !== undefined) wake();
  } else if (message.t === "surface") surfaces.set(message.surface, new CanvasSurface(message.canvas));
  else if (message.t === "bind") {
    const surface = surfaces.get(message.surface);
    if (!surface) return;
    if (surface.stream !== null) players.get(surface.stream)?.player.hide(surface);
    surface.stream = message.stream;
    if (message.stream !== null) players.get(message.stream)?.player.show(surface);
  } else if (message.t === "input") players.get(message.stream)?.player.input(message.event);
  else if (message.t === "forget") {
    const surface = surfaces.get(message.surface);
    if (surface?.stream != null) players.get(surface.stream)?.player.hide(surface);
    surfaces.delete(message.surface);
  }
};

setInterval(() => {
  const now = performance.now();
  for (const [stream, entry] of [...players]) {
    entry.player.check(now);
    if (!players.has(stream)) continue;
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

setInterval(() => {
  const now = performance.now();
  for (const [stream, entry] of players) {
    const frames = entry.player.frames;
    const fps = ((frames - entry.readingFrames) * 1000) / Math.max(1, now - entry.readingAt);
    post({ t: "reading", stream, reading: { ...entry.player.timing(now), fps, link: entry.health.state(now) } });
    entry.readingAt = now;
    entry.readingFrames = frames;
    entry.player.ping(now);
  }
}, READING_MS);
