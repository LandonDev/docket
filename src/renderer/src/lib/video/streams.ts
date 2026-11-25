import type { ServerPush } from "@server/shared/contract";
import type { CursorShape, InputEvent } from "@server/shared/video/nsl1";
import { VIDEO_MIN_EDGE, type VideoCloseFace, type VideoCopyAnswer, type VideoOpenAnswer, type VideoSizeAnswer, type VideoSizeParams } from "@server/shared/contract-video";
import { SIZE_REST_MS, sizeAskDue } from "@server/shared/video/guestSize";
import { registry } from "../connection/registry";
import type { GuestSizeAsk } from "../guestSize";
import { afterClose, streamUrl, type FromWorker, type StreamReading, type ToWorker } from "./messages";
import { REGROW, SHRINK, SHRINK_QUIET_MS } from "./support";

/**
 * The live streams of this window (docs/agents/live-video.md "The viewer").
 * One stream for each host and thread, however many places show it: the
 * browser canvas, the Computer section, a Computers tile and the full view
 * each put a canvas on the same stream, and the host runs one encoder for
 * the lot. A stream opens with the first place that wants it and closes a
 * moment after the last has gone, so a pane swapped for another does not
 * open it twice.
 *
 * This side asks `video.open`, hands the worker the socket's address, and
 * opens a dropped stream again with a fresh ticket (`afterClose`). The
 * worker (video.worker.ts) does the rest.
 */

export type StreamView =
  /** asked for, nothing drawn yet; the shape once the host has said it */
  | { status: "opening"; width?: number; height?: number }
  /** a frame is on the canvases */
  | { status: "live"; width: number; height: number }
  /** no video: what stands in its place */
  | { status: "over"; face: Exclude<VideoCloseFace, "again">; retry?: true };

export interface StreamWant {
  /** the long edge, in frame pixels, this place can show */
  edge: number;
  /** this place is the thread on screen: it takes the box's one display from another page */
  take: boolean;
  /** he drives this page: the stream is one his pointer and keys go down */
  drive?: boolean;
}

export interface StreamHandle {
  view(): StreamView;
  subscribe(fn: () => void): () => void;
  /** Draws the stream on a canvas, which is the worker's from then on: nothing else can draw on it. Returns the undo. */
  show(canvas: HTMLCanvasElement): () => void;
  /** frames drawn since the stream opened, and the rate of the last quarter second */
  onCount(fn: (frames: number, fps: number) => void): () => void;
  /** the agent's click, as shares of the picture */
  reading(): StreamReading | null;
  onReading(fn: (reading: StreamReading | null) => void): () => void;
  cursor(): CursorShape | null;
  onCursor(fn: (shape: CursorShape | null) => void): () => void;
  onClick(fn: (x: number, y: number) => void): () => void;
  /** one of his input events; it goes nowhere unless the host gave a stream he drives */
  input(event: InputEvent): void;
  /** The room or fixed size from this place, while it drives. */
  setGuestSize(ask: GuestSizeAsk | null): void;
  /** his clipboard's text into the page he drives, as a paste */
  paste(text: string): Promise<void>;
  /** the far clipboard's text after his copy in the page he drives (`video.copy`); null when it holds none */
  copy(): Promise<string | null>;
  /** opens a stream that is over once more */
  retry(): void;
  release(): void;
}

/** A stream nobody shows is kept this long, for the place that is about to show it. */
export const LINGER_MS = 1500;

export interface StreamLink {
  readonly transport: { url: string } | null;
  request<T>(method: string, params?: unknown): Promise<T>;
  onPush(fn: (push: ServerPush) => void): () => void;
  onOpen(fn: () => void): () => void;
}

