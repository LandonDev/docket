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
const { openWorkView, workViewNow } = await import("../../lib/workSwitch");
const { projectStore } = await import("../../stores/project");

beforeEach(() => openWorkView(null));
afterEach(() => {
  cleanup();
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
