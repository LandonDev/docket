// @vitest-environment jsdom
/** One minute clock for the window (perf pass M12): one timer however many readers, stopped with the last. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { minuteForTest, useMinute } from "./minute";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the minute clock", () => {
  it("holds one timer with eight readers, moves them all at the boundary, and stops with the last", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 24, 9, 0, 30) });
    const armed = vi.spyOn(globalThis, "setTimeout");
    const seen: number[][] = Array.from({ length: 8 }, () => []);
    function Reader({ i }: { i: number }) {
      seen[i]!.push(useMinute());
      return null;
    }
    const view = render(
      <>
        {seen.map((_, i) => (
          <Reader key={i} i={i} />
        ))}
      </>,
    );
    expect(minuteForTest.readers()).toBe(8);
    expect(armed).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(30_000));
    // At the boundary each reader drew once more, all with the same time; the clock armed itself once for the next.
    expect(seen.map((s) => s.length)).toEqual(Array(8).fill(2));
    expect(new Set(seen.map((s) => s[1])).size).toBe(1);
    expect(armed).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(minuteForTest.armed()).toBe(false);
    armed.mockRestore();
  });
});
