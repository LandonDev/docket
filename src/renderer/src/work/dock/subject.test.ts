// @vitest-environment jsdom
/**
 * The shared dock (work/dock): one chat a subject's key, a `send` subject's chips carried by the first send and never
 * shown in the composer, and a must step that stops the first send when it fails and runs again before the next.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextChip } from "@shared/work";

const created = vi.hoisted(() => [] as string[]);
vi.mock("../../lib/connection", async (original) => {
  const linkOf = (id: string) => ({
    environmentId: id,
    connected: true,
    request: async (method: string, params: { id?: string }) => {
      if (method === "session.create") {
        created.push(params.id!);
        return { id: params.id, provider: "claude", model: "m", status: "idle", title: "", cwd: "/w", createdAt: 0, updatedAt: 0, workspaceId: "w1" };
      }
      return {};
    },
    onPush: () => () => undefined,
  });
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf, link: linkOf, has: () => true, environments: () => [], onLink: () => () => undefined } };
});

const { dockThread, enterDock, leaveDock, rebindDock, resetDocks } = await import("./dockThread");
const { contextChipsOf, resetContextChips, takeContextChips } = await import("../canvas/chips");
const { sessionStore } = await import("../../lib/tcserver/store");
const { newSession } = await import("../../lib/session");
const { workDockPort } = await import("../../lib/workSwitch");
const { dockDraftKey, projectDrafts } = await import("../../lib/projectDrafts");
const { afterCreate, ensureCreated } = await import("../../lib/tcserver/commands");
const { workspaceStore } = await import("../../lib/tcserver/workspaces");
import type { DockSubject } from "./subject";

const workspace = { id: "w1", environmentId: "box", path: "/w" };
const mail: ContextChip = { kind: "mail", label: "Lunch on Friday", ref: { at: "lifeos", table: "mailThreads", id: "mt1" } } as ContextChip;
const subject = (over: Partial<DockSubject> = {}): DockSubject => ({ key: "mail/w1/mt1", title: "Lunch on Friday", chips: [mail], chipIn: "send", find: async () => null, ...over });

beforeEach(() => {
  localStorage.clear();
  projectDrafts.reload();
  sessionStore.reset();
  resetContextChips();
  resetDocks();
  created.length = 0;
  // The workspace's host, as the catalog names it: a draft's create goes there (lib/tcserver/draftHost.ts).
  workspaceStore.hydrate([{ environmentId: "box", workspaces: [{ id: "w1", path: "/w" }], projects: [] }]);
  workDockPort.set({
    draft: (_ws, id) => ({ ...newSession("box", "claude", "/w", undefined, undefined, { projectId: null, workspaceId: "w1" }), ...(id ? { id } : {}) }),
    openFile: () => undefined,
    openDiff: () => undefined,
  });
});
afterEach(() => workDockPort.set(null));

describe("one chat a subject", () => {
  it("shows the same draft for the same key and a new one for another", async () => {
    const a = await dockThread(workspace, subject());
    const again = await dockThread(workspace, subject());
    const b = await dockThread(workspace, subject({ key: "mail/w1/mt2" }));
    expect(a.draft).toBe(true);
    expect(again.id).toBe(a.id);
    expect(b.id).not.toBe(a.id);
  });

  it("shows the subject's thread from before when there is one", async () => {
    expect(await dockThread(workspace, subject({ find: async () => "s-old" }))).toEqual({ id: "s-old", draft: false });
  });
});

describe("a dock's draft over a quit and a launch", () => {
  /** What a quit and a launch leave: localStorage alone. */
  const relaunch = (): void => {
    projectDrafts.flush();
    resetDocks();
    sessionStore.reset();
    projectDrafts.reload();
  };
  const file = (over: Partial<DockSubject> = {}): DockSubject => subject({ key: "w1/tab1", chipIn: "composer", chips: [], ...over });

  it("comes back with its id and the words he typed, under the subject's own record", async () => {
    const before = await dockThread(workspace, file());
    // What the composer writes as he types (Composer.tsx `saveProjectDraft`): the record that holds its id.
    expect(projectDrafts.keyOfDraft(before.id)).toBe(dockDraftKey("w1/tab1"));
    projectDrafts.put(projectDrafts.keyOfDraft(before.id)!, { segments: [{ text: "Ask about the practice notes" }] });
    relaunch();
    const after = await dockThread(workspace, file());
    expect(after).toEqual({ id: before.id, draft: true });
    expect(sessionStore.get(after.id)?.workspaceId).toBe("w1");
    expect(projectDrafts.get(dockDraftKey("w1/tab1"))!.segments).toEqual([{ text: "Ask about the practice notes" }]);
  });

  it("never takes the workspace's New thread draft, nor gives it its words", async () => {
    projectDrafts.put("loose:w1", { ...newSession("box", "claude", "/w", undefined, undefined, { projectId: null, workspaceId: "w1" }), environmentId: "box", projectId: null, workspaceId: "w1", id: "ws-draft", threadType: "chat", threadRules: null, modelSettings: {}, segments: [{ text: "a new thread" }], attachments: [] });
    const docked = await dockThread(workspace, file());
    projectDrafts.put(projectDrafts.keyOfDraft(docked.id)!, { segments: [{ text: "about this file" }] });
    relaunch();
    const again = await dockThread(workspace, file());
    expect(again.id).not.toBe("ws-draft");
    expect(projectDrafts.get("loose:w1")!.segments).toEqual([{ text: "a new thread" }]);
    expect(projectDrafts.get(dockDraftKey("w1/tab1"))!.segments).toEqual([{ text: "about this file" }]);
  });

  it("is a new draft once the one from before became a thread", async () => {
    const before = await dockThread(workspace, file());
    projectDrafts.put(projectDrafts.keyOfDraft(before.id)!, { segments: [{ text: "sent already" }] });
    relaunch();
    const meta = vi.spyOn(sessionStore, "metaOf").mockImplementation(((id: string) => (id === before.id ? { id } : null)) as never);
    try {
      const after = await dockThread(workspace, file());
      expect(after.id).not.toBe(before.id);
      expect(projectDrafts.get(dockDraftKey("w1/tab1"))!.segments).toEqual([]);
    } finally {
      meta.mockRestore();
    }
  });
});

