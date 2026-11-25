// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/** A task's link read: not answered yet (or failed) is kept apart from no thread, so Tasks offers no early Start. */

const live = vi.hoisted(() => ({ result: undefined as unknown, fail: false, update: null as null | (() => void) }));
vi.mock("convex/react", async (original) => ({
  ...(await original<object>()),
  useConvex: () => ({
    watchQuery: () => ({
      localQueryResult: () => {
        if (live.fail) throw new Error("LifeOS refused the read");
        return live.result;
      },
      onUpdate: (l: () => void) => ((live.update = l), () => (live.update = null)),
    }),
  }),
}));
const { useLinkedThread } = await import("./links");

describe("useLinkedThread", () => {
  it("is undefined until the read answers and when it fails, null for no open link, the thread for one", () => {
    const { result } = renderHook(() => useLinkedThread("t1"));
    expect(result.current).toBeUndefined();
    act(() => {
      live.result = [];
      live.update?.();
    });
    expect(result.current).toBeNull();
    act(() => {
      live.result = [{ threadId: "th1", state: "open", at: 1 }];
      live.update?.();
    });
    expect(result.current).toBe("th1");
    act(() => {
      live.fail = true;
      live.update?.();
    });
    expect(result.current).toBeUndefined();
  });
});
