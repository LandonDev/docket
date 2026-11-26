// @vitest-environment jsdom
/**
 * Council round 1, sitting B (R1-B7): with the box's link cut, the list and an open conversation keep what they last
 * read under the frame's line, never "Messages did not load" with a Retry that can only fail. On an open link a
 * failed read is said as before.
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const live = vi.hoisted(() => ({ answer: { status: "loading" } as unknown, down: null as string | null }));
vi.mock("../shell/lifeos", async (original) => ({ ...(await original<object>()), useLifeosQuery: () => live.answer }));
vi.mock("../shell/hostLinkDown", async (original) => ({ ...(await original<object>()), useHostLinkDown: () => live.down }));

const { liveData } = await import("./live");
const data = liveData({ environmentId: "box", sector: "cosmic", client: null, state: "connected" } as never, "cosmic", "box", "ws");
const rows = [{ _id: "c1", name: "Dana Lee" }];
const failed = { status: "failed", error: "LifeOS did not answer" };

describe("a failed read", () => {
  it("keeps the list's rows while the link is down, and fails as before once it is open", () => {
    live.answer = { status: "ready", value: { page: rows, isDone: true, continueCursor: "" } };
    const list = renderHook(() => data.useChats("all"));
    expect(list.result.current).toMatchObject({ status: "ready", value: { rows } });
    live.answer = failed;
    live.down = "The box is not connected";
    list.rerender();
    expect(list.result.current).toMatchObject({ status: "ready", value: { rows } });
    live.down = null;
    list.rerender();
    expect(list.result.current).toEqual(failed);
  });

  it("keeps an open conversation while the link is down", () => {
    const chat = { _id: "c1", name: "Dana Lee" };
    live.answer = { status: "ready", value: chat };
    live.down = null;
    const open = renderHook(() => data.useChat("c1"));
    live.answer = failed;
    live.down = "The box is not connected";
    open.rerender();
    expect(open.result.current).toEqual({ status: "ready", value: chat });
    live.down = null;
    open.rerender();
    expect(open.result.current).toEqual(failed);
  });
});
