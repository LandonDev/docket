import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leafIds, newTab } from "./layout";
import { docketOpen, setDocketOpen } from "./docketOpen";
import { newSession } from "./session";
import { initialWorkspaceTabsState, workspaceTabsStore } from "../stores/workspace";
import { workspaceActions } from "../stores/workspaceActions";

// App's handlers as they act on the tabs store: a tab per open, a pane per split.
const open = vi.fn(async (id: string) => {
  const tab = newTab(id);
  workspaceActions.appendTab(tab);
  workspaceActions.activateTab(tab.id);
});
const ensure = vi.fn(async (id: string) => (id === "gone" ? null : { ...newSession("/repo"), id }));
const beside = vi.fn((sourceId: string, session: { id: string }) => {
  workspaceActions.splitBeside(sourceId, session.id);
});

const activeLeaves = (): string[] => {
  const { tabs, activeTabId } = workspaceTabsStore.getState();
  const tab = tabs.find((entry) => entry.id === activeTabId);
  return tab ? leafIds(tab.layout) : [];
};

describe("window.__docket.open", () => {
  beforeEach(() => {
    workspaceTabsStore.setState(initialWorkspaceTabsState());
    setDocketOpen({ open, ensure, beside });
  });
  afterEach(() => {
    setDocketOpen(null);
    vi.clearAllMocks();
  });

  it("opens a thread in a tab through App's open handler", async () => {
    await docketOpen("master");
    expect(open).toHaveBeenCalledWith("master");
    expect(activeLeaves()).toEqual(["master"]);
  });

  it("opens a thread beside the focused pane with split", async () => {
    await docketOpen("master");
    await docketOpen("child", { split: true });
    expect(beside).toHaveBeenCalledWith("master", expect.objectContaining({ id: "child" }));
    expect(activeLeaves()).toEqual(["master", "child"]);
    expect(workspaceTabsStore.getState().tabs).toHaveLength(1);
  });

  it("opens a tab when there is no pane to split", async () => {
    await docketOpen("child", { split: true });
    expect(beside).not.toHaveBeenCalled();
    expect(activeLeaves()).toEqual(["child"]);
  });

  it("refuses before the app mounts and for a thread no host knows", async () => {
    await docketOpen("master");
    await expect(docketOpen("gone", { split: true })).rejects.toThrow("no thread gone");
    setDocketOpen(null);
    await expect(docketOpen("master")).rejects.toThrow("has not mounted");
  });
});
