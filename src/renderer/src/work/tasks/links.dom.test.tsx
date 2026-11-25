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

const toasts = vi.hoisted(() => [] as { words: string; options?: { action?: { label: string; onClick: () => void } } }[]);
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => ({ error: (words: string, options?: never) => void toasts.push({ words, options }) }) }));
const { openTaskThread, useLiveLink } = await import("./links");
const { sessionStore } = await import("../../lib/tcserver/store");

describe("a link whose thread was deleted", () => {
  it("is no link once every host answered without the thread, so the task offers Start", async () => {
    const ensure = vi.spyOn(sessionStore, "ensureMeta").mockResolvedValue(null);
    const listed = vi.spyOn(sessionStore, "everyHostListed").mockReturnValue(true);
    const { result } = renderHook(() => useLiveLink("gone"));
    expect(result.current).toBe("gone");
    await act(async () => {});
    expect(result.current).toBeNull();
    ensure.mockRestore();
    listed.mockRestore();
  });

  it("stays a link while a host could not answer, never Start; Open then says so with Start thread on the toast", async () => {
    const ensure = vi.spyOn(sessionStore, "ensureMeta").mockResolvedValue(null);
    const listed = vi.spyOn(sessionStore, "everyHostListed").mockReturnValue(false);
    const { result } = renderHook(() => useLiveLink("away"));
    await act(async () => {});
    expect(result.current).toBe("away");
    const start = vi.fn();
    await openTaskThread("away", start);
    await act(async () => {});
    expect(toasts.at(-1)?.words).toBe("Couldn't find the thread");
    expect(toasts.at(-1)?.options?.action?.label).toBe("Start thread");
    toasts.at(-1)?.options?.action?.onClick();
    expect(start).toHaveBeenCalledOnce();
    ensure.mockRestore();
    listed.mockRestore();
  });
});
