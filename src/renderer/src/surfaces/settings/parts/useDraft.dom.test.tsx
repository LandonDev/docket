import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDraft } from "./useDraft";
import type { Saved } from "./useSaved";

/** A `Saved` that runs the change and says whether it landed, as `useSaved` does. */
const saved: Saved = {
  state: "idle",
  error: null,
  run: async (change) => {
    try {
      await change();
      return true;
    } catch {
      return false;
    }
  },
};

describe("useDraft", () => {
  it("keeps a second pick on screen when the first save's answer lands while the second is still out", async () => {
    let answerFirst!: () => void;
    let answerSecond!: () => void;
    const { result, rerender } = renderHook(({ confirmed }) => useDraft(confirmed), { initialProps: { confirmed: { access: "full", effort: "medium" } } });
    await act(async () => {
      void result.current.change(saved, { access: "edits", effort: "medium" }, () => new Promise<void>((resolve) => (answerFirst = resolve)));
    });
    await act(async () => {
      void result.current.change(saved, { access: "edits", effort: "high" }, () => new Promise<void>((resolve) => (answerSecond = resolve)));
    });
    // The first save answers and the store holds its set: the second pick still shows.
    rerender({ confirmed: { access: "edits", effort: "medium" } });
    await act(async () => answerFirst());
    expect(result.current.value).toEqual({ access: "edits", effort: "high" });
    // The second answers: what the computer confirmed shows.
    rerender({ confirmed: { access: "edits", effort: "high" } });
    await act(async () => answerSecond());
    expect(result.current.value).toEqual({ access: "edits", effort: "high" });
  });
});
