import { describe, expect, it } from "vitest";
import { boardPaintLine, createFirstPaintHistogram, FIRST_PAINT_MS, PRESS_FRESH_MS, splitOpen, watchFirstPaint } from "./firstPaint";
import { createOpenStamps } from "./openStamps";

function harness() {
  let clock = 0;
  const painted: (() => void)[] = [];
  const lines: string[] = [];
  const stamps = createOpenStamps(() => clock);
  const histogram = createFirstPaintHistogram();
  const open = (armed?: boolean, environmentId = "env_box") =>
    watchFirstPaint("s1", environmentId, {
      ...(armed === undefined ? {} : { armed }),
      now: () => clock,
      afterPaint: (fn) => painted.push(fn),
      report: (line) => lines.push(line),
      stamps,
      histogram,
    });
  const paint = () => {
    for (const fn of painted.splice(0)) fn();
  };
  return { open, paint, lines, stamps, histogram, at: (ms: number) => (clock = ms) };
}

describe("watchFirstPaint", () => {
  it("reports once when the first rows paint later than half a second after the pane opened, the old keys first", () => {
    const h = harness();
    const watch = h.open();
    h.at(650);
    watch.rows();
    h.at(700);
    h.paint();
    watch.rows();
    h.paint();
    expect(h.lines).toEqual(["first-paint session=s1 host=env_box ms=700 why=restore queued=0 fetch=0 fold=0 text=700"]);
  });

  it("says nothing for a quick paint or a pane closed before its rows", () => {
    const h = harness();
    const quick = h.open();
    h.at(FIRST_PAINT_MS);
    quick.rows();
    h.paint();
    h.at(1_000);
    const closed = h.open();
    closed.dispose();
    h.at(5_000);
    closed.rows();
    h.paint();
    expect(h.lines).toEqual([]);
    expect(h.histogram.flush()).toBe("first-paint-hist n=1 p50=500 p90=500 p95=500 max=500 open=0 restore=1 reconnect=0");
  });

  it("a draft never reports nor counts: its first rows arrive when the person sends", () => {
    const h = harness();
    const draft = h.open(false);
    h.at(30_000);
    draft.rows();
    h.paint();
    expect(h.lines).toEqual([]);
    expect(h.histogram.flush()).toBeNull();
  });

  it("an open's clock starts at the press, and its parts say where the time went", () => {
    const h = harness();
    h.at(1_000);
    h.stamps.press("s1");
    // The open hold: the pane mounts 300 ms after the press, the ask waits in the catch-up lane.
    h.at(1_300);
    const watch = h.open();
    h.at(1_450);
    h.stamps.asked("s1");
    h.at(2_150);
    h.stamps.answered("s1");
    h.at(2_190);
    h.stamps.folded("s1");
    h.at(2_200);
    watch.rows();
    h.at(2_260);
    h.paint();
    expect(h.lines).toEqual(["first-paint session=s1 host=env_box ms=1260 why=open queued=450 fetch=700 fold=40 text=70"]);
    expect(h.stamps.peek("s1")).toBeUndefined();
  });

  it("a press too old to have opened this pane does not start its clock", () => {
    const h = harness();
    h.stamps.press("s1");
    h.at(PRESS_FRESH_MS + 1);
    const watch = h.open();
    watch.rows();
    h.at(PRESS_FRESH_MS + 801);
    h.paint();
    expect(h.lines[0]).toMatch(/ ms=800 why=restore /);
  });

  it("rows that came after the host's link came back read reconnect; the link's first socket reads restore", () => {
    const h = harness();
    const atLaunch = h.open();
    h.stamps.linkOpened("env_box");
    atLaunch.rows();
    h.at(900);
    h.paint();
    const afterCut = h.open();
    h.stamps.linkOpened("env_box");
    afterCut.rows();
    h.at(2_000);
    h.paint();
    expect(h.lines.map((l) => l.match(/why=(\w+)/)?.[1])).toEqual(["restore", "reconnect"]);
    expect(h.histogram.flush()).toMatch(/ open=0 restore=1 reconnect=1$/);
  });
});

describe("splitOpen", () => {
  it("adds up to the whole, each part clamped into the open, a stamp from an older load ignored", () => {
    expect(splitOpen(1_000, 2_000, { askedAt: 900, answeredAt: 1_500, foldedAt: 1_600 })).toEqual({ queued: 0, fetch: 500, fold: 100, text: 400 });
    expect(splitOpen(1_000, 2_000, { askedAt: 1_200, answeredAt: 2_500 })).toEqual({ queued: 200, fetch: 800, fold: 0, text: 0 });
    expect(splitOpen(60_000, 61_000, { askedAt: 10, answeredAt: 20, foldedAt: 30 })).toEqual({ queued: 0, fetch: 0, fold: 0, text: 1_000 });
    expect(splitOpen(0, 300, undefined)).toEqual({ queued: 0, fetch: 0, fold: 0, text: 300 });
  });
});

describe("the first-paint histogram", () => {
  it("counts every open in fixed buckets and writes one line an hour, nothing for an hour with none", () => {
    const histogram = createFirstPaintHistogram();
    expect(histogram.flush()).toBeNull();
    for (let i = 0; i < 80; i++) histogram.add(90, "open");
    for (let i = 0; i < 15; i++) histogram.add(1_200, "restore");
    for (let i = 0; i < 4; i++) histogram.add(4_000, "reconnect");
    histogram.add(37_000, "open");
    expect(histogram.flush()).toBe("first-paint-hist n=100 p50=100 p90=1500 p95=1500 max=37000 open=81 restore=15 reconnect=4");
    expect(histogram.flush()).toBeNull();
  });

  it("a percentile never reads past the hour's worst, and one past the last bucket reads the worst", () => {
    const histogram = createFirstPaintHistogram();
    histogram.add(120, "open");
    expect(histogram.flush()).toBe("first-paint-hist n=1 p50=120 p90=120 p95=120 max=120 open=1 restore=0 reconnect=0");
    histogram.add(90_000, "open");
    histogram.add(95_000, "open");
    expect(histogram.flush()).toBe("first-paint-hist n=2 p50=95000 p90=95000 p95=95000 max=95000 open=2 restore=0 reconnect=0");
  });
});

describe("boardPaintLine", () => {
  it("splits the board's open into the wait for its answer and the render after it, the old keys first", () => {
    expect(boardPaintLine("m1", 13, 100, 340, 395)).toBe("board-paint master=m1 n=13 ms=295 answer=240 render=55");
    // An answer held from before this board mounted costs it no wait.
    expect(boardPaintLine("m1", 4, 100, 20, 160)).toBe("board-paint master=m1 n=4 ms=60 answer=0 render=60");
    expect(boardPaintLine("m1", 4, 100, null, 160)).toBe("board-paint master=m1 n=4 ms=60 answer=60 render=0");
  });
});