export interface WorkerLike {
  postMessage(message: ToWorker, transfer?: Transferable[]): void;
  onmessage: ((event: { data: FromWorker }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface StreamsDeps {
  link(host: string): StreamLink | null;
  worker(): WorkerLike;
  /** the worker's half of a canvas; null when the canvas cannot be handed over */
  offscreen(canvas: HTMLCanvasElement): OffscreenCanvas | null;
  /** tells when a canvas is gone for good */
  collected?(canvas: HTMLCanvasElement, fn: () => void): void;
}

interface Entry {
  /** the stream's number in the worker */
  id: number;
  host: string;
  key: string;
  wants: Map<object, StreamWant>;
  view: StreamView;
  /** the host's own id of the open stream, the edge it was asked at and the long edge it answered */
  opened: { stream: string; edge: number; take: boolean; drive: boolean; long: number; ready: boolean } | null;
  size: SizeState;
  /** times it was opened again since a frame was last drawn */
  tries: number;
  /** moves with every open: an answer to an older one is dropped */
  round: number;
  listeners: Set<() => void>;
  counts: Set<(frames: number, fps: number) => void>;
  reading: StreamReading | null;
  readings: Set<(reading: StreamReading | null) => void>;
  cursor: CursorShape | null;
  cursors: Set<(shape: CursorShape | null) => void>;
  clicks: Set<(x: number, y: number) => void>;
  timer: ReturnType<typeof setTimeout> | null;
  linger: ReturnType<typeof setTimeout> | null;
  /** set while every place has shrunk below SHRINK: the stream is opened again, smaller, when it fires */
  shrink: ReturnType<typeof setTimeout> | null;
  offs: (() => void)[];
}

interface SizeState {
  places: Map<object, GuestSizeAsk>;
  place?: object;
  room: GuestSizeAsk | null;
  since: number;
  asked: GuestSizeAsk | null;
  timer?: ReturnType<typeof setTimeout>;
  pending?: true;
  unsupported?: true;
  inputs: number;
  elsewhere?: true;
  retryAt?: number;
}

const sameSetting = (a: GuestSizeAsk, b: GuestSizeAsk): boolean => a.mode === b.mode && a.detail === b.detail;
const sameSize = (a: GuestSizeAsk, b: GuestSizeAsk): boolean => sameSetting(a, b) && a.width === b.width && a.height === b.height;

const keyOf = (host: string, key: string): string => `${host}\n${key}`;

/** The source answered at the edge asked for, so the edge is what sizes it: a window smaller than that, or the box's page, comes at its own size whatever is asked. */
const heldDown = (opened: { edge: number; long: number }): boolean => opened.long <= opened.edge && opened.long >= opened.edge - 2;

export class VideoStreams {
  private readonly entries = new Map<string, Entry>();
  private readonly byId = new Map<number, Entry>();
  private readonly surfaces = new WeakMap<HTMLCanvasElement, number>();
  /** which stream each handed-over canvas shows now */
  private readonly bound = new Map<number, number>();
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private nextSurface = 1;
  /** this machine cannot decode the stream, or the worker would not load: no stream is asked for again */
  private broken = false;

  constructor(private readonly deps: StreamsDeps) {}

  /**
   * A chord on the drive stream of a host's computer, from a control beside the picture (the Windows VM's keys
   * menu): each key down in order, then up in reverse. False when no drive stream of it is live here.
   */
  press(host: string, key: string, keys: readonly number[]): boolean {
    const entry = this.entries.get(keyOf(host, key));
    if (!entry?.opened?.drive || entry.view.status !== "live" || !this.worker) return false;
    for (const k of keys) this.post({ t: "input", stream: entry.id, event: { type: "keyDown", key: k } });
    for (const k of [...keys].reverse()) this.post({ t: "input", stream: entry.id, event: { type: "keyUp", key: k } });
    if (keys.length && entry.opened.ready) this.sizeInput(entry);
    return true;
  }

  acquire(host: string, key: string, want: StreamWant): StreamHandle {
    const id = keyOf(host, key);
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { id: this.nextId++, host, key, wants: new Map(), view: { status: "opening" }, opened: null, size: { places: new Map(), room: null, since: 0, asked: null, inputs: 0 }, tries: 0, round: 0, listeners: new Set(), counts: new Set(), reading: null, readings: new Set(), cursor: null, cursors: new Set(), clicks: new Set(), timer: null, linger: null, shrink: null, offs: [] };
      this.entries.set(id, entry);
      this.byId.set(entry.id, entry);
    }
    const mine = entry;
    const token = {};
    if (mine.linger) clearTimeout(mine.linger);
    mine.linger = null;
    // new, or kept with nobody showing it and over since: a place that shows it now is a reason to ask again
    const fresh = mine.wants.size === 0 && (mine.round === 0 || mine.view.status === "over");
    mine.wants.set(token, want);
    if (!want.drive && !this.want(mine).drive) this.resetSizeAsk(mine);
    if (fresh) {
      mine.tries = 0;
      this.open(mine);
    } else this.grown(mine);
    let released = false;
    return {
      view: () => mine.view,
      subscribe: (fn) => (mine.listeners.add(fn), () => void mine.listeners.delete(fn)),
      show: (canvas) => this.show(mine, canvas),
      onCount: (fn) => (mine.counts.add(fn), () => void mine.counts.delete(fn)),
      reading: () => mine.reading,
      onReading: (fn) => (mine.readings.add(fn), () => void mine.readings.delete(fn)),
      cursor: () => (want.drive ? mine.cursor : null),
      onCursor: (fn) => {
        if (!want.drive) return () => {};
        mine.cursors.add(fn);
        return () => void mine.cursors.delete(fn);
      },
      onClick: (fn) => (mine.clicks.add(fn), () => void mine.clicks.delete(fn)),
      input: (event) => {
        if (!mine.opened?.drive || mine.view.status !== "live" || !this.worker) return;
        this.post({ t: "input", stream: mine.id, event });
        if (!want.drive || !mine.opened.ready || event.type === "releaseAll") return;
        const place = mine.size.places.get(token);
        if (place && token !== mine.size.place) {
          // Several canvases can show the same stream. Input chooses which room sizes it.
          mine.size.places.delete(token);
          mine.size.places.set(token, place);
          this.sizeRoom(mine);
        }
        this.sizeInput(mine);
      },
      setGuestSize: (ask) => {
        if (released || !want.drive) return;
        if (ask) mine.size.places.set(token, ask);
        else if (!mine.size.places.delete(token)) return;
        this.sizeRoom(mine);
      },
      paste: async (text) => {
        const stream = mine.opened;
        if (!stream?.drive || !text) return;
        await this.deps.link(mine.host)?.request("video.paste", { stream: stream.stream, text });
      },
      copy: async () => {
        const stream = mine.opened;
        if (!stream?.drive) return null;
        const answer = await this.deps.link(mine.host)?.request<VideoCopyAnswer>("video.copy", { stream: stream.stream });
        return answer?.text ?? null;
      },
      retry: () => {
        if (mine.view.status !== "over" || this.entries.get(id) !== mine) return;
        mine.tries = 0;
        this.open(mine);
      },
      release: () => {
        if (released) return;
        released = true;
        mine.wants.delete(token);
        // nobody drives it from here any more: the host has made it a watch stream, and the next driver asks for a new one
        if (mine.opened?.drive && !this.want(mine).drive) {
          mine.opened.drive = false;
          this.setCursor(mine, null);
          this.post({ t: "watch", stream: mine.id });
        }
        if (mine.size.places.delete(token)) this.sizeRoom(mine);
        if (mine.wants.size && this.entries.get(id) === mine) this.shrunk(mine);
        if (mine.wants.size || this.entries.get(id) !== mine) return;
        mine.linger = setTimeout(() => this.drop(mine), LINGER_MS);
      },
    };
  }

  /** Forget the last ask after handing back, so the next Take over asks for its starting room. */
  private resetSizeAsk(entry: Entry): void {
    entry.size.asked = null;
    entry.size.elsewhere = entry.size.retryAt = undefined;
  }

  private sizeRoom(entry: Entry): void {
    const size = entry.size;
    const last = [...size.places].at(-1);
    const room = last?.[1] ?? null;
    const was = size.room;
    size.place = last?.[0];
    size.room = room;
    if (was && room && sameSize(was, room)) return;
    size.since = Date.now();
    this.queueSize(entry);
  }

  private sizeInput(entry: Entry): void {
    const size = entry.size;
    size.inputs++;
    if (size.elsewhere === undefined || size.retryAt !== undefined) return;
    // Input travels through the worker on the video socket. Give it time to reach the host before the RPC.
    size.retryAt = Date.now() + SIZE_REST_MS;
    this.queueSize(entry);
  }

  private queueSize(entry: Entry): void {
    const size = entry.size;
    clearTimeout(size.timer);
    size.timer = undefined;
    const { room, asked, since, retryAt } = size;
    const opened = entry.opened;
    if (this.broken || !room || !opened?.drive || !opened.ready || size.pending || size.unsupported) return;
    if (size.elsewhere !== undefined && retryAt === undefined) return;
    const previous = retryAt === undefined && asked && sameSetting(asked, room) ? asked : null;
    const rest = room.mode === "fit" ? SIZE_REST_MS : 0;
    if (room.mode === "fit" ? !sizeAskDue(previous, room, rest) : previous && sameSize(previous, room)) return;
    const at = Math.max(since + rest, retryAt ?? 0);
    size.timer = setTimeout(() => {
      size.timer = undefined;
      const ask = size.room;
      const link = this.deps.link(entry.host);
      if (!ask || !link?.transport) return;
      const sentAfter = size.inputs;
      size.asked = ask;
      size.elsewhere = size.retryAt = undefined;
      size.pending = true;
      void link.request<VideoSizeAnswer>("video.size", { stream: opened.stream, ...ask } satisfies VideoSizeParams).then((answer) => {
        if (answer.ok) return;
        if (answer.reason === "unsupported") size.unsupported = true;
        if (answer.reason === "elsewhere" && size.asked === ask) {
          size.elsewhere = true;
          if (size.inputs > sentAfter) size.retryAt = Date.now() + SIZE_REST_MS;
        }
      }).catch(() => undefined).finally(() => {
        size.pending = undefined;
        this.queueSize(entry);
      });
    }, Math.max(0, at - Date.now()));
  }

  private want(entry: Entry): StreamWant {
    let edge = VIDEO_MIN_EDGE;
    let take = false;
    let drive = false;
    for (const w of entry.wants.values()) {
      edge = Math.max(edge, w.edge);
      take ||= w.take;
      drive ||= !!w.drive;
    }
    return { edge, take, drive };
  }

  /** A place joined a stream that is there already: it is opened again only when that gets the place more than it has. */
  private grown(entry: Entry): void {
    const want = this.want(entry);
    const opened = entry.opened;
    if (entry.view.status === "over") {
      // refused as busy when nobody asked to take the display, and now somebody does
      if (entry.view.face === "picture" && want.take && !(opened?.take ?? false) && !this.broken) this.open(entry);
      return;
    }
    // he took over: a watch stream is never turned into one that takes input, so a new one is asked for
    if (opened && want.drive && !opened.drive) return this.open(entry);
    // larger only when the edge we asked for is what held the picture down: the box's page comes at one size whatever is asked
    if (opened && want.edge > opened.edge * REGROW && heldDown(opened)) return this.open(entry);
    this.shrunk(entry);
  }

  /** Every place shows it far smaller than it was opened at: once that has held SHRINK_QUIET_MS, it is opened again at their size. */
  private shrunk(entry: Entry): void {
    const small = (): boolean => {
      const opened = entry.opened;
      return !!opened && entry.view.status !== "over" && heldDown(opened) && this.want(entry).edge < opened.edge * SHRINK;
    };
    if (!small()) {
      if (entry.shrink) clearTimeout(entry.shrink);
      entry.shrink = null;
      return;
    }
    entry.shrink ??= setTimeout(() => {
      entry.shrink = null;
      if (small() && entry.wants.size && this.entries.get(keyOf(entry.host, entry.key)) === entry) this.open(entry);
    }, SHRINK_QUIET_MS);
  }

  private set(entry: Entry, view: StreamView): void {
    entry.view = view;
    if (view.status === "over" && entry.reading) this.setReading(entry, null);
    for (const fn of [...entry.listeners]) fn();
  }

  private setReading(entry: Entry, reading: StreamReading | null): void {
    entry.reading = reading;
    for (const fn of [...entry.readings]) fn(reading);
  }

  private setCursor(entry: Entry, shape: CursorShape | null): void {
    if (entry.cursor === shape) return;
    entry.cursor = shape;
    for (const fn of [...entry.cursors]) fn(shape);
  }

  private open(entry: Entry): void {
    this.setCursor(entry, null);
    const round = ++entry.round;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.shrink) clearTimeout(entry.shrink);
    clearTimeout(entry.size.timer);
    entry.timer = entry.shrink = null;
    const link = this.broken ? null : this.deps.link(entry.host);
    const rpcUrl = link?.transport?.url;
    if (!link || !rpcUrl) return this.set(entry, { status: "over", face: "picture" });
    if (!entry.offs.length) {
      entry.offs.push(
        link.onPush((push) => {
          if (push.push !== "computer-click" || push.preview !== entry.opened?.stream || push.width <= 0 || push.height <= 0) return;
          for (const fn of [...entry.clicks]) fn(push.at[0] / push.width, push.at[1] / push.height);
        }),
        // the stream went with the socket that asked for it: a new socket asks again
        link.onOpen(() => {
          if (!entry.wants.size || this.broken) return;
          entry.tries = 0;
          this.open(entry);
        }),
      );
    }
    const closing = entry.opened;
    entry.opened = null;
    if (closing) void link.request("video.close", { stream: closing.stream }).catch(() => undefined);
    if (entry.view.status === "over") this.set(entry, { status: "opening" });
    const want = this.want(entry);
    link
      // a computer that outlives every thread (the Windows VM) is asked for by its name
      .request<VideoOpenAnswer>("video.open", { threadId: entry.key, ...(entry.key.startsWith("vm:") ? { computer: entry.key } : {}), maxEdge: want.edge, ...(want.take ? { take: true } : {}), ...(want.drive ? { drive: true } : {}), accepts: want.drive ? ["cursor", "pong"] : ["pong"] })
      .then((answer) => {
        if (entry.round !== round || !this.byId.has(entry.id)) {
          if (answer.ok) void link.request("video.close", { stream: answer.stream }).catch(() => undefined);
          return;
        }
        // every refusal gives way to the picture, which says what there is to say (Screen Recording off, no window)
        if (!answer.ok) return this.set(entry, { status: "over", face: "picture" });
        const drives = this.want(entry).drive;
        const drive = !!want.drive && !!drives;
        entry.opened = { stream: answer.stream, edge: want.edge, take: want.take, drive, long: Math.max(answer.width, answer.height), ready: false };
        if (!want.drive && drives) return this.open(entry);
        if (entry.view.status === "opening") this.set(entry, { status: "opening", width: answer.width, height: answer.height });
        this.post({ t: "open", stream: entry.id, url: streamUrl(rpcUrl, answer.stream, answer.ticket), ...(drive ? { drive: true } : {}) });
      })
      .catch(() => {
        // a host that does not know the call, or a socket that dropped: the picture says which
        if (entry.round === round) this.set(entry, { status: "over", face: "picture" });
      });
  }

  private drop(entry: Entry): void {
    if (entry.wants.size) return;
    this.entries.delete(keyOf(entry.host, entry.key));
    this.byId.delete(entry.id);
    entry.round++;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.shrink) clearTimeout(entry.shrink);
    clearTimeout(entry.size.timer);
    for (const off of entry.offs.splice(0)) off();
    for (const [surface, stream] of this.bound) if (stream === entry.id) this.bound.delete(surface);
    if (this.worker) this.post({ t: "close", stream: entry.id });
    const opened = entry.opened;
    entry.opened = null;
    if (opened) void this.deps.link(entry.host)?.request("video.close", { stream: opened.stream }).catch(() => undefined);
  }

