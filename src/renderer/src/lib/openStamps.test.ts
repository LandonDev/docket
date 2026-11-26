import { describe, expect, it } from "vitest";
import { createOpenStamps, OPENS_KEPT } from "./openStamps";

function harness() {
  let clock = 0;
  const stamps = createOpenStamps(() => clock);
  return { stamps, at: (ms: number) => (clock = ms) };
}

describe("openStamps", () => {
  it("keeps the first ask, then the answer and the fold that follow it, in that order only", () => {
    const h = harness();
    h.stamps.answered("s1");
    h.stamps.folded("s1");
    expect(h.stamps.peek("s1")).toBeUndefined();
    h.at(10);
    h.stamps.press("s1");
    h.at(20);
    h.stamps.folded("s1");
    h.stamps.asked("s1");
    h.at(30);
    // A retry's ask keeps the first one: the wait for the lost answer is the fetch's.
    h.stamps.asked("s1");
    h.at(40);
    h.stamps.answered("s1");
    h.at(50);
    h.stamps.folded("s1");
    h.at(60);
    h.stamps.answered("s1");
    h.stamps.folded("s1");
    expect(h.stamps.take("s1")).toEqual({ pressAt: 10, askedAt: 20, answeredAt: 40, foldedAt: 50 });
    expect(h.stamps.take("s1")).toBeUndefined();
  });

  it("a press starts a new record, keeping an ask still out but not a load already folded", () => {
    const h = harness();
    h.at(5);
    h.stamps.asked("s1");
    h.at(8);
    h.stamps.press("s1");
    expect(h.stamps.peek("s1")).toEqual({ askedAt: 5, answeredAt: undefined, pressAt: 8 });
    h.stamps.answered("s1");
    h.stamps.folded("s1");
    h.at(20);
    h.stamps.press("s1");
    expect(h.stamps.peek("s1")).toEqual({ pressAt: 20 });
  });

  it("keeps at most OPENS_KEPT threads, the oldest dropped first", () => {
    const h = harness();
    for (let i = 0; i < OPENS_KEPT + 10; i++) h.stamps.asked(`s${i}`);
    expect(h.stamps.size()).toBe(OPENS_KEPT);
    expect(h.stamps.peek("s0")).toBeUndefined();
    expect(h.stamps.peek(`s${OPENS_KEPT + 9}`)).toBeDefined();
  });

  it("counts each host's sockets", () => {
    const h = harness();
    expect(h.stamps.linkOpens("box")).toBe(0);
    h.stamps.linkOpened("box");
    h.stamps.linkOpened("box");
    h.stamps.linkOpened("mac");
    expect(h.stamps.linkOpens("box")).toBe(2);
    expect(h.stamps.linkOpens("mac")).toBe(1);
  });
});
