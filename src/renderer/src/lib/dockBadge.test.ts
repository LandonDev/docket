import { describe, expect, it } from "vitest";
import { badgeCount } from "./dockBadge";
import type { SessionMeta } from "./tcserver/types";

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    environmentId: "local",
    id,
    parentId: null,
    projectId: null,
    workspaceId: null,
    threadType: "chat",
    title: id,
    cwd: "/repo/a",
    status: "idle",
    archived: false,
    pinned: false,
    busySince: null,
    createdAt: 1,
    updatedAt: 100,
    ...extra,
  }) as SessionMeta;

const none = new Set<string>();
/** Every thread here read at 50: an update at 100 is unread. */
const seenAt = (metas: SessionMeta[], at = 50) => Object.fromEntries(metas.map((m) => [m.id, at]));

describe("badgeCount", () => {
  it("counts unread roots and threads that need you, on every host", () => {
    const metas = [
      meta("a"),
      meta("b", { environmentId: "box" }),
      meta("c", { status: "waiting", environmentId: "box" }),
      meta("read", { updatedAt: 40 }),
    ];
    expect(badgeCount(metas, none, seenAt(metas))).toBe(3);
    expect(badgeCount(metas, none, seenAt(metas, 200))).toBe(1);
  });

  it("never counts a master's child: the master stands in, once", () => {
    const metas = [
      meta("m", { isMaster: true }),
      meta("k1", { masterId: "m" }),
      meta("k2", { masterId: "m", status: "waiting" }),
      meta("k3", { masterId: "m", status: "waiting" }),
    ];
    // The master read, its children unread and two of them waiting: one row wants him.
    expect(badgeCount(metas, none, { ...seenAt(metas), m: 200 })).toBe(1);
    // The host cleared the master's mark (a child completed): still one.
    expect(badgeCount(metas, none, seenAt(metas))).toBe(1);
    // Nothing waits and the master is read: zero, the unread children say nothing.
    const quiet = metas.map((m) => ({ ...m, status: "idle" as const }));
    expect(badgeCount(quiet, none, { ...seenAt(quiet), m: 200 })).toBe(0);
    // A master watching a batch that still runs: its cleared mark counts once, and reading it clears it.
    const live = [meta("m", { isMaster: true, status: "watching" }), meta("k1", { masterId: "m" }), meta("k2", { masterId: "m", status: "running" })];
    expect(badgeCount(live, none, { ...seenAt(live), m: 0 })).toBe(1);
    expect(badgeCount(live, none, { ...seenAt(live), m: 200 })).toBe(0);
  });

  it("counts a root once, whether it or its subagent wants him", () => {
    const metas = [meta("r"), meta("s1", { parentId: "r", status: "waiting" }), meta("s2", { parentId: "r", status: "waiting" })];
    expect(badgeCount(metas, none, seenAt(metas))).toBe(1);
  });

  it("leaves out archived threads, archived projects, working and failed roots", () => {
    const metas = [
      meta("gone", { archived: true }),
      meta("gone-wait", { archived: true, status: "waiting" }),
      meta("old", { projectId: "p-old" }),
      meta("busy", { status: "running" }),
      meta("watching", { background: { agents: [{ id: "x" }] } as never }),
      meta("failed", { status: "error" }),
    ];
    expect(badgeCount(metas, new Set(["p-old"]), seenAt(metas))).toBe(0);
  });

  it("follows the floor for threads with no mark", () => {
    const metas = [meta("a"), meta("b", { updatedAt: 10 })];
    expect(badgeCount(metas, none, {}, 50)).toBe(1);
  });
});
