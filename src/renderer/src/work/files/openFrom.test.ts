import { afterEach, describe, expect, it, vi } from "vitest";

const opened = vi.hoisted(() => ({ calls: [] as unknown[][], pages: [] as unknown[][], fail: null as Error | null, slow: null as (() => void) | null }));
vi.mock("./store", () => ({
  openFileTab: async (...args: unknown[]) => {
    opened.calls.push(args);
    // What he does while a slow host makes the tab.
    opened.slow?.();
    if (opened.fail) throw opened.fail;
    return { rev: 1, tabs: [], tabId: "t1" };
  },
  openPageTab: async (...args: unknown[]) => {
    opened.pages.push(args);
    if (opened.fail) throw opened.fail;
  },
}));
const toasts = vi.hoisted(() => [] as string[]);
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => ({ error: (title: string) => void toasts.push(title) }) }));
vi.mock("../../lib/tcserver/workspaces", () => ({ workspaceStore: { getSnapshot: () => ({ workspaces: [{ id: "w1", environmentId: "box" }] }) } }));

const { filesOfDocs, LIFEOS_PAGE, openDocInFiles, openInFiles } = await import("./openFrom");
const { openWorkView, workViewNow } = await import("../../lib/workSwitch");

afterEach(() => {
  opened.calls.length = 0;
  opened.pages.length = 0;
  toasts.length = 0;
  opened.fail = null;
  opened.slow = null;
  openWorkView(null);
});

describe("opening a file from another screen", () => {
  const workspace = { id: "w1", environmentId: "box" };
  const ref = { at: "file" as const, host: "env_box", path: "/w/Budget.xlsx" };

  it("opens it in a Files tab on the workspace's host, then shows the Files place: no thread is made", async () => {
    await openInFiles(workspace, { ref, name: "Budget.xlsx" });
    expect(opened.calls).toEqual([["box", "w1", { ref, name: "Budget.xlsx" }]]);
    expect(workViewNow()).toEqual({ workspaceId: "w1", view: "files" });
  });

  it("leaves the window where he went while a slow host made the tab: a mail opened meanwhile is not covered by Files", async () => {
    opened.slow = () => openWorkView({ workspaceId: "w1", view: "mail", mail: "m1" });
    await openInFiles(workspace, { ref, name: "Budget.xlsx" });
    expect(opened.calls).toHaveLength(1);
    expect(workViewNow()).toEqual({ workspaceId: "w1", view: "mail", mail: "m1" });
  });

  it("leaves him on a thread he went back to from this workspace's view; a view of another workspace that the move cleared is no move of his", async () => {
    openWorkView({ workspaceId: "w1", view: "tasks" });
    opened.slow = () => openWorkView(null);
    await openInFiles(workspace, { ref, name: "Budget.xlsx" });
    expect(workViewNow()).toBeNull();

    openWorkView({ workspaceId: "other", view: "tasks" });
    await openInFiles(workspace, { ref, name: "Budget.xlsx" });
    expect(workViewNow()).toEqual({ workspaceId: "w1", view: "files" });

    // the view he was on, still open: Files shows
    openWorkView({ workspaceId: "w1", view: "tasks" });
    opened.slow = null;
    await openInFiles(workspace, { ref, name: "Budget.xlsx" });
    expect(workViewNow()).toEqual({ workspaceId: "w1", view: "files" });
  });

  it("leaves the screen he is on when the host refuses, and throws the host's own sentence", async () => {
    opened.fail = new Error("32 files are open. Close one to open another.");
    await expect(openInFiles(workspace, { ref, name: "Budget.xlsx" })).rejects.toThrow("32 files are open");
    expect(workViewNow()).toBeNull();
  });

  it("stands a new tab on a page it is given, then shows the Files place", async () => {
    await openInFiles(workspace, { page: LIFEOS_PAGE });
    expect(opened.pages).toEqual([["box", "w1", { at: { at: "place", id: "lifeos" }, name: "LifeOS" }]]);
    expect(workViewNow()).toEqual({ workspaceId: "w1", view: "files" });
  });
});

describe("a way into the Docs view, which folded into Files", () => {
  it("opens a LifeOS document in a tab of its own, and stands on the LifeOS place when no document is named", () => {
    expect(filesOfDocs({ id: "d1", title: "Run of show" })).toEqual({ ref: { at: "lifeos", table: "docs", id: "d1" }, name: "Run of show" });
    expect(filesOfDocs({ id: "d1" })).toEqual({ ref: { at: "lifeos", table: "docs", id: "d1" }, name: "Untitled" });
    expect(filesOfDocs()).toEqual({ page: LIFEOS_PAGE });
  });

  it("from a screen that holds only the workspace's id, reads the workspace from the window, and says a refusal once", async () => {
    await openDocInFiles("w1", { id: "d1", title: "Plan" });
    expect(opened.calls).toEqual([["box", "w1", { ref: { at: "lifeos", table: "docs", id: "d1" }, name: "Plan" }]]);
    opened.fail = new Error("That is not in LifeOS any more.");
    await openDocInFiles("w1", { id: "d2" });
    await openDocInFiles("gone", { id: "d3" });
    await new Promise((done) => setTimeout(done, 0));
    expect(toasts).toEqual(["It did not open", "It did not open"]);
  });
});
