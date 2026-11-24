// @vitest-environment jsdom
/** `useSessionById` asks again for a transcript the store let go while it is still drawn (W-51). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { newSession } from "../session";
import { sessionStore, type Link } from "../tcserver/store";
import type { EventRow, ServerPush, SessionMeta } from "../tcserver/types";
import { useSessionById } from "./agents";

const meta = (id: string): SessionMeta => ({
  environmentId: "local", id, parentId: null, projectId: null, workspaceId: null, threadType: null, planPath: null,
  provider: "claude", model: "claude-sonnet-5-5", reasoning: "medium", agentType: "implementer", title: "Ask", cwd: "/repo",
  status: "idle", archived: false, pinned: false, permission: "edits", fast: false, ultrafast: false, context1m: false,
  busySince: null, pausedAt: null, frozenActiveElapsed: null, nativeId: null, createdAt: 1, updatedAt: 1,
});
const row = (sessionId: string, seq: number, event: EventRow["event"]): EventRow => ({ sessionId, seq, ts: 1_000 + seq, event });

/** A host with one thread's log: it answers the list, the transcript, and nothing else. */
class Host implements Link {
  environmentId = "local";
  profile = "local" as const;
  connected = true;
  events: EventRow[] = [];
  fetches = 0;
  private listeners = new Set<(push: ServerPush) => void>();
  request<T>(method: string): Promise<T> {
    if (method === "session.list") return Promise.resolve([] as T);
    if (method === "session.events") {
      this.fetches++;
      return Promise.resolve(this.events as T);
    }
    return Promise.resolve(null as T);
  }
  onPush(l: (push: ServerPush) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  onOpen() {
    return () => {};
  }
  onClose() {
    return () => {};
  }
  push(push: ServerPush): void {
    for (const l of this.listeners) l(push);
  }
}

let host: Host;
beforeEach(() => {
  host = new Host();
  sessionStore.reset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  sessionStore.reset();
});

describe("useSessionById", () => {
  it("a draft that became a thread, finished and let go while still drawn, is asked for again and comes back", async () => {
    sessionStore.attach(host);
    await sessionStore.ready();
    const draft = newSession("local", "claude", "/repo");
    sessionStore.mutate([draft]);
    const { result } = renderHook(() => useSessionById(draft.id));
    // His first send: the draft is made a thread here, its turn runs and settles by pushes.
    sessionStore.appendOptimisticUser(draft.id, "Draft a reply");
    act(() => sessionStore.adopt({ ...meta(draft.id), status: "running" }, { created: true }));
    host.events = [row(draft.id, 1, { type: "user-text", text: "Draft a reply" }), row(draft.id, 2, { type: "turn-complete" })];
    act(() => {
      for (const r of host.events) host.push({ push: "event", row: r });
      const { environmentId: _e, ...wire } = { ...meta(draft.id), status: "idle" as const };
      host.push({ push: "session", session: wire });
    });
    await waitFor(() => expect(result.current?.busy).toBe(false));
    expect(result.current?.blocks).toHaveLength(1);
    // Nothing tells the store it is shown (no pane, no dock): the sweep lets it go.
    vi.useFakeTimers();
    sessionStore.setMounted([]);
    await act(() => vi.advanceTimersByTimeAsync(3100));
    vi.useRealTimers();
    // The hook still draws it: it asks the host again, and the rows come back.
    await waitFor(() => expect(result.current?.load.phase).toBe("loaded"));
    expect(host.fetches).toBe(1);
    expect(result.current?.blocks.map((b) => b.text)).toEqual(["Draft a reply"]);
  });
});
