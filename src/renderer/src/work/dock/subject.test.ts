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

const { dockThread, enterDock, leaveDock, resetDocks } = await import("./dockThread");
const { contextChipsOf, resetContextChips, takeContextChips } = await import("../canvas/chips");
const { sessionStore } = await import("../../lib/tcserver/store");
const { newSession } = await import("../../lib/session");
const { workDockPort } = await import("../../lib/workSwitch");
const { afterCreate, ensureCreated } = await import("../../lib/tcserver/commands");
import type { DockSubject } from "./subject";

const workspace = { id: "w1", environmentId: "box", path: "/w" };
const mail: ContextChip = { kind: "mail", label: "Lunch on Friday", ref: { at: "lifeos", table: "mailThreads", id: "mt1" } } as ContextChip;
const subject = (over: Partial<DockSubject> = {}): DockSubject => ({ key: "mail/w1/mt1", title: "Lunch on Friday", chips: [mail], chipIn: "send", find: async () => null, ...over });

beforeEach(() => {
  sessionStore.reset();
  resetContextChips();
  resetDocks();
  created.length = 0;
  workDockPort.set({
    draft: (_ws, id) => ({ ...newSession("box", "claude", "/w", undefined, undefined, undefined, { projectId: null, workspaceId: "w1" }), ...(id ? { id } : {}) }),
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
