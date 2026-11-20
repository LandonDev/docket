import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerPush } from "@server/shared/contract";
import { VIDEO_CLOSE, VIDEO_RETRIES, type VideoOpenAnswer } from "@server/shared/contract-video";
import { afterClose, RETRY_DELAYS_MS, streamUrl, type FromWorker, type ToWorker } from "./messages";
import { LINGER_MS, VideoStreams, type StreamLink, type WorkerLike } from "./streams";
import { nextEdge, pixelRatioOf, SHRINK_QUIET_MS, videoEdge } from "./support";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function rig(answers: (VideoOpenAnswer | Error)[] = []) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const pushers = new Set<(push: ServerPush) => void>();
  const openers = new Set<() => void>();
  let n = 0;
  const link: StreamLink = {
    transport: { url: "wss://box.example/ws?ticket=old" },
    request: async <T,>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params: params as Record<string, unknown> });
      if (method !== "video.open") return null as T;
      n++;
      const answer = answers.length ? answers.shift()! : ({ ok: true, stream: `s${n}`, ticket: `t${n}`, width: 1280, height: 800, fps: 120 } satisfies VideoOpenAnswer);
      if (answer instanceof Error) throw answer;
      return answer as T;
    },
    onPush: (fn) => (pushers.add(fn), () => void pushers.delete(fn)),
    onOpen: (fn) => (openers.add(fn), () => void openers.delete(fn)),
  };
  const posted: ToWorker[] = [];
  let workers = 0;
  const worker: WorkerLike = { postMessage: (m) => void posted.push(m), onmessage: null, onerror: null };
  const collected: (() => void)[] = [];
  const state = { link: link as StreamLink | null, offscreen: true };
  const streams = new VideoStreams({
    link: () => state.link,
    worker: () => (workers++, worker),
    offscreen: () => (state.offscreen ? ({} as OffscreenCanvas) : null),
    collected: (_canvas, fn) => void collected.push(fn),
  });
  const say = (message: FromWorker): void => worker.onmessage?.({ data: message });
  const opens = () => calls.filter((c) => c.method === "video.open").map((c) => c.params);
  const closes = () => calls.filter((c) => c.method === "video.close").map((c) => c.params.stream);
  const canvas = (): HTMLCanvasElement => ({}) as HTMLCanvasElement;
  return { streams, calls, posted, say, opens, closes, canvas, state, pushers, openers, collected, workers: () => workers, worker };
}

