import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadDefaults } from "@server/shared/defaults";
import { accessParams, newDefaultSession, newSession, newThreadAccess, type Session } from "./session";
import { sessionFromDraft, type DraftRecord } from "./projectDrafts";
import { scopeKey, workspaceStore } from "./tcserver/workspaces";
import type { DefaultsScope } from "./tcserver/defaults";

/**
 * Every way the window builds a new thread, with his Thread defaults at Full
 * access: each shows Full access and asks the host for no mode of its own
 * (the host's defaults decide, sessions.ts `newThreadPermission`). Only his
 * own pick on a draft travels.
 */
const set = (permission: ThreadDefaults["permission"]): DefaultsScope => ({
  defaults: { provider: "claude", model: "", reasoning: "medium", permission },
  overridden: true,
});
function withDefaults(entries: [string, string | null, ThreadDefaults["permission"]][]): void {
  (workspaceStore as unknown as { setDefaults(m: ReadonlyMap<string, DefaultsScope>): void }).setDefaults(
    new Map(entries.map(([env, ws, p]) => [scopeKey(env, ws), set(p)])),
  );
}

beforeEach(() => {
  workspaceStore.reset();
  workspaceStore.hydrate([
    { environmentId: "box", workspaces: [{ id: "w-box", name: "box", path: "/box" }], projects: [{ id: "p-box", workspaceId: "w-box", cwd: "/box/app", name: "app" }] },
  ]);
  withDefaults([
    ["local", null, "auto"],
    ["box", null, "auto"],
  ]);
});
afterEach(() => workspaceStore.reset());

const record = (over: Partial<DraftRecord>): DraftRecord => ({
  id: "d1", environmentId: "local", projectId: null, workspaceId: null, cwd: "~", harness: "claude", model: "", modelSettings: {},
  runtimeMode: "supervised", threadType: "chat", threadRules: null, segments: [], attachments: [], seenAt: 0, ...over,
});

const PATHS: [string, () => Session][] = [
  ["a fresh draft (⌘N, New thread, every type)", () => newSession("local", "claude", "/repo")],
  ["the draft a window boots with, an inbox item, a note, a host switch, the empty window", () => newDefaultSession("local", "~")],
  ["a Codex thread (second opinion, hand-off)", () => newSession("local", "codex", "/repo")],
  ["a project on the box", () => newSession("box", "claude", "/box/app", undefined, undefined, { projectId: "p-box" })],
  ["a Work Chat on the box", () => newSession("box", "claude", "~", undefined, undefined, { scope: "work" })],
  ["a remembered draft seeded Supervised before the defaults loaded", () => sessionFromDraft(record({}), null)],
];

describe("a new thread's access, with his default at Full access", () => {
  it.each(PATHS)("%s: shows Full access and asks for none", (_name, make) => {
    const draft = make();
    expect(draft.runtimeMode).toBe("full-access");
    expect(accessParams(draft)).toEqual({});
  });

  it("reads the scope's own set: a workspace override on the right host, else that host's global set", () => {
    withDefaults([["box", "w-box", "safe"]]);
    expect(newThreadAccess("box", { projectId: "p-box" })).toBe("supervised");
    expect(newThreadAccess("box", { workspaceId: "w-box" })).toBe("supervised");
    expect(newThreadAccess("local", { workspaceId: "w-box" })).toBe("full-access");
  });

  it("before any defaults load: the app's one built-in default, never Supervised", () => {
    workspaceStore.reset();
    expect(newThreadAccess("local")).toBe("auto-accept-edits");
  });

  it("his pick on a draft is kept and is the only access a create carries", () => {
    const picked = { ...newSession("local", "claude", "/repo"), runtimeMode: "supervised" as const, accessPicked: true as const };
    expect(accessParams(picked)).toEqual({ permission: "safe" });
    const kept = sessionFromDraft(record({ runtimeMode: "supervised", accessPicked: true }), null);
    expect(kept).toMatchObject({ runtimeMode: "supervised", accessPicked: true });
  });
});
