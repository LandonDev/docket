import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quietPoll } from "./quietPoll";

/** A check that waits out every push, sleeps while the window is hidden, and runs once as it shows again if it came due. */

const doc = () => {
  const listeners = new Set<() => void>();
  return {
    hidden: false,
    addEventListener: (_: string, l: () => void) => void listeners.add(l),
    removeEventListener: (_: string, l: () => void) => void listeners.delete(l),
    show() {
      this.hidden = false;
      for (const l of listeners) l();
    },
  };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a quiet poll", () => {
  it("runs every period it hears nothing", () => {
    const run = vi.fn();
    const p = quietPoll(run, 30_000, doc());
    vi.advanceTimersByTime(5 * 60_000);
    expect(run).toHaveBeenCalledTimes(10);
    p.stop();
  });

  it("runs none in five minutes while a push comes every 20 seconds", () => {
    const run = vi.fn();
    const p = quietPoll(run, 30_000, doc());
    for (let t = 0; t < 15; t++) {
      vi.advanceTimersByTime(20_000);
      p.heard();
    }
    expect(run).not.toHaveBeenCalled();
    p.stop();
  });

  it("runs none while the window is hidden, and once as it shows again", () => {
    const run = vi.fn();
    const d = doc();
    d.hidden = true;
    const p = quietPoll(run, 10_000, d);
    vi.advanceTimersByTime(5 * 60_000);
    expect(run).not.toHaveBeenCalled();
    d.show();
    expect(run).toHaveBeenCalledTimes(1);
    p.stop();
    vi.advanceTimersByTime(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
