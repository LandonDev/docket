import { describe, expect, it } from "vitest";
import { segmentQueue, segmentsToEvict, segmentsToLoad, type Segment, type Sink } from "./segments";

const four = (n: number): Segment[] => Array.from({ length: n }, (_, i) => ({ start: i * 4, duration: 4 }));
const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

describe("segmentsToLoad", () => {
  it("names the segment holding the playhead first, then the next 30 seconds", () => {
    expect(segmentsToLoad(four(20), 9, 30, new Set())).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });
  it("skips what is held", () => {
    expect(segmentsToLoad(four(20), 0, 12, new Set([0, 2]))).toEqual([1]);
  });
  it("starts at the first before the stream and at the last after it", () => {
    expect(segmentsToLoad(four(3), -1, 4, new Set())).toEqual([0]);
    expect(segmentsToLoad(four(3), 50, 30, new Set())).toEqual([2]);
    expect(segmentsToLoad([], 0, 30, new Set())).toEqual([]);
  });
  it("puts a frame on a boundary in the segment it starts", () => {
    expect(segmentsToLoad(four(5), 8, 1, new Set())).toEqual([2]);
  });
});

describe("segmentsToEvict", () => {
  it("drops what ended 30 seconds behind and what a seek back left far ahead", () => {
    expect(segmentsToEvict(four(40), 60, 30, 30, new Set([0, 5, 6, 7, 15, 20, 25, 30]))).toEqual([0, 5, 6, 25, 30]);
  });
});

/** A sink and a host that answer when told to, recording what the queue did. */
function rig(segments: Segment[], ended: boolean) {
  const ops: string[] = [];
  const fetches = new Map<string, { resolve: (b: ArrayBuffer) => void; reject: (e: unknown) => void }>();
  let t = 0;
  const sink: Sink = {
    append: async (data) => void ops.push(`append ${new TextDecoder().decode(data)}`),
    remove: async (from, to) => void ops.push(`remove ${from}-${to}`),
    setDuration: (s) => void ops.push(`duration ${s}`),
    end: () => void ops.push("end")
  };
  const q = segmentQueue({
    init: "init",
    segments,
    ended,
    sink,
    now: () => t,
    segmentUrl: async (i) => `seg${i}`,
    fetch: (url, signal) =>
      new Promise((resolve, reject) => {
        fetches.set(url, { resolve, reject });
        signal.addEventListener("abort", () => {
          fetches.delete(url);
          reject(new DOMException("aborted", "AbortError"));
        });
      })
  });
  const answer = async (url: string): Promise<void> => {
    await flush();
    const f = fetches.get(url);
    if (!f) throw new Error(`nobody asked for ${url}; asked: ${[...fetches.keys()].join(", ")}`);
    fetches.delete(url);
    f.resolve(new TextEncoder().encode(url).buffer as ArrayBuffer);
    await flush();
  };
  return { q, ops, fetches, answer, at: (s: number) => void (t = s) };
}

describe("segmentQueue", () => {
  it("appends init, then the window in order, then ends once the host has finished", async () => {
    const r = rig(four(3), true);
    r.q.pump();
    await r.answer("init");
    await r.answer("seg0");
    await r.answer("seg1");
    await r.answer("seg2");
    expect(r.ops).toEqual(["append init", "duration 12", "append seg0", "append seg1", "append seg2", "end"]);
  });

  it("runs one loop at a time however often it is pumped", async () => {
    const r = rig(four(3), false);
    r.q.pump();
    r.q.pump();
    r.q.pump();
    await r.answer("init");
    expect([...r.fetches.keys()]).toEqual(["seg0"]);
  });

  it("on a seek drops the fetch in flight and loads the target's segment first", async () => {
    const r = rig(four(30), true);
    r.q.pump();
    await r.answer("init");
    await r.answer("seg0");
    await flush();
    expect([...r.fetches.keys()]).toEqual(["seg1"]);
    r.at(90);
    r.q.seek();
    await r.answer("seg22");
    expect(r.ops).not.toContain("append seg1");
    expect(r.ops.at(-1)).toBe("append seg22");
    expect(r.ops).toContain("remove 0-4");
    expect([...r.q.have]).toEqual([22]);
  });

  it("evicts behind the playhead as it moves on", async () => {
    const r = rig(four(30), false);
    r.q.pump();
    await r.answer("init");
    for (let i = 0; i < 8; i++) await r.answer(`seg${i}`);
    r.at(40);
    r.q.pump();
    await r.answer("seg10");
    expect(r.ops).toContain("remove 0-4");
    expect(r.ops).toContain("remove 4-8");
    expect(r.ops).not.toContain("remove 8-12");
  });

  it("grows when the host lists more, and ends only after it says it has finished", async () => {
    const r = rig(four(1), false);
    r.q.pump();
    await r.answer("init");
    await r.answer("seg0");
    expect(r.ops).not.toContain("end");
    r.q.update(four(2), false);
    await r.answer("seg1");
    expect(r.ops).toContain("duration 8");
    expect(r.ops).not.toContain("end");
    r.q.update(four(2), true);
    await flush();
    expect(r.ops.at(-1)).toBe("end");
  });

  it("stops on destroy", async () => {
    const r = rig(four(3), true);
    r.q.pump();
    await r.answer("init");
    r.q.destroy();
    await flush();
    expect(r.fetches.size).toBe(0);
    expect(r.ops).toEqual(["append init", "duration 12"]);
  });
});
