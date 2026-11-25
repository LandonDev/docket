import { describe, expect, it } from "vitest";
import { leadOf, projectMirrors, projectRoots } from "./roots";

/** A sector's LifeOS projects and their Work threads, from the summaries and the mirrors this window holds. */
const meta = (id: string, over: Record<string, unknown> = {}) => ({ id, parentId: null, projectId: "m-lan", archived: false, scope: "work" as const, title: id, workOutcome: null, updatedAt: 1, ...over });
const WORKSPACES = [
  { id: "ws-box", kind: "work" as const, sector: "purdue" },
  { id: "ws-mac", kind: "work" as const, sector: "purdue" },
  { id: "ws-ref", kind: "work" as const, sector: "ref" },
  { id: "ws-code", kind: "code" as const, sector: null },
];
const PROJECTS = [
  { id: "m-lan", workspaceId: "ws-box", lifeosProjectId: "lp-lan", archived: false },
  { id: "m-lan-mac", workspaceId: "ws-mac", lifeosProjectId: "lp-lan", archived: false },
  { id: "m-games", workspaceId: "ws-ref", lifeosProjectId: "lp-games", archived: false },
  { id: "m-old", workspaceId: "ws-box", lifeosProjectId: "lp-old", archived: true },
  { id: "p-code", workspaceId: "ws-code", lifeosProjectId: null, archived: false },
];

describe("a project's threads in the window", () => {
  it("finds a project's mirrors from the catalog alone, one a host, with no thread in them needed (Files)", () => {
    const hosted = PROJECTS.map((p) => ({ ...p, environmentId: p.workspaceId === "ws-mac" ? "env_mac" : "env_box" }));
    const mirrors = projectMirrors(WORKSPACES, hosted, "purdue");
    expect([...mirrors.keys()]).toEqual(["lp-lan"]);
    expect(mirrors.get("lp-lan")).toEqual([
      { env: "env_box", mirrorId: "m-lan" },
      { env: "env_mac", mirrorId: "m-lan-mac" },
    ]);
  });

  it("gathers the root Work threads of every mirror of the project in the sector, on any host, newest first", () => {
    const roots = projectRoots(
      [
        meta("a", { updatedAt: 2 }),
        meta("b", { projectId: "m-lan-mac", updatedAt: 5 }),
        // A subagent's work is its root's; an archived thread is not listed; a code thread is not Work's.
        meta("child", { parentId: "a" }),
        meta("gone", { archived: true }),
        meta("code", { scope: undefined }),
        // Another sector's project, and a mirror that was archived.
        meta("games", { projectId: "m-games" }),
        meta("old", { projectId: "m-old" }),
      ],
      WORKSPACES,
      PROJECTS,
      "purdue",
    );
    expect([...roots.keys()]).toEqual(["lp-lan"]);
    expect(roots.get("lp-lan")!.map((t) => t.sessionId)).toEqual(["b", "a"]);
  });

  it("the lead is the most pressing thread, then the newest", () => {
    const held = { sessionId: "h", title: "h", updatedAt: 1, outcome: { words: "1 mail to send", tone: "held" as const } };
    const made = { sessionId: "m", title: "m", updatedAt: 9, outcome: { words: "Made Seat map.xlsx", tone: "made" as const } };
    const quiet = { sessionId: "q", title: "q", updatedAt: 20, outcome: null };
    expect(leadOf([quiet, made, held])?.sessionId).toBe("h");
    expect(leadOf([quiet])?.sessionId).toBe("q");
    expect(leadOf([])).toBeNull();
  });
});
