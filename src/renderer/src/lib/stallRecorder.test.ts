import { describe, expect, it } from "vitest";
import { createFrameRing } from "./connection/frameRing";
import { createStallRecorder, STALL_MS, type StallContext } from "./stallRecorder";

function harness() {
  const lines: string[] = [];
  let clock = 1000;
  const pushes = { session: 0, event: 0 };
  const paints: (() => void)[] = [];
  const ring = createFrameRing(4);
  const ctx: StallContext = {
    pushes: () => ({ ...pushes }),
    pendingMethods: () => ["session.events", "queue.list"],
    runningCount: () => 4,
    visibility: () => "visible",
    frameAt: (start, end) => ring.overlapping(start, end),
  };
  const recorder = createStallRecorder({
    ctx,
    report: (line) => lines.push(line),
    now: () => clock,
    afterPaint: (fn) => paints.push(fn),
  });
  return {
    lines,
    ring,
    pushes,
    recorder,
    advance: (ms: number) => (clock += ms),
    paint: () => paints.splice(0).forEach((fn) => fn()),
  };
}

describe("stall recorder (renderer)", () => {
  it("a long task line carries the last switch, the second's pushes, pending requests, running count and visibility", () => {
    const h = harness();
    h.pushes.session = 30;
    h.pushes.event = 120;
    h.recorder.switched("tab-switch", "tab-9");
    h.advance(400);
    h.recorder.longtask(320);
    expect(h.lines).toEqual([
      "longtask 320ms switch=tab-switch:tab-9@400ms pushes=session:30,event:120 pending=session.events,queue.list running=4 visibility=visible cause=none",
    ]);
  });

  it("ignores tasks under the threshold and forgets a switch older than five seconds", () => {
    const h = harness();
    h.recorder.longtask(STALL_MS - 1);
    expect(h.lines).toEqual([]);
    h.recorder.switched("page-switch", "settings");
    h.advance(6000);
    h.recorder.longtask(200);
    expect(h.lines[0]).toContain("switch=- ");
  });

  it("a switch logs when its paint lands late, and stays quiet when it is quick", () => {
    const h = harness();
    h.recorder.switched("page-switch", "inbox");
    h.advance(40);
    h.paint();
    expect(h.lines).toEqual([]);
    h.recorder.switched("tab-switch", "tab-2");
    h.advance(900);
    h.paint();
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toMatch(/^switch tab-switch:tab-2 900ms switch=tab-switch:tab-2@900ms /);
  });

  it("pushes count the previous full second plus the current one, settled by tick", () => {
    const h = harness();
    h.pushes.session = 5;
    h.recorder.tick();
    h.pushes.session = 12;
    h.recorder.longtask(200);
    expect(h.lines[0]).toContain("pushes=session:12,event:0");
    h.recorder.tick();
    h.recorder.tick();
    h.recorder.longtask(200);
    expect(h.lines[1]).toContain("pushes=session:0,event:0");
  });

  it("writes at most ten lines a second and refills on tick", () => {
    const h = harness();
    for (let i = 0; i < 25; i++) h.recorder.longtask(200);
    expect(h.lines).toHaveLength(10);
    h.recorder.tick();
    h.recorder.longtask(200);
    expect(h.lines).toHaveLength(11);
    h.recorder.dispose();
    h.recorder.longtask(200);
    expect(h.lines).toHaveLength(11);
  });

  it("a long task names the answer or push it ran for, the newest that overlapped it, else none", () => {
    const h = harness();
    h.ring.note("push", "session-meta", 100, 101);
    h.ring.note("answer", "session.events", 1_000, 1_020);
    h.recorder.longtask(400, 990);
    h.recorder.longtask(200, 5_000);
    // No start: the task is taken to have just ended (the clock reads 1000), so 800..1000, which meets the answer.
    h.recorder.longtask(200);
    expect(h.lines.map((l) => l.split(" cause=")[1])).toEqual(["answer:session.events", "none", "answer:session.events"]);
    expect(h.lines[0]).toMatch(/^longtask 400ms switch=- .* pending=session\.events,queue\.list running=4 visibility=visible cause=answer:session\.events$/);
  });

  it("a switch line carries no cause", () => {
    const h = harness();
    h.ring.note("answer", "session.events", 1_000, 1_020);
    h.recorder.switched("tab-switch", "tab-2");
    h.advance(900);
    h.paint();
    expect(h.lines[0]).not.toContain("cause=");
  });
});