describe("where a stream's socket is, and what a closed one does next", () => {
  it("puts the stream's socket beside the RPC socket, with the ticket and nothing of the old address", () => {
    expect(streamUrl("ws://127.0.0.1:4123", "abc", "tk")).toBe("ws://127.0.0.1:4123/video/abc?ticket=tk");
    expect(streamUrl("wss://box.example/ws?ticket=old&profile=remote", "a/b", "t k")).toBe("wss://box.example/video/a%2Fb?ticket=t+k");
  });

  it("opens a dropped or slow stream again five times, then gives way to the picture", () => {
    for (const code of [1006, 1001, VIDEO_CLOSE.slow]) {
      expect(afterClose(code, undefined, 0)).toEqual({ then: "again", delayMs: RETRY_DELAYS_MS[0] });
      expect(afterClose(code, undefined, VIDEO_RETRIES - 1)).toEqual({ then: "again", delayMs: RETRY_DELAYS_MS[4] });
      expect(afterClose(code, undefined, VIDEO_RETRIES)).toEqual({ then: "over", face: "picture" });
    }
    // a decoder that failed or went quiet is one more drop
    expect(afterClose(0, "decode", 1).then).toBe("again");
    expect(afterClose(0, "stalled", VIDEO_RETRIES)).toEqual({ then: "over", face: "picture" });
  });

  it("never opens again a stream the host ended, and gives way at once on a machine that cannot decode it", () => {
    expect(afterClose(VIDEO_CLOSE.moved, undefined, 0)).toEqual({ then: "over", face: "picture" });
    expect(afterClose(VIDEO_CLOSE.busy, undefined, 0)).toEqual({ then: "over", face: "picture" });
    expect(afterClose(VIDEO_CLOSE.held, undefined, 0)).toEqual({ then: "over", face: "kept" });
    expect(afterClose(VIDEO_CLOSE.ended, undefined, 0)).toEqual({ then: "over", face: "stopped" });
    expect(afterClose(VIDEO_CLOSE.revoked, undefined, 0)).toEqual({ then: "over", face: "stopped" });
    expect(afterClose(VIDEO_CLOSE.error, undefined, 0)).toEqual({ then: "over", face: "stopped", retry: true });
    expect(afterClose(VIDEO_CLOSE.permission, undefined, 0)).toEqual({ then: "over", face: "permission" });
    expect(afterClose(0, "unsupported", 0)).toEqual({ then: "over", face: "picture" });
  });

  it("asks again only past a quarter larger or below six tenths, and in the pixels of the window the picture is in", () => {
    expect(nextEdge(null, 1280)).toBe(1280);
    expect(nextEdge(1280, 1536)).toBe(1280);
    expect(nextEdge(1280, 1664)).toBe(1664);
    expect(nextEdge(1280, 832)).toBe(1280);
    expect(nextEdge(1280, 704)).toBe(704);
    const inPopOut = { ownerDocument: { defaultView: { devicePixelRatio: 1 } } } as unknown as Element;
    const onRetina = { ownerDocument: { defaultView: { devicePixelRatio: 2 } } } as unknown as Element;
    expect(pixelRatioOf(inPopOut)).toBe(1);
    expect(pixelRatioOf(onRetina)).toBe(2);
  });

  it("asks for the place's width in device pixels, in steps of 64, inside the wire's bounds", () => {
    expect(videoEdge(640, 2)).toBe(1280);
    expect(videoEdge(333, 2)).toBe(704);
    expect(videoEdge(10, 1)).toBe(256);
    expect(videoEdge(5000, 2)).toBe(3840);
  });
});

