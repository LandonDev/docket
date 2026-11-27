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

const refusing: Saved = { ...saved, run: async (change) => saved.run(async () => {
  await change();
  throw new Error("refused");
}) };

describe("useDraft", () => {
  it("refuses a second change while one is out, and keeps the pending pick on screen", async () => {
    let answerFirst!: () => void;
    const { result } = renderHook(({ confirmed }) => useDraft(confirmed), { initialProps: { confirmed: { access: "full", effort: "medium" } } });
    await act(async () => {
      void result.current.change(saved, { access: "edits", effort: "medium" }, () => new Promise<void>((resolve) => (answerFirst = resolve)));
    });
    expect(result.current.busy).toBe(true);
    let second: boolean | undefined;
    await act(async () => {
      second = await result.current.change(saved, { access: "edits", effort: "high" }, () => undefined);
    });
    expect(second).toBe(false);
    expect(result.current.value).toEqual({ access: "edits", effort: "medium" });
    await act(async () => answerFirst());
    expect(result.current.busy).toBe(false);
  });

  it("puts a refused change back to the set the last good save sent, not the first read's", async () => {
    // A store that does not echo a save (Reviews): `confirmed` stays the first read's.
    const { result } = renderHook(() => useDraft({ effort: "medium", stop: "confirmed" }));
    await act(async () => {
      await result.current.change(saved, { effort: "high", stop: "confirmed" }, () => undefined);
    });
    await act(async () => {
      await result.current.change(refusing, { effort: "high", stop: "any" }, () => undefined);
    });
    expect(result.current.value).toEqual({ effort: "high", stop: "confirmed" });
  });

  it("shows a newer confirmed set once the change out answers", async () => {
    let answer!: () => void;
    const { result, rerender } = renderHook(({ confirmed }) => useDraft(confirmed), { initialProps: { confirmed: { access: "full", effort: "medium" } } });
    await act(async () => {
      void result.current.change(saved, { access: "edits", effort: "medium" }, () => new Promise<void>((resolve) => (answer = resolve)));
    });
    // Another window's set lands while the change is out: the pick stays shown.
    rerender({ confirmed: { access: "edits", effort: "high" } });
    expect(result.current.value).toEqual({ access: "edits", effort: "medium" });
    await act(async () => answer());
    expect(result.current.value).toEqual({ access: "edits", effort: "high" });
  });
});
