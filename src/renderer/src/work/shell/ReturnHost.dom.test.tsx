/**
 * The window's half of "where he was": a launch that comes back on a Work workspace opens the view its record names,
 * and every move after writes the record (lib/workReturn.ts).
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const catalog = vi.hoisted(() => ({
  loaded: true,
  workspaces: [
    { id: "ws", name: "Purdue", path: "/w/purdue", kind: "work", sector: "purdue", git: false, createdAt: 1, environmentId: "env_box" },
    { id: "code", name: "site", path: "/r/site", git: true, createdAt: 1, environmentId: "env_box" },
  ],
  projects: [],
}));
vi.mock("../../lib/tcserver/workspaces", async (original) => ({
  ...(await original<object>()),
  useWorkspaceCatalog: () => catalog,
}));

const { ReturnHost } = await import("./ReturnHost");
const { forgetReturnWindow, keepReturn, returnOf } = await import("./returnRecord");
const { openWorkView, workSwitch, workViewNow } = await import("../../lib/workSwitch");
const { registry } = await import("../../lib/connection");
const { WORK_VIEWS } = await import("../views/registry");
const { resetLifeos } = await import("./lifeos");
const { projectStore } = await import("../../stores/project");

beforeEach(() => openWorkView(null));
afterEach(() => {
  cleanup();
  resetLifeos();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  forgetReturnWindow(true);
});

describe("a launch that comes back on a Work workspace", () => {
  it("opens the view he left it on, a meeting's page with its event", () => {
    keepReturn("ws", { view: "prep", event: "e1" });
    projectStore.setState({ projectCwd: "/w/purdue" });
    render(<ReturnHost />);
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "prep", event: "e1" });
  });

  it("opens nothing for a workspace he left on a thread, or for a code workspace", () => {
    keepReturn("ws", { view: null });
    projectStore.setState({ projectCwd: "/w/purdue" });
    render(<ReturnHost />);
    expect(workViewNow()).toBeNull();
    cleanup();
    projectStore.setState({ projectCwd: "/r/site" });
    render(<ReturnHost />);
    expect(workViewNow()).toBeNull();
    expect(returnOf("code")).toEqual({});
  });
});

describe("a launch's first asks", () => {
  /** M1: the view's chunk and its LifeOS session start from the record, side by side, before the view mounts. */
  it("starts Mail's chunk and its session's JWT before the view opens, with no status ask in front of it", () => {
    const order: string[] = [];
    vi.spyOn(WORK_VIEWS.mail.chunk, "preload").mockImplementation(() => void order.push("preload"));
    vi.spyOn(registry, "has").mockReturnValue(true);
    vi.spyOn(registry, "linkOf").mockReturnValue({
      connected: true,
      request: (method: string) => (order.push(method), new Promise(() => {})),
      onPush: () => () => {},
      onOpen: () => () => {},
    } as never);
    const off = workSwitch.subscribe(() => workViewNow() && !order.includes("view") && order.push("view"));
    // The last launch's status said connected.
    localStorage.setItem("work.lifeos.connected.v1", JSON.stringify(["env_box"]));
    keepReturn("ws", { view: "mail", environmentId: "env_box", sector: "purdue" });
    projectStore.setState({ projectCwd: "/w/purdue" });
    render(<ReturnHost />);
    off();
    expect(order).toEqual(["preload", "work.lifeos.status", "work.lifeos.jwt", "view"]);
  });

  it("writes the workspace's host and sector into its record", () => {
    projectStore.setState({ projectCwd: "/w/purdue" });
    render(<ReturnHost />);
    act(() => openWorkView({ workspaceId: "ws", view: "tasks" }));
    expect(returnOf("ws")).toMatchObject({ view: "tasks", environmentId: "env_box", sector: "purdue" });
  });
});

describe("as he moves", () => {
  it("writes the view he opens and the thread he goes back to, never another workspace's view on its way", () => {
    projectStore.setState({ projectCwd: "/w/purdue" });
    render(<ReturnHost />);
    act(() => openWorkView({ workspaceId: "ws", view: "files" }));
    expect(returnOf("ws").view).toBe("files");
    act(() => openWorkView({ workspaceId: "elsewhere", view: "mail" }));
    expect(returnOf("ws").view).toBe("files");
    act(() => openWorkView(null));
    expect(returnOf("ws").view).toBeNull();
  });
});
