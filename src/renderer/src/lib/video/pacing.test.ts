import { describe, expect, it } from "vitest";
import { ArrivalClock, MAX_HOLD_MS, Presenter, presenterPhase, type Decoded } from "./pacing";

/** Frames 1/120 s apart at the source, each arriving `late(i)` ms after it would on an even link. */
function feed(clock: ArrivalClock, count: number, late: (i: number) => number, start = 0): { base: number; at: number }[] {
  const out: { base: number; at: number }[] = [];
  for (let i = 0; i < count; i++) {
    const captured = start + i * (1000 / 120);
    const at = captured + 30 + late(i);
    out.push({ base: clock.observe(captured * 1000, at), at });
  }
  return out;
}

describe("the hold", () => {
  it("is nothing when frames arrive evenly", () => {
    const clock = new ArrivalClock();
    feed(clock, 240, () => 0);
    expect(clock.holdMs).toBeCloseTo(0, 6);
  });

  it("covers the lateness of most recent frames: its 95th percentile", () => {
    const clock = new ArrivalClock();
    // one frame in ten is 20 ms late, the rest on time: the hold must cover the late ones
    feed(clock, 240, (i) => (i % 10 === 9 ? 20 : 0));
    expect(clock.holdMs).toBeCloseTo(20, 3);
    // one in forty: under the 95th percentile, so the hold does not wait for it
    const rare = new ArrivalClock();
    feed(rare, 240, (i) => (i % 40 === 39 ? 20 : 0));
    expect(rare.holdMs).toBeLessThan(1);
  });

  it("is never more than 100 ms, however uneven the link", () => {
    const clock = new ArrivalClock();
    feed(clock, 240, (i) => (i % 3 === 0 ? 400 : 0));
    expect(clock.holdMs).toBe(MAX_HOLD_MS);
  });

  it("rises at once and falls slowly: 0.05 ms for each millisecond that passes", () => {
    const clock = new ArrivalClock();
    feed(clock, 120, (i) => (i % 5 === 4 ? 40 : 0));
    expect(clock.holdMs).toBeCloseTo(40, 3);
    // the link is even again: the late frames age out of the two seconds the hold reads, and it shrinks at its slow rate
    feed(clock, 240, () => 0, 1000);
    const afterTwoSeconds = clock.holdMs;
    expect(afterTwoSeconds).toBeLessThan(40);
    expect(afterTwoSeconds).toBeGreaterThan(0);
    feed(clock, 360, () => 0, 3000);
    expect(clock.holdMs).toBeLessThan(afterTwoSeconds);
  });

  it("times a frame against the smallest recent offset between the two clocks", () => {
    const clock = new ArrivalClock();
    const seen = feed(clock, 30, (i) => (i === 10 ? 15 : 0));
    // the base is the even link's 30 ms, also for the frame that came late
    for (const s of seen) expect(s.base).toBeCloseTo(30, 6);
  });

  it("starts over when the offset jumps: a page that was still, or a long outage", () => {
    const clock = new ArrivalClock();
    feed(clock, 60, (i) => (i % 5 === 4 ? 40 : 0));
    expect(clock.holdMs).toBeGreaterThan(30);
    // the next frame is stamped as if a second passed that did not: the old samples say nothing about it
    const base = clock.observe(10_000_000, 600 + 30);
    expect(clock.holdMs).toBe(0);
    expect(base).toBeCloseTo(630 - 10_000, 6);
  });
});

describe("what the presenter does at a refresh", () => {
  it("draws on when two or fewer are due", () => {
    expect(presenterPhase(0, 0, 0, 0, 0)).toBe("idle");
    expect(presenterPhase(2, 1, 900, 900, 0)).toBe("idle");
    // three due, one of them drawn now: two are left, which is no backlog
    expect(presenterPhase(3, 1, 900, 900, 0)).toBe("idle");
  });
  it("waits half a second before it drops one, and a quarter between drops", () => {
    expect(presenterPhase(4, 1, 100, 10_000, 0)).toBe("backlog");
    expect(presenterPhase(4, 1, 600, 100, 0)).toBe("backlog");
    expect(presenterPhase(4, 1, 600, 300, 0)).toBe("catchUp");
  });
  it("drops down to two at once past twelve due, or a head that overstayed 200 ms", () => {
    expect(presenterPhase(13, 1, 0, 0, 0)).toBe("overrun");
    expect(presenterPhase(3, 0, 0, 0, 201)).toBe("overrun");
  });
});