  private show(entry: Entry, canvas: HTMLCanvasElement): () => void {
    let surface = this.surfaces.get(canvas);
    if (surface === undefined) {
      const offscreen = this.deps.offscreen(canvas);
      if (!offscreen) return () => undefined;
      const made = this.nextSurface++;
      surface = made;
      this.surfaces.set(canvas, made);
      this.post({ t: "surface", surface: made, canvas: offscreen }, [offscreen]);
      this.deps.collected?.(canvas, () => {
        this.bound.delete(made);
        if (this.worker) this.post({ t: "forget", surface: made });
      });
    }
    const id = surface;
    this.bound.set(id, entry.id);
    this.post({ t: "bind", surface: id, stream: entry.id });
    return () => {
      // another stream may have taken the canvas since
      if (this.bound.get(id) !== entry.id) return;
      this.bound.delete(id);
      this.post({ t: "bind", surface: id, stream: null });
    };
  }

  private post(message: ToWorker, transfer?: Transferable[]): void {
    if (!this.worker) {
      try {
        const worker = this.deps.worker();
        worker.onmessage = (event) => this.heard(event.data);
        worker.onerror = () => this.fail();
        this.worker = worker;
      } catch {
        return this.fail();
      }
    }
    this.worker.postMessage(message, transfer);
  }

