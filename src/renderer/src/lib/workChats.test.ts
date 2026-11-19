import { describe, expect, it } from "vitest";
import { homeOrWorkspacePath, resolveSessionContext, workspacePathOfSession } from "./projectContext";
import { draftKeyOf, draftPicks, sessionFromDraft, type DraftRecord } from "./projectDrafts";
import { newSession } from "./session";
import { looksLikeProject } from "./recents";
import { groupWorkspaceSessions, withLifeosCards } from "./workspaceSessions";
import { sidebarItems } from "./sidebarRows";
import type { ProjectMeta, SessionMeta, WorkspaceMeta } from "./tcserver/types";
import { WORK_CHATS, workspaceIdOf } from "./tcserver/workspaces";

/**
 * The Work Chats (docs/agents/work-scope.md): a Work thread outside every
 * workspace lives under "~work", never among the code chats ("~"), and a
 * code row is placed as it always was.
 */

const CODE = { id: "w-code", name: "repo", path: "/r/repo", git: true, createdAt: 1, environmentId: "local" } as WorkspaceMeta;
const WORK = { id: "w-work", name: "Purdue", path: "/w/Work/Purdue", git: false, createdAt: 2, kind: "work", sector: "purdue", environmentId: "env_box" } as WorkspaceMeta;
const catalog = { workspaces: [CODE, WORK], projects: [] as ProjectMeta[] };
const meta = (id: string, extra: Partial<SessionMeta>): SessionMeta =>
  ({ id, environmentId: "env_box", parentId: null, projectId: null, workspaceId: null, threadType: "chat", title: id, cwd: "/w/Work/Chats", status: "idle", archived: false, pinned: false, busySince: null, createdAt: 1, updatedAt: 1, ...extra }) as SessionMeta;

describe("the Work Chats", () => {
  it("hold a Work thread outside every workspace, and only those", () => {
    const work = meta("work-chat", { scope: "work" });
    const code = meta("code-chat", { cwd: "/home/me" });
    expect(workspaceIdOf(work, [], catalog.workspaces)).toBe(WORK_CHATS);
    expect(workspaceIdOf(code, [], catalog.workspaces)).toBeNull();
    expect(workspacePathOfSession(work, catalog)).toBe(WORK_CHATS);
    expect(workspacePathOfSession(code, catalog)).toBe("~");
    // A Work thread of a workspace is that workspace's.
    expect(workspaceIdOf(meta("in", { scope: "work", workspaceId: WORK.id }), [], catalog.workspaces)).toBe(WORK.id);
  });

  it("is a key, never a folder", () => {
    expect(looksLikeProject(WORK_CHATS)).toBe(false);
    expect(homeOrWorkspacePath(WORK_CHATS)).toBe(WORK_CHATS);
    expect(homeOrWorkspacePath("/home/me")).toBe(normalized("/home/me"));
  });

  it("splits the chats: the code home's list never shows a Work Chat, the Work Chats' only those", () => {
    const metas = [meta("work-chat", { scope: "work", updatedAt: 2 }), meta("code-chat", { cwd: "/home/me" })];
    expect(groupWorkspaceSessions(metas, [], catalog.workspaces, null, {}).chats.map((r) => r.id)).toEqual(["code-chat"]);
    expect(groupWorkspaceSessions(metas, [], catalog.workspaces, WORK_CHATS, {}).chats.map((r) => r.id)).toEqual(["work-chat"]);
  });

  it("drafts outside every workspace, asking for Work, under a key of their own", () => {
    const ctx = resolveSessionContext({ ...catalog, projectId: null, workspacePath: WORK_CHATS });
    expect(ctx).toEqual({ projectId: null, workspaceId: null, cwd: "~", scope: "work" });
    expect(draftKeyOf({ projectId: null, environmentId: "env_box", workspaceId: null, scope: "work" }, catalog)).not.toBe(
      draftKeyOf({ projectId: null, environmentId: "env_box", workspaceId: null }, catalog),
    );
    // The code home's context is what it was.
    expect(resolveSessionContext({ ...catalog, projectId: null, workspacePath: "~" })).toEqual({ projectId: null, workspaceId: null, cwd: "~" });
  });
});

describe("a Work Chat's draft kept and brought back", () => {
  it("is still a Work Chat: same key, and it still asks for Work", () => {
    const draft = newSession("env_box", "claude", "~", undefined, undefined, undefined, { scope: "work" });
    const record = { ...draftPicks(draft), segments: [], attachments: [], seenAt: 1 } as DraftRecord;
    const back = sessionFromDraft(record, null);
    expect(back.scope).toBe("work");
    expect(draftKeyOf(back, catalog)).toBe(draftKeyOf(draft, catalog));
    // A code chat's draft never gains it.
    const code = newSession("env_box", "claude", "~");
    expect(sessionFromDraft({ ...draftPicks(code), segments: [], attachments: [], seenAt: 1 } as DraftRecord, null).scope).toBeUndefined();
  });
});

function normalized(path: string): string {
  return homeOrWorkspacePath(path);
}

describe("a linked Work workspace's projects", () => {
  const mirror = { id: "p1", workspaceId: WORK.id, name: "Spring LAN", mode: "local", branch: null, cwd: WORK.path, archived: false, createdAt: 5, lifeosProjectId: "lp1", environmentId: "env_box" } as ProjectMeta;
  const lifeos = [
    { id: "lp1", name: "Spring LAN" },
    { id: "lp2", name: "Nationals travel" },
  ];

  it("are LifeOS's: a card for each, the one with threads its own project", () => {
    const shown = withLifeosCards([mirror], WORK, lifeos);
    expect(shown.map((p) => [p.id, p.name])).toEqual([
      ["p1", "Spring LAN"],
      ["lifeos:lp2", "Nationals travel"],
    ]);
    const groups = groupWorkspaceSessions([], shown, catalog.workspaces, WORK.id, {});
    expect(groups.projects.map((g) => g.project.id).sort()).toEqual(["lifeos:lp2", "p1"]);
  });

  it("leave a code workspace and an unlinked one as they were", () => {
    const projects = [mirror];
    expect(withLifeosCards(projects, CODE, lifeos)).toBe(projects);
    expect(withLifeosCards(projects, { ...WORK, sector: null } as WorkspaceMeta, [])).toBe(projects);
  });

  it("never offer New project in a Work workspace", () => {
    const none = { projects: [], archived: [], chats: [] };
    expect(sidebarItems(none, false, true)).toEqual([]);
    expect(sidebarItems(none, false).map((i) => i.kind)).toEqual(["empty"]);
  });
});