describe("the window's streams", () => {
  it("presses a chord on a live drive stream only, keys down in order and up in reverse", async () => {
    const r = rig();
    const h = r.streams.acquire("box", "vm:windows", { edge: 1280, take: true, drive: true });
    expect(r.streams.press("box", "vm:windows", [224, 226, 76])).toBe(false);
    await settle();
    r.say({ t: "drawn", stream: 1, width: 1280, height: 800 });
    expect(h.view().status).toBe("live");
    expect(r.streams.press("box", "vm:windows", [224, 226, 76])).toBe(true);
    const inputs = r.posted.filter((m) => m.t === "input").map((m) => (m.t === "input" && "key" in m.event ? `${m.event.type === "keyDown" ? "+" : "-"}${m.event.key}` : ""));
    expect(inputs).toEqual(["+224", "+226", "+76", "-76", "-226", "-224"]);
    // not on a stream asked only to watch
    r.streams.acquire("box", "t2", { edge: 640, take: false });
    await settle();
    expect(r.streams.press("box", "t2", [227])).toBe(false);
  });

  it("asks for a computer that outlives every thread by its name", async () => {
    const r = rig();
    r.streams.acquire("box", "vm:windows", { edge: 1280, take: true });
    await settle();
    expect(r.opens()).toEqual([{ threadId: "vm:windows", computer: "vm:windows", maxEdge: 1280, take: true }]);
  });

  it("opens one stream for a host and thread, however many places show it, and tells the worker where its socket is", async () => {
    const r = rig();
    const a = r.streams.acquire("box", "thread-1", { edge: 1280, take: true });
    const b = r.streams.acquire("box", "thread-1", { edge: 640, take: false });
    await settle();
    expect(r.opens()).toEqual([{ threadId: "thread-1", maxEdge: 1280, take: true }]);
    expect(r.posted).toEqual([{ t: "open", stream: 1, url: "wss://box.example/video/s1?ticket=t1" }]);
    expect(r.workers()).toBe(1);
    // the shape is known before the first frame
    expect(a.view()).toEqual({ status: "opening", width: 1280, height: 800 });
    const seen: string[] = [];
    b.subscribe(() => seen.push(b.view().status));
    r.say({ t: "drawn", stream: 1, width: 1280, height: 800 });
    expect(a.view()).toEqual({ status: "live", width: 1280, height: 800 });
    expect(seen).toEqual(["live"]);
    // another thread is another stream
    r.streams.acquire("box", "thread-2", { edge: 640, take: false });
    await settle();
    expect(r.opens()[1]).toEqual({ threadId: "thread-2", maxEdge: 640 });
    expect(r.posted.at(-1)).toMatchObject({ t: "open", stream: 2 });
  });

  it("hands a canvas to the worker once, and binds it to the stream it shows", async () => {
    const r = rig();
    const a = r.streams.acquire("box", "t1", { edge: 640, take: true });
    const b = r.streams.acquire("box", "t2", { edge: 640, take: true });
    await settle();
    const canvas = r.canvas();
    const off = a.show(canvas);
    expect(r.posted.filter((m) => m.t === "surface")).toHaveLength(1);
    expect(r.posted.at(-1)).toEqual({ t: "bind", surface: 1, stream: 1 });
    // the same canvas on another stream: handed over already, bound anew
    const off2 = b.show(canvas);
    expect(r.posted.filter((m) => m.t === "surface")).toHaveLength(1);
    expect(r.posted.at(-1)).toEqual({ t: "bind", surface: 1, stream: 2 });
    // the first stream's undo does not take it from the second
    off();
    expect(r.posted.at(-1)).toEqual({ t: "bind", surface: 1, stream: 2 });
    off2();
    expect(r.posted.at(-1)).toEqual({ t: "bind", surface: 1, stream: null });
    // a canvas that is gone for good is forgotten by the worker
    r.collected[0]();
    expect(r.posted.at(-1)).toEqual({ t: "forget", surface: 1 });
    // one that cannot be handed over shows nothing and breaks nothing
    r.state.offscreen = false;
    const before = r.posted.length;
    a.show(r.canvas())();
    expect(r.posted).toHaveLength(before);
  });

  it("passes on the counts and the agent's clicks of its own stream", async () => {
    const r = rig();
    const a = r.streams.acquire("box", "t1", { edge: 640, take: true });
    await settle();
    const counts: [number, number][] = [];
    const clicks: [number, number][] = [];
    a.onCount((frames, fps) => counts.push([frames, fps]));
    a.onClick((x, y) => clicks.push([x, y]));
    r.say({ t: "count", stream: 1, frames: 30, fps: 118 });
    for (const push of r.pushers) {
      push({ push: "computer-click", preview: "s1", at: [320, 200], width: 1280, height: 800 });
      push({ push: "computer-click", preview: "another", at: [1, 1], width: 10, height: 10 });
    }
    expect(counts).toEqual([[30, 118]]);
    expect(clicks).toEqual([[0.25, 0.25]]);
  });

  it("opens a dropped stream again with a fresh ticket, five times, keeping the last frame, then gives way", async () => {
    const r = rig();
    const a = r.streams.acquire("box", "t1", { edge: 640, take: true });
    await settle();
    r.say({ t: "drawn", stream: 1, width: 1280, height: 800 });
    for (let i = 0; i < VIDEO_RETRIES; i++) {
      r.say({ t: "closed", stream: 1, code: 1006 });
      // the picture he has stays while the stream is opened again
      expect(a.view().status).toBe("live");
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[i] - 1);
      expect(r.opens()).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(r.opens()).toHaveLength(i + 2);
      expect(r.posted.at(-1)).toEqual({ t: "open", stream: 1, url: `wss://box.example/video/s${i + 2}?ticket=t${i + 2}` });
    }
    r.say({ t: "closed", stream: 1, code: 1006 });
    expect(a.view()).toEqual({ status: "over", face: "picture" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.opens()).toHaveLength(VIDEO_RETRIES + 1);
    // a frame drawn in between starts the count again
    const r2 = rig();
    r2.streams.acquire("box", "t1", { edge: 640, take: true });
    await settle();
    for (let i = 0; i < 12; i++) {
      r2.say({ t: "closed", stream: 1, code: VIDEO_CLOSE.slow });
      await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
      await settle();
      r2.say({ t: "drawn", stream: 1, width: 1280, height: 800 });
    }
    expect(r2.opens()).toHaveLength(13);
  });

  it("does not open again a stream the display was taken from, and shows why a stream the host ended is over", async () => {
    const r = rig();
    const a = r.streams.acquire("box", "t1", { edge: 640, take: true });
    await settle();
    r.say({ t: "closed", stream: 1, code: VIDEO_CLOSE.moved });
    expect(a.view()).toEqual({ status: "over", face: "picture" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.opens()).toHaveLength(1);
    // Retry is his: it asks once more
    a.retry();
    expect(a.view()).toEqual({ status: "opening" });
    await settle();
    expect(r.opens()).toHaveLength(2);
    r.say({ t: "closed", stream: 1, code: VIDEO_CLOSE.error });
    expect(a.view()).toEqual({ status: "over", face: "stopped", retry: true });
    r.say({ t: "closed", stream: 1, code: VIDEO_CLOSE.permission });
    expect(a.view()).toEqual({ status: "over", face: "permission" });
  });

  it("gives way to the picture when the host refuses, does not know the call, or is not connected", async () => {
    const refused = rig([{ ok: false, reason: "busy" }]);
    const a = refused.streams.acquire("box", "t1", { edge: 640, take: false });
    await settle();
    expect(a.view()).toEqual({ status: "over", face: "picture" });
    expect(refused.posted).toEqual([]);
    // somebody who takes the display joins: it is asked again, with take
    refused.streams.acquire("box", "t1", { edge: 640, take: true });
    await settle();
    expect(refused.opens()).toEqual([
      { threadId: "t1", maxEdge: 640 },
      { threadId: "t1", maxEdge: 640, take: true },
    ]);
    expect(a.view().status).toBe("opening");
    const old = rig([new Error("unknown method video.open")]);
    const b = old.streams.acquire("mac", "t1", { edge: 640, take: true });
    await settle();
    expect(b.view()).toEqual({ status: "over", face: "picture" });
    const offline = rig();
    offline.state.link = null;
    expect(offline.streams.acquire("mac", "t1", { edge: 640, take: true }).view()).toEqual({ status: "over", face: "picture" });
  });

  it("asks nothing more once this machine cannot decode a stream, or the worker fails", async () => {
    const r = rig();
    const a = r.streams.acquire("box", "t1", { edge: 640, take: true });
    const b = r.streams.acquire("box", "t2", { edge: 640, take: true });
    await settle();
    r.say({ t: "closed", stream: 1, code: 0, fault: "unsupported" });
    expect(a.view()).toEqual({ status: "over", face: "picture" });
    expect(b.view()).toEqual({ status: "over", face: "picture" });
    const before = r.opens().length;
    expect(r.streams.acquire("box", "t3", { edge: 640, take: true }).view()).toEqual({ status: "over", face: "picture" });
    a.retry();
    await settle();
    expect(r.opens()).toHaveLength(before);
    const crashed = rig();
    const c = crashed.streams.acquire("box", "t1", { edge: 640, take: true });
    await settle();
    crashed.worker.onerror?.({});
    expect(c.view()).toEqual({ status: "over", face: "picture" });
  });

  it("opens it again larger when a place grows well past its edge, but not a stream whose size is the source's own", async () => {
    const mac = rig([{ ok: true, stream: "m1", ticket: "t", width: 640, height: 400, fps: 120 }]);
    mac.streams.acquire("mac", "t1", { edge: 640, take: true });
    await settle();
    // a little larger: not worth a new encoder
    mac.streams.acquire("mac", "t1", { edge: 768, take: true });
    await settle();
    expect(mac.opens()).toHaveLength(1);
    // the full view
    mac.streams.acquire("mac", "t1", { edge: 2560, take: true });
    await settle();
    expect(mac.opens()[1]).toEqual({ threadId: "t1", maxEdge: 2560, take: true });
    expect(mac.closes()).toEqual(["m1"]);
    // the box's page is 1280 wide whatever is asked
    const box = rig();
    box.streams.acquire("box", "t1", { edge: 640, take: true });
    await settle();
    box.streams.acquire("box", "t1", { edge: 2560, take: true });
    await settle();
    expect(box.opens()).toHaveLength(1);
  });

  it("opens it again smaller once every place has shown it below six tenths of its edge for five seconds, and not while one still shows it large", async () => {
    const mac = rig([
      { ok: true, stream: "m1", ticket: "t", width: 2560, height: 1600, fps: 120 },
      { ok: true, stream: "m2", ticket: "t", width: 1280, height: 800, fps: 120 },
    ]);
    // the stage asks large, the pop-out small
    const stage = mac.streams.acquire("mac", "t1", { edge: 2560, take: true });
    await settle();
    const pop = mac.streams.acquire("mac", "t1", { edge: 1280, take: false });
    await settle();
    vi.advanceTimersByTime(SHRINK_QUIET_MS * 2);
    await settle();
    expect(mac.opens()).toHaveLength(1);
    // he leaves the page: the pop-out alone does not hold the large stream open
    stage.release();
    vi.advanceTimersByTime(SHRINK_QUIET_MS - 1);
    await settle();
    expect(mac.opens()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await settle();
    expect(mac.opens()[1]).toEqual({ threadId: "t1", maxEdge: 1280 });
    expect(mac.closes()).toEqual(["m1"]);
    pop.release();
  });

  it("does not shrink a stream that comes at the source's own size, and a place that grows back in time keeps it", async () => {
    const box = rig();
    const a = box.streams.acquire("box", "t1", { edge: 2560, take: true });
    await settle();
    box.streams.acquire("box", "t1", { edge: 512, take: false });
    a.release();
    vi.advanceTimersByTime(SHRINK_QUIET_MS * 2);
    await settle();
    // the box's page answered 1280 to an ask of 2560: the edge is not what sizes it
    expect(box.opens()).toHaveLength(1);
    const mac = rig([{ ok: true, stream: "m1", ticket: "t", width: 2560, height: 1600, fps: 120 }]);
    const big = mac.streams.acquire("mac", "t1", { edge: 2560, take: true });
    await settle();
    const small = mac.streams.acquire("mac", "t1", { edge: 1024, take: false });
    big.release();
    vi.advanceTimersByTime(SHRINK_QUIET_MS - 100);
    // back on the stage before the five seconds are out
    mac.streams.acquire("mac", "t1", { edge: 2560, take: true });
    vi.advanceTimersByTime(SHRINK_QUIET_MS);
    await settle();
    expect(mac.opens()).toHaveLength(1);
    small.release();
  });

  it("keeps a stream a moment after its last place has gone, then closes it on the host and in the worker", async () => {
    const r = rig();
    const a = r.streams.acquire("box", "t1", { edge: 640, take: true });
    await settle();
    a.release();
    a.release();
    await vi.advanceTimersByTimeAsync(LINGER_MS - 1);
    // the place that takes over from it finds the stream running
    const b = r.streams.acquire("box", "t1", { edge: 640, take: true });
    await settle();
    expect(r.opens()).toHaveLength(1);
    b.release();
    await vi.advanceTimersByTimeAsync(LINGER_MS);
    expect(r.posted.at(-1)).toEqual({ t: "close", stream: 1 });
    expect(r.closes()).toEqual(["s1"]);
    // the worker's last word of it reaches nobody
    r.say({ t: "closed", stream: 1, code: 1000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.opens()).toHaveLength(1);
    // shown again later, it is a new stream
    r.streams.acquire("box", "t1", { edge: 640, take: true });
    await settle();
    expect(r.posted.at(-1)).toMatchObject({ t: "open", stream: 2 });
  });

  it("asks again when the RPC socket comes back, and when a place shows a stream that was over", async () => {
    const r = rig();
    const a = r.streams.acquire("box", "t1", { edge: 640, take: true });
    await settle();
    r.say({ t: "closed", stream: 1, code: VIDEO_CLOSE.revoked });
    expect(a.view()).toEqual({ status: "over", face: "stopped" });
    for (const fn of r.openers) fn();
    await settle();
    expect(r.opens()).toHaveLength(2);
    expect(a.view().status).toBe("opening");
    // over, left, and shown again within the moment it is kept
    r.say({ t: "closed", stream: 1, code: VIDEO_CLOSE.moved });
    a.release();
    const b = r.streams.acquire("box", "t1", { edge: 640, take: true });
    await settle();
    expect(r.opens()).toHaveLength(3);
    expect(b.view().status).toBe("opening");
  });

  it("drops the answer to an open that a newer one overtook, and closes the stream it made", async () => {
    let release!: (answer: VideoOpenAnswer) => void;
    const r = rig();
    const slow = new Promise<VideoOpenAnswer>((resolve) => (release = resolve));
    const request = r.state.link!.request.bind(r.state.link);
    let first = true;
    r.state.link = {
      ...r.state.link!,
      request: (async <T,>(method: string, params?: unknown): Promise<T> => {
        if (method === "video.open" && first) {
          first = false;
          r.calls.push({ method, params: params as Record<string, unknown> });
          return (await slow) as T;
        }
        return request<T>(method, params);
      }) as StreamLink["request"],
    };
    const a = r.streams.acquire("box", "t1", { edge: 640, take: true });
    a.release();
    await vi.advanceTimersByTimeAsync(LINGER_MS);
    release({ ok: true, stream: "late", ticket: "t", width: 1280, height: 800, fps: 120 });
    await settle();
    expect(r.closes()).toEqual(["late"]);
    expect(r.posted.filter((m) => m.t === "open")).toEqual([]);
  });

  it("asks for a stream he drives when a place drives, and a new one each time he takes over", async () => {
    const r = rig();
    const watching = r.streams.acquire("box", "t1", { edge: 640, take: true });
    await settle();
    expect(r.opens()).toEqual([{ threadId: "t1", maxEdge: 640, take: true }]);
    // he took over: a watch stream is never turned into a drive stream
    const driving = r.streams.acquire("box", "t1", { edge: 640, take: true, drive: true });
    await settle();
    expect(r.opens()[1]).toEqual({ threadId: "t1", maxEdge: 640, take: true, drive: true });
    expect(r.closes()).toEqual(["s1"]);
    // he handed back: the stream plays on as a watch stream, with no new one
    driving.release();
    await settle();
    expect(r.opens()).toHaveLength(2);
    // and took over again: the host made the old one a watch stream, so a new one is asked for
    r.streams.acquire("box", "t1", { edge: 640, take: true, drive: true });
    await settle();
    expect(r.opens()).toHaveLength(3);
    expect(r.opens()[2]).toMatchObject({ drive: true });
    watching.release();
  });

  it("passes his input and his paste only on a stream he drives that is live", async () => {
    const r = rig();
    const watch = r.streams.acquire("box", "t1", { edge: 640, take: true });
    await settle();
    r.say({ t: "drawn", stream: 1, width: 1280, height: 800 });
    watch.input({ type: "keyDown", key: 4 });
    await watch.paste("hunter2");
    expect(r.posted.filter((m) => m.t === "input")).toEqual([]);
    expect(r.calls.filter((c) => c.method === "video.paste")).toEqual([]);
    const drive = r.streams.acquire("box", "t2", { edge: 640, take: true, drive: true });
    await settle();
    // not before a frame is on screen: he cannot act on what he does not see
    drive.input({ type: "keyDown", key: 4 });
    expect(r.posted.filter((m) => m.t === "input")).toEqual([]);
    r.say({ t: "drawn", stream: 2, width: 1280, height: 800 });
    drive.input({ type: "keyDown", key: 4 });
    expect(r.posted.at(-1)).toEqual({ t: "input", stream: 2, event: { type: "keyDown", key: 4 } });
    await drive.paste("hunter2");
    await drive.paste("");
    expect(r.calls.filter((c) => c.method === "video.paste").map((c) => c.params)).toEqual([{ stream: "s2", text: "hunter2" }]);
  });
});
