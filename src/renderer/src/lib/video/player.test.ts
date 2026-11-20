import { describe, expect, it } from "vitest";
import { encodeFrame, parseAck } from "@server/shared/video/nsl1";
import { MAX_PENDING, STALL_MS, StreamPlayer, type DecoderConfig, type PlayerDeps, type PlayerFault, type PlayerSocket, type Surface } from "./player";

interface FakeFrame {
  timestamp: number;
  closed: boolean;
  close(): void;
}

class FakeSocket implements PlayerSocket {
  binaryType = "";
  readyState = 1;
  sent: Uint8Array[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closedWith = code ?? 1005;
    this.readyState = 3;
  }
  acks(): [number, number][] {
    return this.sent.map((b) => parseAck(b)).map((a) => [a.generation, a.sequence]);
  }
}

// an access unit whose first NAL is an SPS of constrained baseline, so the codec string can be read from it
const KEY = Uint8Array.of(0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x2a, 0xda, 0x01, 0, 0, 0, 1, 0x65, 0x88);
const DELTA = Uint8Array.of(0, 0, 0, 1, 0x41, 0x9a, 0x24);

function rig(opts: { supported?: boolean; auto?: boolean } = {}) {
  const state = { now: 1000, wakes: 0 };
  let socket!: FakeSocket;
  const configs: DecoderConfig[] = [];
  const decoders: { chunks: { type: string; timestamp: number }[]; closed: boolean; out(timestamp: number): FakeFrame; fail(): void }[] = [];
  const frames: FakeFrame[] = [];
  const deps: PlayerDeps<FakeFrame> = {
    socket: (url, protocols) => (socket = new FakeSocket(url, protocols)),
    decoder: (init) => {
      const decoder = {
        chunks: [] as { type: string; timestamp: number }[],
        closed: false,
        out(timestamp: number): FakeFrame {
          const frame: FakeFrame = { timestamp, closed: false, close: () => void (frame.closed = true) };
          frames.push(frame);
          init.output(frame);
          return frame;
        },
        fail: () => init.error(new Error("bad stream")),
      };
      decoders.push(decoder);
      return {
        configure: (config) => void configs.push(config),
        decode: (chunk) => {
          decoder.chunks.push({ type: chunk.type, timestamp: chunk.timestamp });
          // a decoder that answers at once, unless the test hands frames out itself
          if (opts.auto !== false) decoder.out(chunk.timestamp);
        },
        close: () => void (decoder.closed = true),
      };
    },
    supported: async () => opts.supported ?? true,
    now: () => state.now,
    wake: () => void state.wakes++,
  };
  const drawn: [number, number][] = [];
  const closed: [number, PlayerFault | undefined][] = [];
  const player = new StreamPlayer<FakeFrame>("ws://127.0.0.1:1/video/s?ticket=t", deps, { drawn: (w, h) => drawn.push([w, h]), closed: (code, fault) => closed.push([code, fault]) });
  const send = (sequence: number, more: { generation?: number; keyframe?: boolean; width?: number; height?: number; at?: number } = {}): void => {
    const keyframe = more.keyframe ?? sequence === 1;
    const bytes = encodeFrame({ generation: more.generation ?? 1, sequence, keyframe, width: more.width ?? 1280, height: more.height ?? 800, timestamp: (more.at ?? state.now) * 1000, data: keyframe ? KEY : DELTA });
    socket.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  };
  const surface = (): Surface<FakeFrame> & { drew: [number, number, number][] } => {
    const drew: [number, number, number][] = [];
    return { drew, draw: (frame, width, height) => void drew.push([frame.timestamp, width, height]) };
  };
  return { state, player, socket: () => socket, configs, decoders, frames, drawn, closed, send, surface };
}

