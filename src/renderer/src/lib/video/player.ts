import { encodeAck, h264Codec, parseFrame, SUBPROTOCOL } from "@server/shared/video/nsl1";
import { ArrivalClock, Presenter, type Decoded } from "./pacing";

/**
 * One live stream in the viewer's worker (docs/agents/live-video.md "The
 * viewer"): its socket, its decoder, the line of decoded frames and the
 * canvases it draws on. Bytes come in as NSL1 frames, go through WebCodecs,
 * wait in the presenter for their refresh, and are drawn on every canvas
 * shown; each frame is then acked with how long it waited here, drawn or
 * passed over, in the order it came.
 *
 * Nothing here names the DOM or the worker's globals: the socket, the
 * decoder and the clock are handed in, so the rules run under test.
 *
 * The checks on what arrives (a generation starts with a keyframe numbered
 * 1, sequences run without a gap, a decoder that says nothing for five
 * seconds) follow screen-relay 0.1.2's viewer (github.com/vercel-labs/
 * screen-relay, `viewer/main.ts`, Apache-2.0).
 */

/** Frames sent and not yet out of the decoder: past this the stream is broken. */
export const MAX_PENDING = 360;
/** The first frame, or the decoder's answer for the oldest frame, must come within this. */
export const STALL_MS = 5000;

/** Why a player stopped by itself; a socket's own close carries its code instead. */
export type PlayerFault = "unsupported" | "decode" | "wire" | "stalled";

export interface PlayerSocket {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
}

export interface PlayerDecoder {
  configure(config: DecoderConfig): void;
  decode(chunk: { type: "key" | "delta"; timestamp: number; data: Uint8Array }): void;
  close(): void;
}

export interface DecoderConfig {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  optimizeForLatency: true;
}

/** One canvas a stream is drawn on: the worker's half of a canvas element. */
export interface Surface<F> {
  /** the frame at the stream's own size, pixel for pixel */
  draw(frame: F, width: number, height: number): void;
}

export interface PlayerDeps<F extends { timestamp: number; close(): void }> {
  socket(url: string, protocols: string[]): PlayerSocket;
  decoder(init: { output(frame: F): void; error(error: Error): void }): PlayerDecoder;
  /** `VideoDecoder.isConfigSupported` */
  supported(config: DecoderConfig): Promise<boolean>;
  now(): number;
  /** a refresh is wanted: the worker's frame clock calls `refresh` */
  wake(): void;
}

export interface PlayerEvents {
  /** a frame is on the canvases, the first of its size */
  drawn(width: number, height: number): void;
  /** the stream is over: the socket's close code, or 0 with why the player gave up */
  closed(code: number, fault?: PlayerFault): void;
}

const OPEN = 1;

interface Waiting {
  generation: number;
  sequence: number;
  timestamp: number;
  arrived: number;
  base: number;
  width: number;
  height: number;
}

export class StreamPlayer<F extends { timestamp: number; close(): void }> {
  private readonly socket: PlayerSocket;
  private decoder: PlayerDecoder | null = null;
  private readonly clock = new ArrivalClock();
  private readonly presenter: Presenter<F>;
  private readonly surfaces = new Set<Surface<F>>();
  /** frames in the decoder, by the number they went in under */
  private readonly pending = new Map<number, Waiting>();
  /** the size of each decoded frame still in line, by its sequence */
  private readonly sizes = new Map<number, { width: number; height: number }>();
  private generation = 0;
  private sequence = 0;
  private openedAt: number;
  private over = false;
  private size: { width: number; height: number } | null = null;
  /** frames drawn since the stream opened */
  frames = 0;

