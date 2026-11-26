// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useActivity } from "../activity";
import { useSessionMetasWhere, useSessionTree } from "./metaSelect";
import { sessionStore, useSession, useSessionChrome, useSessionMeta } from "./store";
import type { SessionMeta } from "./types";

/**
 * One meta push of a thread no screen shows (D20, the soak's idle scene): the
 * chrome that draws other threads hears nothing of it. Counted in renders and
 * listener calls, never in time.
 */

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    environmentId: "local",
    id: "s1",
    parentId: null,
    projectId: null,
    workspaceId: null,
    threadType: "chat",
    planPath: null,
    provider: "claude",
    model: "claude-sonnet-5-5",
    reasoning: "medium",
    agentType: "implementer",
    title: "thread",
    cwd: "/repo",
    status: "idle",
    archived: false,
    pinned: false,
    permission: "edits",
    fast: false,
    ultrafast: false,
    context1m: false,
    busySince: null,
    pausedAt: null,
    frozenActiveElapsed: null,
    nativeId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as SessionMeta;
}

const push = (m: SessionMeta) => sessionStore.injectPush({ push: "session", session: m }, m.environmentId);
/** The store flushes on the next frame (or a timer when there is none). */
const flush = () => act(() => new Promise((r) => setTimeout(r, 50)));

afterEach(() => sessionStore.reset());

describe("a meta push of a thread no screen shows", () => {
  it("calls no subscriber of another session, renders no panel hook, and no narrow reader of other threads", async () => {
    push(meta({ id: "shown", projectId: "p1", status: "running" }));
    push(meta({ id: "shown-child", parentId: "shown", projectId: "p1" }));
    push(meta({ id: "away", projectId: "p9", status: "running", activity: "Reading a.ts" }));
    await flush();

    let heard = 0;
    const off = sessionStore.subscribeSession("shown", () => heard++);
    const renders = { session: 0, chrome: 0, activity: 0, where: 0, tree: 0, meta: 0 };
    const keep = (m: SessionMeta) => m.projectId === "p1";
    const a = renderHook(() => (renders.session++, useSession("shown")));
    const b = renderHook(() => (renders.chrome++, useSessionChrome("shown")));
    const c = renderHook(() => (renders.activity++, useActivity("shown")));
    const d = renderHook(() => (renders.where++, useSessionMetasWhere(keep)));
    const e = renderHook(() => (renders.tree++, useSessionTree("shown")));
    const f = renderHook(() => (renders.meta++, useSessionMeta("shown")));
    expect(d.result.current.map((m) => m.id)).toEqual(["shown", "shown-child"]);
    expect([...e.result.current]).toEqual(["shown", "shown-child"]);
    const before = { ...renders };

    for (let i = 0; i < 5; i++) {
      push(meta({ id: "away", projectId: "p9", status: "running", activity: `Reading ${i}.ts`, updatedAt: 10 + i }));
      await flush();
    }
    expect(heard).toBe(0);
    expect(renders).toEqual(before);

    // The thread on screen moving is heard, once a flush.
    push(meta({ id: "shown", projectId: "p1", status: "idle", updatedAt: 50 }));
    await flush();
    expect(heard).toBe(1);
    expect(renders.where).toBe(before.where + 1);
    expect(renders.meta).toBe(before.meta + 1);
    // A child joining the tree moves the tree; another project's does not.
    push(meta({ id: "away-child", parentId: "away", projectId: "p9" }));
    await flush();
    expect(renders.tree).toBe(before.tree);
    push(meta({ id: "shown-child-2", parentId: "shown", projectId: "p1" }));
    await flush();
    expect([...e.result.current].sort()).toEqual(["shown", "shown-child", "shown-child-2"]);
    off();
    for (const view of [a, b, c, d, e, f]) view.unmount();
  });
});
