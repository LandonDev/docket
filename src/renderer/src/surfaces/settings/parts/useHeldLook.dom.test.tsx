// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useHeldLook } from "./useHeldLook";
import { SAVE_SLOW_MS } from "./useSaved";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useHeldLook", () => {
  it("draws a hold only once it has lasted the save's slow mark, and drops it at once", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ held }) => useHeldLook(held), { initialProps: { held: false } });
    expect(result.current).toBe(false);
    rerender({ held: true });
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(SAVE_SLOW_MS - 1));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
    rerender({ held: false });
    expect(result.current).toBe(false);
  });

  it("never draws a hold that ended before the mark", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ held }) => useHeldLook(held), { initialProps: { held: true } });
    act(() => vi.advanceTimersByTime(60));
    rerender({ held: false });
    act(() => vi.advanceTimersByTime(SAVE_SLOW_MS));
    expect(result.current).toBe(false);
  });
});
