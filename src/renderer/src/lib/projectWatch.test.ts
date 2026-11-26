import { beforeEach, describe, expect, it, vi } from "vitest";

const { openListeners, pushListeners, request } = vi.hoisted(() => ({
  openListeners: [] as (() => void)[],
  pushListeners: [] as ((push: unknown) => void)[],
  request: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("./connection", () => {
  const link = {
    environmentId: "local",
    profile: "local" as const,
    onClose: () => () => {},
    connected: true,
    request,
    onOpen: (l: () => void) => {
      openListeners.push(l);
      return () => {};
    },
    onPush: (l: (push: unknown) => void) => {
      pushListeners.push(l);
      return () => {};
    },
  };
  return { registry: {
    link: () => link,
    linkOf: () => link,
    onLink: (listener: (link: unknown, event: string) => void) => { listener(link, "added"); return () => {}; },
  } };
});

vi.mock("./tcserver/workspaces", () => ({
  workspaceStore: {
    projects: [{ id: "p1", environmentId: "local", cwd: "/w/one" }],
    project: (id: string) => id === "p1" ? { id, environmentId: "local", cwd: "/w/one" } : undefined,
    subscribe: () => () => {},
    getSnapshot: () => ({ loaded: true }),
  },
}));

vi.mock("./tcserver/projects", () => ({
  projectForCwd: (cwd: string) => (cwd === "/w/one" ? { id: "p1", cwd } : null),
  dirPrefix: (cwd: string) => `${cwd}/`,
}));

import { LINGER_MS, onFileEvent, watchCwd, watchProject, watchedProjectIds, type FileEvent } from "./projectWatch";

beforeEach(() => request.mockClear());

describe("projectWatch", () => {
  it("holds one server subscription per project across holders", () => {
    const a = watchProject("p1");
    const b = watchProject("p1");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("fs.watch", { projectId: "p1", subscribe: true });
    vi.useFakeTimers();
    a();
    expect(request).toHaveBeenCalledTimes(1);
    b();
    expect(watchedProjectIds()).toEqual([]);
    // The unsubscribe waits out the linger.
    expect(request).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(LINGER_MS);
    expect(request).toHaveBeenLastCalledWith("fs.watch", { projectId: "p1", subscribe: false });
    vi.useRealTimers();
  });

  it("A, B, A inside the linger subscribes A once", () => {
    vi.useFakeTimers();
    const subscribes = () => request.mock.calls.filter((c) => (c as unknown[])[0] === "fs.watch" && ((c as unknown[])[1] as { subscribe: boolean }).subscribe).length;
    let a = watchCwd("/w/one");
    a(); // the rail's hold moves to B
    vi.advanceTimersByTime(LINGER_MS - 1);
    a = watchCwd("/w/one"); // and back to A
    expect(subscribes()).toBe(1);
    expect(request).toHaveBeenCalledTimes(1);
    // The old linger's timer is gone: A stays watched.
    vi.advanceTimersByTime(LINGER_MS * 2);
    expect(request).toHaveBeenCalledTimes(1);
    a();
    vi.advanceTimersByTime(LINGER_MS);
    expect(request).toHaveBeenLastCalledWith("fs.watch", { projectId: "p1", subscribe: false });
    vi.useRealTimers();
  });

  it("resubscribes every held project when the socket reopens", () => {
    vi.useFakeTimers();
    const release = watchProject("p1");
    request.mockClear();
    for (const l of openListeners) l();
    expect(request).toHaveBeenCalledWith("fs.watch", { projectId: "p1", subscribe: true });
    release();
    vi.advanceTimersByTime(LINGER_MS);
    vi.useRealTimers();
  });

  it("resolves a cwd to its project and fans events out as absolute paths", () => {
    const release = watchCwd("/w/one");
    expect(request).toHaveBeenCalledWith("fs.watch", { projectId: "p1", subscribe: true });
    const seen: FileEvent[] = [];
    const off = onFileEvent((e) => seen.push(e));
    for (const l of pushListeners) l({ push: "file-event", projectId: "p1", path: "src/a.ts", kind: "changed" });
    for (const l of pushListeners) l({ push: "file-event", projectId: "nope", path: "x", kind: "changed" });
    expect(seen).toEqual([{ projectId: "p1", path: "/w/one/src/a.ts", relative: "src/a.ts", kind: "changed" }]);
    off();
    release();
    expect(watchCwd("/elsewhere")).toBeTypeOf("function");
  });
});
