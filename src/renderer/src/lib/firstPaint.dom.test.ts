// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firstPaintHistogram, useFirstPaintReport } from "./firstPaint";

beforeEach(() => {
  firstPaintHistogram.flush();
  // The paint lands at once: the count is what is under test, not the frame.
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 0;
  });
});
afterEach(() => vi.restoreAllMocks());

describe("useFirstPaintReport", () => {
  it("counts a pane's first rows once", () => {
    const { rerender } = renderHook(({ rows }) => useFirstPaintReport("s1", "local", rows), { initialProps: { rows: false } });
    rerender({ rows: true });
    rerender({ rows: true });
    expect(firstPaintHistogram.flush()).toMatch(/^first-paint-hist n=1 /);
  });

  it("a draft that becomes a thread in its pane is not an open: its first rows are his own words", () => {
    const { rerender } = renderHook(({ armed, rows }) => useFirstPaintReport("s1", "local", rows, armed), {
      initialProps: { armed: false, rows: false },
    });
    rerender({ armed: true, rows: false });
    rerender({ armed: true, rows: true });
    expect(firstPaintHistogram.flush()).toBeNull();
  });
});