describe("a live stream in the worker", () => {
  it("opens its socket as nsl1 and reads bytes", () => {
    const r = rig();
    expect(r.socket().url).toBe("ws://127.0.0.1:1/video/s?ticket=t");
    expect(r.socket().protocols).toEqual(["nsl1"]);
    expect(r.socket().binaryType).toBe("arraybuffer");
  });

  it("configures the decoder from the first keyframe, low latency, at the frame's own size", () => {
    const r = rig();
    r.send(1);
    expect(r.configs).toEqual([{ codec: "avc1.42c02a", codedWidth: 1280, codedHeight: 800, optimizeForLatency: true }]);
    expect(r.decoders[0].chunks).toEqual([{ type: "key", timestamp: 1 }]);
    r.send(2);
    expect(r.decoders[0].chunks[1]).toEqual({ type: "delta", timestamp: 2 });
    expect(r.configs).toHaveLength(1);
  });

  it("draws a frame on every canvas shown, says so once per size, and acks it after the draw", () => {
    const r = rig();
    const a = r.surface();
    const b = r.surface();
    r.player.show(a);
    r.player.show(b);
    r.send(1);
    expect(a.drew).toEqual([[1, 1280, 800]]);
    expect(b.drew).toEqual([[1, 1280, 800]]);
    expect(r.drawn).toEqual([[1280, 800]]);
    expect(r.socket().acks()).toEqual([[1, 1]]);
    expect(r.frames[0].closed).toBe(true);
    expect(r.player.frames).toBe(1);
    // a canvas taken off is drawn on no more
    r.player.hide(b);
    r.state.now += 9;
    r.player.refresh(r.state.now);
    r.send(2);
    expect(a.drew).toHaveLength(2);
    expect(b.drew).toHaveLength(1);
    expect(r.drawn).toHaveLength(1);
  });

  it("acks every frame in the order it came, with how long it waited here, drawn or passed over", () => {
    const r = rig();
    r.send(1);
    // three more inside one refresh: one frame at most is drawn per refresh, the rest wait their turn
    r.send(2);
    r.send(3);
    r.send(4);
    expect(r.socket().acks()).toEqual([[1, 1]]);
    for (let i = 0; i < 3; i++) {
      r.state.now += 8;
      r.player.refresh(r.state.now);
    }
    expect(r.socket().acks()).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
      [1, 4],
    ]);
    const waits = r.socket().sent.map((b) => parseAck(b).waitMicros);
    expect(waits[0]).toBe(0);
    expect(waits[1]).toBe(8000);
    expect(waits[3]).toBe(24000);
    expect(r.frames.every((f) => f.closed)).toBe(true);
    // closing with frames in line acks them all first: the source is owed every one
    r.send(5);
    r.send(6);
    r.send(7);
    r.player.close();
    expect(r.socket().acks().map(([, s]) => s)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(r.socket().closedWith).toBe(1000);
    expect(r.closed).toEqual([]);
  });

  it("takes a new generation only from a keyframe numbered 1, with a decoder of its own", () => {
    const r = rig();
    r.send(1);
    r.send(2);
    r.send(1, { generation: 2, width: 640, height: 400 });
    expect(r.decoders).toHaveLength(2);
    expect(r.decoders[0].closed).toBe(true);
    expect(r.configs[1]).toMatchObject({ codedWidth: 640, codedHeight: 400 });
    r.state.now += 8;
    r.player.refresh(r.state.now);
    r.state.now += 8;
    r.player.refresh(r.state.now);
    expect(r.drawn).toEqual([
      [1280, 800],
      [640, 400],
    ]);
    expect(r.closed).toEqual([]);
    // one that starts in its middle is a broken stream
    const bad = rig();
    bad.send(1);
    bad.send(5, { generation: 2, keyframe: false });
    expect(bad.closed).toEqual([[0, "wire"]]);
    expect(bad.socket().closedWith).toBe(1000);
  });

  it("gives up on a gap, an older generation, bytes that are no frame, and a decoder that fails", () => {
    const gap = rig();
    gap.send(1);
    gap.send(3);
    expect(gap.closed).toEqual([[0, "wire"]]);
    const stale = rig();
    stale.send(1, { generation: 4 });
    stale.send(2, { generation: 3 });
    expect(stale.closed).toEqual([[0, "wire"]]);
    const junk = rig();
    junk.socket().onmessage?.({ data: new ArrayBuffer(8) });
    junk.socket().onmessage?.({ data: "text" });
    expect(junk.closed).toEqual([[0, "wire"]]);
    const broken = rig({ auto: false });
    broken.send(1);
    broken.decoders[0].fail();
    expect(broken.closed).toEqual([[0, "decode"]]);
    // nothing after it is over
    broken.send(2);
    expect(broken.decoders[0].chunks).toHaveLength(1);
  });

  it("says unsupported when this machine cannot decode the stream", async () => {
    const r = rig({ supported: false });
    r.send(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(r.closed).toEqual([[0, "unsupported"]]);
  });

  it("gives up on a stream whose first frame never comes, or whose decoder goes quiet, and on too many frames unanswered", () => {
    const silent = rig();
    silent.socket().onopen?.();
    silent.state.now += STALL_MS - 1;
    silent.player.check(silent.state.now);
    expect(silent.closed).toEqual([]);
    silent.state.now += 2;
    silent.player.check(silent.state.now);
    expect(silent.closed).toEqual([[0, "stalled"]]);
    const quiet = rig({ auto: false });
    quiet.send(1);
    quiet.state.now += STALL_MS + 1;
    quiet.player.check(quiet.state.now);
    expect(quiet.closed).toEqual([[0, "stalled"]]);
    // a still page is no stall: its one frame came and was answered
    const still = rig();
    still.send(1);
    still.state.now += 60_000;
    still.player.check(still.state.now);
    expect(still.closed).toEqual([]);
    const flood = rig({ auto: false });
    for (let i = 1; i <= MAX_PENDING + 1; i++) flood.send(i);
    expect(flood.closed).toEqual([[0, "wire"]]);
  });

  it("passes the socket's own close code on, and frees what it held", () => {
    const r = rig({ auto: false });
    r.send(1);
    r.send(2);
    const first = r.decoders[0].out(1);
    r.socket().readyState = 3;
    r.socket().onclose?.({ code: 4101 });
    expect(r.closed).toEqual([[4101, undefined]]);
    expect(first.closed).toBe(true);
    expect(r.decoders[0].closed).toBe(true);
    // a frame the decoder still hands out is closed, not kept
    const late = r.decoders[0].out(2);
    expect(late.closed).toBe(true);
    // and nothing is said twice
    r.player.close();
    expect(r.closed).toHaveLength(1);
  });
});