  constructor(
    url: string,
    private readonly deps: PlayerDeps<F>,
    private readonly events: PlayerEvents,
  ) {
    this.presenter = new Presenter(this.clock, {
      draw: (item) => this.draw(item),
      retire: (item, waitMs) => {
        this.sizes.delete(item.sequence);
        item.frame.close();
        this.ack(item.generation, item.sequence, waitMs);
      },
    });
    this.openedAt = deps.now();
    const socket = deps.socket(url, [SUBPROTOCOL]);
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      this.openedAt = this.deps.now();
    };
    socket.onmessage = (event) => this.receive(event.data);
    socket.onclose = (event) => this.end(event.code);
    socket.onerror = () => undefined;
  }

  /** A canvas the stream is drawn on from the next frame. */
  show(surface: Surface<F>): void {
    this.surfaces.add(surface);
  }

  hide(surface: Surface<F>): void {
    this.surfaces.delete(surface);
  }

  /** One tick of the frame clock. True when another is wanted. */
  refresh(now: number): boolean {
    return !this.over && this.presenter.refresh(now);
  }

  /** Called now and then: a stream whose first frame never came, or whose decoder went quiet, is given up on. */
  check(now: number): void {
    if (this.over) return;
    const oldest = this.pending.values().next().value;
    if (oldest ? now - oldest.arrived > STALL_MS : !this.sequence && now - this.openedAt > STALL_MS) this.fail("stalled");
  }

  /** The viewer is done with it: every waiting frame is acked, and the socket closes. */
  close(): void {
    if (this.over) return;
    this.presenter.flush(this.deps.now());
    this.over = true;
    this.release();
    this.socket.close(1000);
  }

  private receive(data: unknown): void {
    if (this.over) return;
    try {
      if (!(data instanceof ArrayBuffer)) throw new Error("not bytes");
      const frame = parseFrame(data);
      if (this.generation && frame.generation < this.generation) throw new Error("a stale generation");
      if (frame.generation !== this.generation) {
        // a new encoder at the source: nothing of the old one is of use to the new
        this.resetDecoder();
        this.generation = frame.generation;
        this.sequence = 0;
        if (!frame.keyframe || frame.sequence !== 1) throw new Error("a generation must start with a keyframe");
      }
      if (frame.sequence !== this.sequence + 1 || this.pending.size >= MAX_PENDING) throw new Error("a frame out of order");
      this.sequence = frame.sequence;
      const arrived = this.deps.now();
      const waiting: Waiting = { generation: frame.generation, sequence: frame.sequence, timestamp: frame.timestamp, arrived, base: this.clock.observe(frame.timestamp, arrived), width: frame.width, height: frame.height };
      if (!this.decoder) {
        const config: DecoderConfig = { codec: h264Codec(frame.data), codedWidth: frame.width, codedHeight: frame.height, optimizeForLatency: true };
        void this.deps.supported(config).then(
          (ok) => (ok ? undefined : this.fail("unsupported")),
          () => this.fail("unsupported"),
        );
        this.decoder = this.makeDecoder();
        this.decoder.configure(config);
      }
      // a frame goes in under its sequence: the decoder hands it back under the same number
      this.pending.set(frame.sequence, waiting);
      this.decoder.decode({ type: frame.keyframe ? "key" : "delta", timestamp: frame.sequence, data: frame.data });
    } catch {
      this.fail("wire");
    }
  }

  private makeDecoder(): PlayerDecoder {
    const generation = this.generation;
    return this.deps.decoder({
      output: (frame) => {
        const waiting = generation === this.generation && !this.over ? this.pending.get(frame.timestamp) : undefined;
        if (!waiting) return frame.close();
        this.pending.delete(frame.timestamp);
        this.sizes.set(waiting.sequence, { width: waiting.width, height: waiting.height });
        const item: Decoded<F> = { generation: waiting.generation, sequence: waiting.sequence, timestamp: waiting.timestamp, arrived: waiting.arrived, base: waiting.base, frame };
        this.presenter.push(item, this.deps.now());
        this.deps.wake();
      },
      error: () => {
        if (generation === this.generation) this.fail("decode");
      },
    });
  }

  private draw(item: Decoded<F>): void {
    const size = this.sizes.get(item.sequence);
    if (!size) return;
    for (const surface of this.surfaces) surface.draw(item.frame, size.width, size.height);
    this.frames++;
    if (this.size?.width === size.width && this.size.height === size.height) return;
    this.size = size;
    this.events.drawn(size.width, size.height);
  }

  private ack(generation: number, sequence: number, waitMs: number): void {
    if (this.socket.readyState !== OPEN) return;
    try {
      this.socket.send(encodeAck(generation, sequence, waitMs));
    } catch {
      // the socket is going: its close says so
    }
  }

  private resetDecoder(): void {
    // frames of the old encoder that never came out are owed nothing: the source starts its count again
    this.pending.clear();
    const old = this.decoder;
    this.decoder = null;
    try {
      old?.close();
    } catch {
      // closed by its own error
    }
  }

  private release(): void {
    this.resetDecoder();
    this.sizes.clear();
    this.surfaces.clear();
  }

  private fail(fault: PlayerFault): void {
    if (this.over) return;
    this.presenter.flush(this.deps.now());
    this.over = true;
    this.release();
    try {
      this.socket.close(1000);
    } catch {
      // closed already
    }
    this.events.closed(0, fault);
  }

  private end(code: number): void {
    if (this.over) return;
    this.presenter.flush(this.deps.now());
    this.over = true;
    this.release();
    this.events.closed(code);
  }
}