  /** No video in this window from here on: every stream gives way to the picture. */
  private fail(): void {
    this.broken = true;
    for (const entry of this.entries.values()) {
      entry.round++;
      if (entry.timer) clearTimeout(entry.timer);
      clearTimeout(entry.size.timer);
      this.set(entry, { status: "over", face: "picture" });
    }
  }

  private heard(message: FromWorker): void {
    const entry = this.byId.get(message.stream);
    if (!entry) return;
    if (message.t === "cursor") {
      if (entry.opened?.drive) this.setCursor(entry, message.shape);
      return;
    }
    if (message.t === "drawn") {
      if (entry.opened && !entry.opened.ready) {
        entry.opened.ready = true;
        this.queueSize(entry);
      }
      entry.tries = 0;
      return this.set(entry, { status: "live", width: message.width, height: message.height });
    }
    if (message.t === "reading") {
      if (entry.opened?.ready) this.setReading(entry, message.reading);
      return;
    }
    if (message.t === "count") {
      for (const fn of [...entry.counts]) fn(message.frames, message.fps);
      return;
    }
    this.setCursor(entry, null);
    if (message.fault === "unsupported") return this.fail();
    if (entry.opened) entry.opened.ready = false;
    if (entry.reading && message.link && entry.reading.link !== message.link) this.setReading(entry, { ...entry.reading, link: message.link });
    clearTimeout(entry.size.timer);
    const next = afterClose(message.code, message.fault, entry.tries);
    if (next.then === "over") {
      entry.round++;
      return this.set(entry, { status: "over", face: next.face, ...(next.retry ? { retry: true as const } : {}) });
    }
    // the last frame stays on the canvases while the stream is opened again
    if (!next.keepTries) entry.tries++;
    if (!next.delayMs && entry.wants.size) return this.open(entry);
    const round = ++entry.round;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (entry.round === round && entry.wants.size) this.open(entry);
    }, next.delayMs);
  }
}

const gone = typeof FinalizationRegistry !== "undefined" ? new FinalizationRegistry<() => void>((fn) => fn()) : null;

/** The window's streams. */
export const videoStreams = new VideoStreams({
  link: (host) => registry.link(host) ?? null,
  worker: () => new Worker(new URL("./video.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike,
  offscreen: (canvas) => {
    try {
      return canvas.transferControlToOffscreen();
    } catch {
      // drawn on already, or handed over by something else
      return null;
    }
  },
  collected: (canvas, fn) => gone?.register(canvas, fn),
});
