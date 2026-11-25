// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLast, useSaving, useSince, useStage } from "./useCalm";

/** The frame's clock for the save line (useCalm.ts): it draws again when the rule's answer changes by time alone. */

afterEach(() => vi.useRealTimers());

describe("the save line's clock in a window", () => {
  it("turns to Saving… by itself once a send has been out 600 ms", () => {
    vi.useFakeTimers();
    const sent = Date.now();
    const hook = renderHook(() => useSaving({ edited: null, pause: 700, sent }));
    expect(hook.result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(601));
    expect(hook.result.current).toBe(true);
  });

  it("holds a stage the frame says itself for 600 ms from when it began, and the last steady line meanwhile", () => {
    vi.useFakeTimers();
    const hook = renderHook(({ on, line }: { on: boolean; line: string }) => ({ shown: useStage(useSince(on)), last: useLast(line, line.startsWith("Saved"), (l) => l) }), { initialProps: { on: false, line: "Saved to MacBook 1:52 PM" } });
    expect(hook.result.current).toEqual({ shown: false, last: "Saved to MacBook 1:52 PM" });
    hook.rerender({ on: true, line: "Saving to MacBook…" });
    expect(hook.result.current).toEqual({ shown: false, last: "Saved to MacBook 1:52 PM" });
    act(() => void vi.advanceTimersByTime(601));
    expect(hook.result.current.shown).toBe(true);
    // It ends: the next stage counts again from its own start.
    hook.rerender({ on: false, line: "Saved to MacBook 1:53 PM" });
    expect(hook.result.current).toEqual({ shown: false, last: "Saved to MacBook 1:53 PM" });
    hook.rerender({ on: true, line: "Saving to MacBook…" });
    expect(hook.result.current.shown).toBe(false);
  });
});