interface Log {
  drawn: number[];
  retired: { sequence: number; wait: number; drawn: boolean }[];
}
function line(hold = 0) {
  const clock = new ArrivalClock();
  clock.holdMs = hold;
  const log: Log = { drawn: [], retired: [] };
  const presenter = new Presenter<string>(clock, {
    draw: (item) => void log.drawn.push(item.sequence),
    retire: (item, waitMs, drawn) => void log.retired.push({ sequence: item.sequence, wait: waitMs, drawn }),
  });
  /** a frame captured at `captured` ms that arrived at `arrived` ms, on clocks that agree */
  const frame = (sequence: number, captured: number, arrived: number): Decoded<string> => ({ generation: 1, sequence, timestamp: captured * 1000, arrived, base: 0, frame: `f${sequence}` });
  return { clock, presenter, log, frame };
}

describe("the line of decoded frames", () => {
  it("draws a frame the moment it comes when nothing waits and it is due, and acks it with its wait", () => {
    const { presenter, log, frame } = line();
    presenter.push(frame(1, 0, 4), 5);
    expect(log.drawn).toEqual([1]);
    expect(log.retired).toEqual([{ sequence: 1, wait: 1, drawn: true }]);
    expect(presenter.waiting).toBe(0);
  });

  it("draws one frame a refresh, and a second that came in the same refresh waits for the next", () => {
    const { presenter, log, frame } = line();
    presenter.push(frame(1, 0, 4), 5);
    presenter.push(frame(2, 8, 6), 8);
    expect(log.drawn).toEqual([1]);
    expect(presenter.waiting).toBe(1);
    expect(presenter.refresh(16)).toBe(true);
    expect(log.drawn).toEqual([1, 2]);
    // nothing left and nothing drawn: no further refresh is asked for
    expect(presenter.refresh(24)).toBe(false);
  });

  it("holds a frame until its capture time plus the hold has passed", () => {
    const { presenter, log, frame } = line(20);
    presenter.push(frame(1, 0, 2), 2);
    expect(log.drawn).toEqual([]);
    expect(presenter.refresh(16)).toBe(true);
    expect(log.drawn).toEqual([]);
    presenter.refresh(20);
    expect(log.drawn).toEqual([1]);
    expect(log.retired[0]).toEqual({ sequence: 1, wait: 18, drawn: true });
  });

  it("retires every frame in the order it came, drawn or passed over", () => {
    const { presenter, log, frame } = line();
    // a burst: fourteen frames due at once is past what a display can catch up on by drawing
    for (let i = 1; i <= 14; i++) presenter.push(frame(i, i, 100), 100 + i * 0.01);
    presenter.refresh(120);
    presenter.refresh(128);
    presenter.refresh(136);
    const order = log.retired.map((r) => r.sequence);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
    // most were passed over to get back to the newest picture, and each of those was still acked
    expect(log.retired.filter((r) => !r.drawn).length).toBeGreaterThanOrEqual(10);
    expect(log.drawn.at(-1)).toBe(14);
    expect(presenter.waiting).toBe(0);
  });

  it("on a 60 Hz screen under a 120 fps stream, keeps up by passing frames over, never by falling behind", () => {
    const { presenter, log, frame } = line();
    let now = 0;
    let sequence = 0;
    // ten seconds: a frame every 8.33 ms, a refresh every 16.67 ms
    for (let tick = 0; tick < 600; tick++) {
      for (let k = 0; k < 2; k++) {
        const captured = sequence * (1000 / 120);
        presenter.push(frame(++sequence, captured, captured + 1), captured + 1);
      }
      now = (tick + 1) * (1000 / 60);
      presenter.refresh(now);
    }
    // the line grows by a frame a refresh until it passes twelve, then drops to two: it never grows without bound
    expect(presenter.waiting).toBeLessThanOrEqual(13);
    expect(log.retired.length).toBeGreaterThanOrEqual(sequence - 13);
    // about half are drawn, and no frame waits longer than that line is long
    expect(log.drawn.length).toBeGreaterThan(500);
    expect(Math.max(...log.retired.map((r) => r.wait))).toBeLessThan(250);
    const order = log.retired.map((r) => r.sequence);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("retires what still waits when the stream goes, so the source is owed nothing", () => {
    const { presenter, log, frame } = line(50);
    presenter.push(frame(1, 0, 1), 1);
    presenter.push(frame(2, 8, 9), 9);
    presenter.flush(12);
    expect(log.retired).toEqual([
      { sequence: 1, wait: 11, drawn: false },
      { sequence: 2, wait: 3, drawn: false },
    ]);
    expect(presenter.waiting).toBe(0);
  });
});
