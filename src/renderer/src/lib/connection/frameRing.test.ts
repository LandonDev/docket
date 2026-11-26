import { describe, expect, it } from "vitest";
import { createFrameRing } from "./frameRing";

describe("frameRing", () => {
  it("names the newest frame whose handling overlaps the window, else nothing", () => {
    const ring = createFrameRing(8);
    ring.note("push", "session-meta", 100, 101);
    ring.note("answer", "session.events", 200, 260);
    ring.note("push", "events", 270, 271);
    expect(ring.overlapping(250, 400)).toBe("push:events");
    expect(ring.overlapping(210, 265)).toBe("answer:session.events");
    expect(ring.overlapping(100.5, 150)).toBe("push:session-meta");
    expect(ring.overlapping(300, 500)).toBeUndefined();
  });

  it("is bounded: past its size the oldest frames are gone", () => {
    const ring = createFrameRing(4);
    ring.note("answer", "session.events", 0, 10);
    for (let i = 1; i <= 4; i++) ring.note("push", "events", 100 * i, 100 * i + 1);
    expect(ring.overlapping(0, 10)).toBeUndefined();
    expect(ring.overlapping(100, 101)).toBe("push:events");
  });
});