describe("a docked chat stays open", () => {
  it("a draft the dock shows is held as shown (the idle sweep and the unload leave it), and let go when the dock closes", async () => {
    const a = await dockThread(workspace, subject());
    enterDock(a.id);
    expect(sessionStore.shownApart().has(a.id)).toBe(true);
    expect(sessionStore.isOpen(a.id)).toBe(true);
    leaveDock(a.id);
    expect(sessionStore.shownApart().has(a.id)).toBe(false);
    expect(sessionStore.isOpen(a.id)).toBe(false);
  });

  it("a thread the dock shows is opened, so a send into it has a session", async () => {
    const thread = { ...newSession("box", "claude", "/w", undefined, undefined, { projectId: null, workspaceId: "w1" }), id: "t-before" };
    sessionStore.mutate([thread]);
    sessionStore.mutate([]);
    expect(sessionStore.isOpen("t-before")).toBe(false);
    const a = await dockThread(workspace, subject({ find: async () => "t-before" }));
    enterDock(a.id);
    expect(a).toEqual({ id: "t-before", draft: false });
    expect(sessionStore.isOpen("t-before")).toBe(true);
    expect(sessionStore.shownApart().has("t-before")).toBe(true);
  });
});

describe("a send subject's chips", () => {
  it("sit in no composer, and the first send carries them as what the thread is about", async () => {
    const { id } = await dockThread(workspace, subject());
    enterDock(id);
    expect(contextChipsOf(id)).toEqual([]);
    const sent = takeContextChips(id, true);
    expect(sent).toEqual([mail]);
    // Only the first send carries them.
    expect(takeContextChips(id, false)).toEqual([]);
  });

  it("go when the dock lets go of a draft he sent nothing in", async () => {
    const { id } = await dockThread(workspace, subject());
    enterDock(id);
    leaveDock(id);
    expect(takeContextChips(id, true)).toEqual([]);
  });

  it("a composer subject's chips sit in its composer", async () => {
    const { id } = await dockThread(workspace, subject({ chipIn: "composer" }));
    enterDock(id);
    expect(contextChipsOf(id)).toEqual([mail]);
  });
});

