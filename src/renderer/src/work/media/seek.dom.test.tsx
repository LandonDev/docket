import { afterEach, describe, expect, it, vi } from "vitest";
import { frameAt, frameCentre, frameStart, type FrameTable } from "@shared/contract-work-media";
import { frameOfMediaTime, seekToFrame, stepFrame, watchFrames } from "./seek";

const table: FrameTable = { kind: "cfr", start: 0, rate: { num: 24, den: 1 }, count: 120 };

/**
 * jsdom has no media: a `<video>` that seeks after a tick, fires one
 * `seeked` for the last of several quick seeks (as Chromium does), and
 * presents the frame `currentTime` falls in, reporting just under that
 * frame's start as `mediaTime`. `silent` presents nothing.
 */
class FakeVideo extends EventTarget {
  seeking = false;
  paused = false;
  silent = false;
  sets: number[] = [];
  private t = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private callbacks = new Map<number, VideoFrameRequestCallback>();
  private id = 0;
  get currentTime(): number {
    return this.t;
  }
  set currentTime(v: number) {
    this.t = v;
    this.sets.push(v);
    this.seeking = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.seeking = false;
      if (!this.silent) this.present();
      this.dispatchEvent(new Event("seeked"));
    }, 1);
  }
  pause(): void {
    this.paused = true;
  }
  present(): void {
    const calls = [...this.callbacks.values()];
    this.callbacks.clear();
    // a hair under the frame's start, as Chromium reports a start it rounded down
    const mediaTime = frameStart(table, frameAt(table, this.t)) - 1e-6;
    for (const cb of calls) cb(0, { mediaTime } as VideoFrameCallbackMetadata);
  }
  requestVideoFrameCallback(cb: VideoFrameRequestCallback): number {
    this.callbacks.set(++this.id, cb);
    return this.id;
  }
  cancelVideoFrameCallback(id: number): void {
    this.callbacks.delete(id);
  }
}
const fake = (): { el: HTMLVideoElement; v: FakeVideo } => {
  const v = new FakeVideo();
  return { v, el: v as unknown as HTMLVideoElement };
};

afterEach(() => void vi.useRealTimers());

describe("seekToFrame", () => {
  it("pauses, seeks to the centre of the frame and names it from the frame callback", async () => {
    const { v, el } = fake();
    expect(await seekToFrame(el, table, 25)).toBe(25);
    expect(v.paused).toBe(true);
    expect(v.sets).toEqual([frameCentre(table, 25)]);
  });

  it("clamps to the table", async () => {
    const { v, el } = fake();
    expect(await seekToFrame(el, table, 500)).toBe(119);
    expect(v.sets).toEqual([frameCentre(table, 119)]);
  });

  it("falls back to currentTime when no frame callback comes", async () => {
    vi.useFakeTimers();
    const { v, el } = fake();
    v.silent = true;
    const p = seekToFrame(el, table, 48);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe(48);
  });

  it("returns at once when the frame is already shown", async () => {
    const { v, el } = fake();
    await seekToFrame(el, table, 12);
    expect(await seekToFrame(el, table, 12)).toBe(12);
    expect(v.sets).toHaveLength(1);
  });

  it("lets a newer seek take over: the older resolves with what is shown and does not throw", async () => {
    const { el } = fake();
    const older = seekToFrame(el, table, 10);
    const newer = seekToFrame(el, table, 70);
    expect(await Promise.all([older, newer])).toEqual([70, 70]);
  });

  it("ends the wait on the signal", async () => {
    vi.useFakeTimers();
    const { v, el } = fake();
    v.silent = true;
    const stop = new AbortController();
    const p = seekToFrame(el, table, 30, stop.signal);
    stop.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await p).toBe(30);
  });
});

describe("frameOfMediaTime", () => {
  it("names the frame whose start was rounded down, on a constant and a varying rate", () => {
    expect(frameOfMediaTime(table, 0.083333)).toBe(2);
    expect(frameOfMediaTime(table, 0.083)).toBe(2);
    const vfr: FrameTable = { kind: "vfr", times: [0, 0.033, 0.1, 0.133], end: 0.166 };
    expect(frameOfMediaTime(vfr, 0.0999)).toBe(2);
    expect(frameOfMediaTime(vfr, 0)).toBe(0);
  });
});

describe("stepFrame", () => {
  it("steps from the frame shown to the next one's centre, never by adding 1/fps", async () => {
    const { v, el } = fake();
    await seekToFrame(el, table, 11);
    expect(await stepFrame(el, table, 1)).toBe(12);
    expect(v.sets.at(-1)).toBe(frameCentre(table, 12));
  });

  it("adds up quick presses from where the running seek is heading", async () => {
    const { el } = fake();
    await seekToFrame(el, table, 40);
    const a = stepFrame(el, table, 1);
    const b = stepFrame(el, table, 1);
    const c = stepFrame(el, table, -5);
    expect(await Promise.all([a, b, c])).toEqual([37, 37, 37]);
  });

  it("stays at the ends", async () => {
    const { v, el } = fake();
    await seekToFrame(el, table, 0);
    expect(await stepFrame(el, table, -1)).toBe(0);
    expect(v.sets).toEqual([]);
  });
});

describe("watchFrames", () => {
  it("reports each new frame once, and nothing after stop", () => {
    const { v, el } = fake();
    const seen: number[] = [];
    const stop = watchFrames(el, table, (n) => seen.push(n));
    for (const t of [0, 0.01, 1 / 24, 0.5, 0.5]) {
      Object.defineProperty(v, "t", { value: t, writable: true });
      v.present();
    }
    stop();
    Object.defineProperty(v, "t", { value: 2, writable: true });
    v.present();
    expect(seen).toEqual([0, 1, 12]);
  });
});
