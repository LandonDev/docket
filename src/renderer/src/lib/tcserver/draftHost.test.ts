import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A draft's create goes to its workspace's or project's own host (draftHost.ts). The fault: his Mac window minted a
 * Work draft before the box's lists arrived, so it took the Mac, and the create there answered "unknown workspace".
 */
const wire = vi.hoisted(() => ({ creates: [] as { environmentId: string; params: Record<string, unknown> }[] }));
vi.mock("../connection", () => {
  const linkOf = (environmentId: string) => ({
    environmentId,
    request: async (method: string, params: Record<string, unknown>) => {
      if (method !== "session.create") return {};
      wire.creates.push({ environmentId, params });
      return { id: params.id, provider: "claude", model: "m", status: "idle" };
    },
  });
  return { registry: { linkOf, link: linkOf, primary: () => linkOf("mac"), onLink: () => () => undefined, statusOf: () => ({}) } };
});
const known = vi.hoisted(() => new Set<string>());
vi.mock("./store", () => ({
  sessionStore: { metaOf: (id: string) => (known.has(id) ? { id } : undefined), isProvisional: () => false, linkFor: () => undefined, adopt: (meta: { id: string }) => void known.add(meta.id) },
}));
vi.mock("../macBridge", () => ({ bridgeNewThread: async () => undefined, bridgesNewThreads: () => false, bridgeFor: async () => null }));

import { newSession } from "../session";
import { ensureCreated } from "./commands";
import { DRAFT_HOST_UNKNOWN, DRAFT_HOST_WAIT_MS, draftHostOf } from "./draftHost";
import { workspaceStore } from "./workspaces";

const boxLists = { environmentId: "box", workspaces: [{ id: "w1", path: "/w", kind: "work" }], projects: [{ id: "p1", workspaceId: "w1", cwd: "/w" }] };
// The window's own host, as App mints a draft before the box's lists are in (App.tsx `environmentForContext`).
const draft = (id: string, ctx: { workspaceId?: string; projectId?: string }) => ({ ...newSession("mac", "claude", "/w", "claude:opus-5.5", undefined, ctx), id });

beforeEach(() => {
  wire.creates.length = 0;
  known.clear();
  workspaceStore.reset();
});
afterEach(() => vi.useRealTimers());

describe("a draft's create", () => {
  it("goes to the host that holds its workspace, not the host it was minted on", async () => {
    workspaceStore.hydrate([boxLists]);
    await ensureCreated(draft("d1", { workspaceId: "w1" }));
    expect(wire.creates.map((c) => [c.environmentId, c.params.workspaceId])).toEqual([["box", "w1"]]);
  });

  it("goes to its project's host", async () => {
    workspaceStore.hydrate([boxLists]);
    await ensureCreated(draft("d2", { projectId: "p1" }));
    expect(wire.creates.map((c) => c.environmentId)).toEqual(["box"]);
  });

  it("waits for the workspaces list when it has not come, then goes to the workspace's host", async () => {
    const made = ensureCreated(draft("d3", { workspaceId: "w1" }));
    await Promise.resolve();
    expect(wire.creates).toEqual([]);
    workspaceStore.hydrate([boxLists]);
    await made;
    expect(wire.creates.map((c) => c.environmentId)).toEqual(["box"]);
  });

  it("refuses with a plain line when the host never names it, and asks no host", async () => {
    vi.useFakeTimers();
    const made = ensureCreated(draft("d4", { workspaceId: "w1" }));
    const refused = expect(made).rejects.toThrow(DRAFT_HOST_UNKNOWN);
    await vi.advanceTimersByTimeAsync(DRAFT_HOST_WAIT_MS);
    await refused;
    expect(wire.creates).toEqual([]);
  });

  it("a chat outside every workspace goes where it was minted", async () => {
    await ensureCreated(draft("d5", {}));
    expect(wire.creates.map((c) => c.environmentId)).toEqual(["mac"]);
  });
});

describe("draftHostOf", () => {
  const catalog = { workspaces: [{ id: "w1", environmentId: "box" }], projects: [{ id: "p1", environmentId: "box" }] } as never;
  it("never answers the minted host for a workspace or project the catalog does not know", () => {
    expect(draftHostOf({ environmentId: "mac", workspaceId: "w9", projectId: null }, catalog)).toBeNull();
    expect(draftHostOf({ environmentId: "mac", workspaceId: null, projectId: "p9" }, catalog)).toBeNull();
    expect(draftHostOf({ environmentId: "mac", workspaceId: "w1", projectId: null }, catalog)).toBe("box");
  });
});

/** Every `session.create` the window sends, by file: a new one picks its host from its workspace or project too. */
const CREATE_PATHS: Record<string, string> = {
  // `createDraft` (every composer's first send: New thread, Ask's docks, plays, prep, Today) through `linkOfSession`;
  // `startThread` on the host its caller names.
  "lib/tcserver/commands.ts": "draftHost",
  // A dropped shot's new chat: its project's host.
  "lib/appshots.ts": "project?.environmentId",
  // The sidecar smoke: a loose chat on the host it is handed.
  "lib/tcserver/smoke.ts": "registry.linkOf(environmentId)",
};

describe("the window's session.create paths", () => {
  const root = join(__dirname, "../..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.tsx?$/.test(name) && !/\.(test|preview|fixtures)\./.test(name) ? [path] : [];
    });
  it("are the ones listed, each choosing its host as noted", () => {
    const found = files(root).filter((path) => /["']session\.create["']\s*,/.test(readFileSync(path, "utf8")));
    expect(found.map((path) => relative(root, path)).sort()).toEqual(Object.keys(CREATE_PATHS).sort());
    for (const [file, marker] of Object.entries(CREATE_PATHS)) expect(readFileSync(join(root, file), "utf8")).toContain(marker);
  });
});
