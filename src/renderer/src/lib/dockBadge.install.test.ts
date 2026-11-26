import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetaChanges } from "./tcserver/store";
import type { SessionMeta } from "./tcserver/types";

// The store as the badge reads it: metas, one by id, the meta flush.
const fake = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  listeners: new Set<(changes: { ids: ReadonlySet<string>; affected: ReadonlySet<string> }) => void>(),
}));
vi.mock("./tcserver/store", () => ({
  sessionStore: {
    metas: () => [...fake.rows.values()],
    metaOf: (id: string) => fake.rows.get(id) ?? null,
    settledEnvironments: () => Promise.resolve(),
    onMetaChange: (l: (changes: MetaChanges) => void) => {
      fake.listeners.add(l);
      return () => fake.listeners.delete(l);
    },
  },
}));
vi.mock("./native", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { badgePasses, installDockBadge } from "./dockBadge";

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({ environmentId: "local", id, parentId: null, projectId: null, workspaceId: null, threadType: "chat", title: id, cwd: "/repo", status: "running", archived: false, pinned: false, busySince: 1, createdAt: 1, updatedAt: 100, ...extra }) as SessionMeta;

const pushed = (m: SessionMeta) => {
  fake.rows.set(m.id, m);
  for (const l of fake.listeners) l({ ids: new Set([m.id]), affected: new Set([m.id]) });
};

let off = () => {};
afterEach(() => {
  off();
  fake.rows.clear();
});

describe("the Dock badge's passes", () => {
  it("a meta push that moves no counting fact runs no pass; one that does runs one", async () => {
    for (let i = 0; i < 40; i++) fake.rows.set(`t${i}`, meta(`t${i}`));
    off = installDockBadge(true);
    await Promise.resolve();
    const start = badgePasses();
    expect(start).toBeGreaterThan(0);
    // A running thread's tool call, phase and context reading: activity, detail, a title.
    for (let i = 0; i < 10; i++) pushed(meta("t7", { activity: `Reading ${i}.ts`, statusDetail: `step ${i}`, title: `t7 ${i}` }));
    expect(badgePasses()).toBe(start);
    pushed(meta("t7", { status: "idle", updatedAt: 200 }));
    expect(badgePasses()).toBe(start + 1);
  });

  it("counts nothing where no Dock draws a badge", async () => {
    fake.rows.set("a", meta("a"));
    const start = badgePasses();
    off = installDockBadge(false);
    await Promise.resolve();
    pushed(meta("a", { status: "idle", updatedAt: 300 }));
    expect(badgePasses()).toBe(start);
    expect(fake.listeners.size).toBe(0);
  });
});
