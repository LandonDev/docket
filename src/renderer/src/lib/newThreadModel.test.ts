import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadDefaults } from "@server/shared/defaults";
import { resolveModel, saveLastModelSettings } from "./models";
import { HARNESS_LABEL, newDefaultSession, newSession, type Session } from "./session";
import { sessionFromDraft, type DraftRecord } from "./projectDrafts";
import { modelParams } from "./tcserver/commands";
import { sessionStore } from "./tcserver/store";
import { scopeKey, workspaceStore } from "./tcserver/workspaces";
import type { DefaultsScope } from "./tcserver/defaults";

/**
 * The twin of newThreadAccess.test.ts for the provider, model and effort: with
 * his Thread defaults on Grok at low effort, every draft the window builds
 * shows Grok at low and asks the host for none of them (the host's defaults
 * decide, sessions.ts `create`). A draft made before the defaults loaded
 * follows them when they land; only his own pick on a draft travels.
 */
const set = (d: Partial<ThreadDefaults>): DefaultsScope => ({
  defaults: { provider: "claude", model: "", reasoning: "medium", permission: "edits", ...d },
  overridden: true,
});
function withDefaults(entries: [string, string | null, Partial<ThreadDefaults>][]): void {
  (workspaceStore as unknown as { setDefaults(m: ReadonlyMap<string, DefaultsScope>): void }).setDefaults(
    new Map(entries.map(([env, ws, d]) => [scopeKey(env, ws), set(d)])),
  );
}
const grok = resolveModel("grok").id;
const claude = resolveModel("claude").id;

beforeEach(() => {
  workspaceStore.reset();
  sessionStore.reset();
  withDefaults([["local", null, { provider: "grok", reasoning: "low" }]]);
});
afterEach(() => {
  workspaceStore.reset();
  sessionStore.reset();
});

const record = (over: Partial<DraftRecord>): DraftRecord => ({
  id: "d1", environmentId: "local", projectId: null, workspaceId: null, cwd: "~", harness: "claude", model: claude, modelSettings: { effort: "max" },
  runtimeMode: "auto-accept-edits", threadType: "chat", threadRules: null, segments: [], attachments: [], seenAt: 0, ...over,
});

const PATHS: [string, () => Session][] = [
  ["New thread, the draft a window boots with, an inbox item, a note, a host switch, the empty window", () => newDefaultSession("local", "/repo")],
  ["a Work Chat", () => newDefaultSession("local", "~", { scope: "work" })],
  ["a remembered draft seeded on Claude before the defaults loaded", () => sessionFromDraft(record({}), null)],
];

describe("a new thread's model, with his default on Grok at low", () => {
  it.each(PATHS)("%s: shows Grok at low and asks for none of it", (_name, make) => {
    const draft = make();
    expect(draft).toMatchObject({ harness: "grok", model: grok, modelSettings: { effort: "low" } });
    expect(modelParams(draft)).toEqual({ context1m: false });
  });

  it("a research draft runs on Claude whatever the default", () => {
    expect(newDefaultSession("local", "/repo", { threadType: "research" })).toMatchObject({ harness: "claude", model: claude });
  });

  it("before any defaults load: the built-in, Claude at medium", () => {
    workspaceStore.reset();
    expect(newDefaultSession("local", "/repo")).toMatchObject({ harness: "claude", model: claude, modelSettings: { effort: "medium" } });
  });

  it("an unsent draft made before the defaults loaded follows them as they land; a pick or a sent draft stays", () => {
    workspaceStore.reset();
    const early = newDefaultSession("local", "/repo");
    const picked = { ...newDefaultSession("local", "/repo"), modelPicked: true as const };
    const sent = { ...newDefaultSession("local", "/repo"), blocks: [{ id: "b1", role: "user" as const, text: "hi" }] };
    sessionStore.mutate([early, picked, sent]);
    // As App wires it.
    const stop = workspaceStore.subscribe(sessionStore.reseedDrafts);
    withDefaults([["local", null, { provider: "grok", reasoning: "low" }]]);
    stop();
    expect(sessionStore.get(early.id)).toMatchObject({ harness: "grok", model: grok, modelSettings: { effort: "low" }, title: HARNESS_LABEL.grok });
    expect(sessionStore.get(picked.id)).toMatchObject({ harness: "claude", model: claude });
    expect(sessionStore.get(sent.id)).toMatchObject({ harness: "claude", model: claude });
  });

  it("keeps his last context window where the model offers it, and its create carries it alone", () => {
    const mem = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
    try {
      saveLastModelSettings({ context: "1m", effort: "max" });
      withDefaults([["local", null, { provider: "claude", reasoning: "high" }]]);
      const wide = newDefaultSession("local", "/repo");
      // His last effort does not ride: the default's does.
      expect(wide).toMatchObject({ harness: "claude", modelSettings: { context: "1m", effort: "high" } });
      expect(modelParams(wide)).toEqual({ context1m: true });
      // A model with no 1M window shows none and sends none.
      withDefaults([["local", null, { provider: "grok", reasoning: "low" }]]);
      const narrow = newDefaultSession("local", "/repo");
      expect(narrow.modelSettings).not.toHaveProperty("context");
      expect(modelParams(narrow)).toEqual({ context1m: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("his pick on a draft is kept and is the only model a create carries", () => {
    const pick = { ...newSession("local", "claude", "/repo", claude, { effort: "low", context: "1m" }), modelPicked: true as const };
    expect(modelParams(pick)).toMatchObject({ provider: "claude", reasoning: "low", context1m: true });
    expect(sessionFromDraft(record({ modelPicked: true }), null)).toMatchObject({ harness: "claude", model: claude, modelSettings: { effort: "max" }, modelPicked: true });
  });
});
