// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canvasItem, fakeHost } from "./testkit";

/**
 * A thread's canvas on screen after its link comes back (perf M10): asked once, at the front of the host's reopen
 * lane, and an item opened while the socket was cut shows.
 */

const host = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./testkit").fakeHost> | null, pushes: new Set<(push: never) => void>(), opens: new Set<() => void>() }));
vi.mock("../../lib/connection", () => {
  const link = {
    environmentId: "local",
    request: (method: string, params?: Record<string, unknown>) => host.current!.link.request(method, params),
    onPush: (listener: (push: never) => void) => (host.pushes.add(listener), () => host.pushes.delete(listener)),
    onOpen: (listener: () => void) => (host.opens.add(listener), () => host.opens.delete(listener)),
  };
  return { registry: { linkOf: () => link, onLink: (listener: (l: typeof link, event: string) => void) => (listener(link, "added"), () => undefined) } };
});

import { resetCanvasStore, useCanvas } from "./store";

beforeEach(() => {
  resetCanvasStore();
});

describe("a thread's canvas after a reconnect", () => {
  it("is asked once, and shows an item opened while the socket was cut", async () => {
    host.current = fakeHost([canvasItem("a")], host as never);
    const view = renderHook(() => useCanvas("local", "t1"));
    await waitFor(() => expect(view.result.current.items.map((i) => i.id)).toEqual(["a"]));
    // Opened on another computer while this window's socket was down: no push reached it.
    await host.current.link.request("work.canvas.open", { sessionId: "t1", kind: "pdf", source: { at: "thread" }, title: "Contract" });
    const lists = () => host.current!.calls.filter((c) => c.method === "work.canvas.list").length;
    const before = lists();
    host.current.reopen();
    await waitFor(() => expect(view.result.current.items).toHaveLength(2));
    expect(lists()).toBe(before + 1);
    view.unmount();
  });
});
