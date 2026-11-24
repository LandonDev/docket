// @vitest-environment jsdom
/**
 * Ask's first send in one trip (commands.ts `createDraft`, docs/agents/work-files.md "Ask"): from a file's dock or a
 * mail's, a host that names `create.steps` gets one request, `session.create`, carrying the message and the steps it
 * runs itself; an older host gets the create, the steps and the send, one after another, as before. Opening the dock
 * asks the host nothing, and the create carries no model or access of its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasItem } from "@shared/work";
import type { FileTab } from "@shared/contract-work-files";

const h = vi.hoisted(() => ({ asked: [] as { method: string; params: Record<string, unknown> }[], features: ["create.steps"] as string[] | undefined, failItems: false }));
vi.mock("../../lib/connection", async (original) => {
  const linkOf = (id: string) => ({
    environmentId: id,
    connected: true,
    request: async (method: string, params: Record<string, unknown>) => {
      h.asked.push({ method, params });
      if (method === "session.create") {
        return {
          id: params.id,
          provider: "claude",
          model: "m",
          status: "running",
          title: "",
          cwd: "/w",
          createdAt: 0,
          updatedAt: 0,
          workspaceId: "w1",
          ...(h.failItems && params.items ? { itemsFailed: [{ title: "Budget", error: "forbidden" }] } : {}),
        };
      }
      if (method === "session.events") return { rows: [], lastSeq: 0 };
      if (method === "work.canvas.open") return { id: "i1", kind: "sheet", source: params.source, title: params.title };
      return {};
    },
    onPush: () => () => undefined,
  });
  return {
    ...(await original<typeof import("../../lib/connection")>()),
    registry: { linkOf, link: linkOf, has: () => true, environments: () => [], onLink: () => () => undefined, statusOf: () => ({ transport: "open", lastHello: { features: h.features } }) },
  };
});
vi.mock("../../lib/macBridge", () => ({ bridgeFor: async () => null, bridgeNewThread: async () => undefined, bridgesNewThreads: async () => false }));
const toasts = vi.hoisted(() => [] as string[]);
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => ({ error: (title: string) => toasts.push(title) }) }));

const { dockThread, enterDock, resetDocks } = await import("./dockThread");
const { fileSubject } = await import("../files/dockThread");
const { mailDockSubject } = await import("../mail/chat/MailDock");
const { resetContextChips } = await import("../canvas/chips");
const { sessionStore } = await import("../../lib/tcserver/store");
const { newSession } = await import("../../lib/session");
const { workDockPort } = await import("../../lib/workSwitch");
const { projectDrafts } = await import("../../lib/projectDrafts");
const { send, afterCreate } = await import("../../lib/tcserver/commands");

const workspace = { id: "w1", environmentId: "box", path: "/w" };
const item = { id: "it1", kind: "sheet", source: { at: "file", host: "box", path: "/w/Budget.xlsx" }, title: "Budget" } as unknown as CanvasItem;
const tab = { id: "tab1", name: "Budget.xlsx" } as unknown as FileTab;
const methods = (): string[] => h.asked.map((a) => a.method);

beforeEach(() => {
  localStorage.clear();
  projectDrafts.reload();
  sessionStore.reset();
  resetContextChips();
  resetDocks();
  h.asked.length = 0;
  h.features = ["create.steps"];
  h.failItems = false;
  toasts.length = 0;
  vi.spyOn(sessionStore, "waitIdle").mockResolvedValue(undefined);
  workDockPort.set({
    draft: (_ws, id) => ({ ...newSession("box", "claude", "/w", undefined, undefined, { projectId: null, workspaceId: "w1" }), ...(id ? { id } : {}) }),
    openFile: () => undefined,
    openDiff: () => undefined,
  });
});
afterEach(() => {
  workDockPort.set(null);
  vi.restoreAllMocks();
});

async function fileDraft(over: Partial<FileTab> = {}): Promise<string> {
  const subject = { ...fileSubject(workspace, { ...tab, ...over }, item), find: async () => null };
  const { id } = await dockThread(workspace, subject);
  enterDock(id);
  return id;
}

describe("the first send from a file's dock", () => {
  it("opening the dock asks the host nothing: no thread exists before he sends", async () => {
    await fileDraft();
    expect(h.asked).toEqual([]);
  });

  it("makes exactly 1 request before the host has the turn: session.create with the message and the file to open", async () => {
    const id = await fileDraft();
    await send(sessionStore.get(id)!, "What changed in March?");
    const create = h.asked.findIndex((a) => a.method === "session.create");
    expect(create).toBe(0);
    // Anything after the create is the transcript's own load, once the host already has the turn.
    expect(methods().filter((m) => m !== "session.events")).toEqual(["session.create"]);
    const params = h.asked[0].params;
    expect(params).toMatchObject({ id, firstMessage: "What changed in March?", items: [{ kind: "sheet", source: item.source, title: "Budget" }] });
    // His Thread defaults decide on the host: the folded create names no model or access he did not pick.
    expect(params).not.toHaveProperty("provider");
    expect(params).not.toHaveProperty("model");
    expect(params).not.toHaveProperty("permission");
    expect(afterCreate.pending(id)).toBe(false);
    expect(sessionStore.metaOf(id)).toBeTruthy();
  });

  it("a file of another computer asks the host for a copy of the thread's own", async () => {
    const id = await fileDraft({ copyOf: { at: "file", host: "pc", path: "C:\\Budget.xlsx" } } as Partial<FileTab>);
    await send(sessionStore.get(id)!, "Sum the column");
    expect((h.asked[0].params.items as { copy?: boolean }[])[0].copy).toBe(true);
  });

  it("a file the host could not open says so, as the window's own open did", async () => {
    h.failItems = true;
    const id = await fileDraft();
    await send(sessionStore.get(id)!, "Hi");
    await vi.waitFor(() => expect(toasts).toEqual(["Budget.xlsx did not open in the chat"]));
  });

  it("an older host gets the create, the open and the send, one after another", async () => {
    h.features = undefined;
    const id = await fileDraft();
    await send(sessionStore.get(id)!, "What changed in March?");
    expect(methods().filter((m) => m !== "session.events")).toEqual(["session.create", "work.canvas.open", "session.send"]);
    expect(h.asked[0].params).not.toHaveProperty("firstMessage");
  });
});

describe("the first send from a mail's dock", () => {
  it("carries the adopt: the host makes it a mail chat before the message, in the same request", async () => {
    const subject = { ...mailDockSubject(workspace, { key: "mail/w1/mt1", title: "Lunch", chip: { kind: "mail", label: "Lunch", ref: { at: "lifeos", table: "mailThreads", id: "mt1" } }, kind: "mail", mailThreadId: "mt1" } as never), find: async () => null };
    const { id } = await dockThread(workspace, subject);
    enterDock(id);
    await send(sessionStore.get(id)!, "Draft a reply");
    expect(methods().filter((m) => m !== "session.events")).toEqual(["session.create"]);
    expect(h.asked[0].params).toMatchObject({ firstMessage: "Draft a reply", mailAdopt: { workspaceId: "w1", kind: "mail", mailThreadId: "mt1" } });
  });
});
