import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { newTab } from "./layout";
import { newSession } from "./session";
import { sessionStore, type Link } from "./tcserver/store";
import type { EventRow, ServerPush, SessionMeta } from "./tcserver/types";
import type { EventsPage } from "@server/shared/wire";
import type { WindowTransferPayload } from "./windowTransfer";

/**
 * A tab moved to a new window: the window that takes it asks for a remote
 * thread's transcript once, and gets its tail, never the whole kept log
 * (it once paged every older page in before it painted).
 */
const transfer = vi.hoisted(() => ({ payload: null as unknown }));
vi.mock("./windowTransferBootstrap", () => ({ loadWindowTransfer: async () => transfer.payload }));
vi.mock("./fs", () => ({ restoreSessionCheckout: async (session: unknown) => session }));

function wireMeta(over: Partial<SessionMeta>): Omit<SessionMeta, "environmentId"> {
  return {
    id: "s", parentId: null, projectId: "p1", workspaceId: null, threadType: null, planPath: null,
    provider: "claude", model: "claude-sonnet-5-5", reasoning: "medium", agentType: "implementer",
    title: "t", cwd: "/repo", status: "idle", archived: false, pinned: false, permission: "edits",
    fast: false, ultrafast: false, context1m: false, busySince: null, pausedAt: null, frozenActiveElapsed: null,
    nativeId: null, createdAt: 1, updatedAt: 1, ...over,
  };
}

/** The box: a remote socket that answers a tail of `pageRows` and older pages the same size. */
class BoxLink implements Link {
  environmentId = "box";
  readonly profile = "remote" as const;
  connected = true;
  pageRows = 300;
  metas: Omit<SessionMeta, "environmentId">[] = [];
  events = new Map<string, EventRow[]>();
  calls: { method: string; params: unknown }[] = [];
  request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "session.list") {
      const archived = (params as { archived?: boolean } | undefined)?.archived;
      return Promise.resolve({ sessions: archived ? [] : this.metas, cursor: null } as T);
    }
    if (method === "session.events") {
      const { sessionId, beforeSeq, tail, subscribe } = params as { sessionId: string; beforeSeq?: number; tail?: number; subscribe?: boolean };
      const all = this.events.get(sessionId) ?? [];
      const range = tail ? all.filter((r) => beforeSeq === undefined || r.seq < beforeSeq) : all;
      const rows = range.slice(-this.pageRows);
      // A current host subscribes inside the ask and says so.
      const page: EventsPage = { rows, moreBefore: rows.length > 0 && rows[0].seq > 1, moreAfter: false, reset: false, ...(subscribe ? { subscribed: true } : {}) };
      return Promise.resolve(page as T);
    }
    return Promise.resolve(null as T);
  }
  onPush(_l: (push: ServerPush) => void) {
    return () => {};
  }
  onOpen(_l: () => void) {
    return () => {};
  }
  onClose() {
    return () => {};
  }
  asks(sessionId: string) {
    return this.calls.filter((c) => c.method === "session.events" && (c.params as { sessionId: string }).sessionId === sessionId);
  }
}

let box: BoxLink;
beforeEach(() => {
  sessionStore.reset();
  box = new BoxLink();
});
afterEach(() => sessionStore.reset());

it("a transfer sends at most one transcript ask for a remote thread, and it asks for the tail", async () => {
  // 6,000 rows on the box: twenty pages behind a 300-row tail.
  const rows: EventRow[] = [];
  for (let seq = 1; seq <= 6_000; seq++) {
    rows.push({ sessionId: "far", seq, ts: seq, event: seq % 2 ? { type: "user-text", text: `prompt ${seq}` } : { type: "assistant-text", text: `answer ${seq}`, delta: false } });
  }
  box.metas = [wireMeta({ id: "far", title: "Far thread" })];
  box.events.set("far", rows);
  const tab = newTab("far");
  transfer.payload = {
    tabs: [tab],
    sessions: [{ ...newSession("box", "claude", "/repo"), id: "far", title: "Far thread" }],
    activeTabId: tab.id,
    projectCwd: "/repo",
    dirtyFileIds: [],
  } satisfies WindowTransferPayload;
  sessionStore.attach(box);
  const { loadBootWorkspace } = await import("./appLifecycle");
  const boot = await loadBootWorkspace();

  expect(boot.windowTransfer?.sessions.map((s) => s.id)).toEqual(["far"]);
  const asks = box.asks("far");
  expect(asks).toHaveLength(1);
  expect(asks[0].params).toMatchObject({ sessionId: "far", afterSeq: 0, tail: expect.any(Number) });
  expect((asks[0].params as { beforeSeq?: number }).beforeSeq).toBeUndefined();
  // The tail is painted; the rest waits on the host for the reader.
  expect(sessionStore.get("far")?.blocks).toHaveLength(300);
  expect(sessionStore.hasOlderHistory("far")).toBe(true);
  // The pane that mounts asks nothing more.
  await sessionStore.ensureLoaded("far");
  expect(box.asks("far")).toHaveLength(1);
});