describe("a must step", () => {
  it("stops the first send when it fails, stays, and runs again before the next", async () => {
    let fail = true;
    const holds: string[] = [];
    const { id } = await dockThread(workspace, subject({ mustHold: true, hold: async (sessionId) => {
      holds.push(sessionId);
      if (fail) throw new Error("adopt refused");
    } }));
    enterDock(id);
    const draft = sessionStore.get(id)!;
    await expect(ensureCreated(draft)).rejects.toThrow("The chat did not start");
    expect(created).toEqual([id]);
    expect(afterCreate.pending(id)).toBe(true);
    fail = false;
    await ensureCreated(sessionStore.get(id) ?? draft);
    // Made once; the step ran twice and is done.
    expect(created).toEqual([id]);
    expect(holds).toEqual([id, id]);
    expect(afterCreate.pending(id)).toBe(false);
  });

  it("a step that is not a must still lets the message go when it fails", async () => {
    const { id } = await dockThread(workspace, subject({ hold: async () => {
      throw new Error("no");
    } }));
    enterDock(id);
    await expect(ensureCreated(sessionStore.get(id)!)).resolves.toBeTruthy();
    expect(afterCreate.pending(id)).toBe(false);
  });
});

describe("a subject that comes to name another file under its key (Keep Both)", () => {
  const chipOf = (path: string): ContextChip => ({ kind: "file", label: path.slice(3), ref: { at: "file", host: "box", path } }) as ContextChip;
  const tabAbout = (path: string, holds: string[]): DockSubject =>
    subject({ key: "w1/tab1", chipIn: "composer", chips: [chipOf(path)], hold: async () => void holds.push(path) });

  it("keeps his words and other chips, swaps the file's chip where it sits, and the first send opens the new file", async () => {
    const holds: string[] = [];
    const { id } = await dockThread(workspace, tabAbout("/w/Notes.md", holds));
    enterDock(id);
    projectDrafts.put(projectDrafts.keyOfDraft(id)!, { segments: [{ text: "Tidy the second list" }] });
    const other = { kind: "file", label: "Budget.xlsx", ref: { at: "file", host: "box", path: "/w/Budget.xlsx" } } as ContextChip;
    const { addContextChip } = await import("../canvas/chips");
    addContextChip(id, other);
    rebindDock(tabAbout("/w/Notes (mine).md", holds));
    expect(contextChipsOf(id)).toEqual([chipOf("/w/Notes (mine).md"), other]);
    expect(projectDrafts.get(dockDraftKey("w1/tab1"))!.segments).toEqual([{ text: "Tidy the second list" }]);
    await ensureCreated(sessionStore.get(id)!);
    expect(holds).toEqual(["/w/Notes (mine).md"]);
  });

  it("leaves off a file chip he took off", async () => {
    const holds: string[] = [];
    const { id } = await dockThread(workspace, tabAbout("/w/Notes.md", holds));
    enterDock(id);
    const { removeContextChip } = await import("../canvas/chips");
    removeContextChip(id, 0);
    rebindDock(tabAbout("/w/Notes (mine).md", holds));
    expect(contextChipsOf(id)).toEqual([]);
    await ensureCreated(sessionStore.get(id)!);
    expect(holds).toEqual([]);
  });
});
