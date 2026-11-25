import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionStore } from "../lib/tcserver/store";
import { workspaceStore } from "../lib/tcserver/workspaces";
import type { ProjectMeta, WorkspaceMeta } from "../lib/tcserver/types";
import { workFilesHome } from "./FileRefMenu";

/** A file named in a Work thread opens in its job's Files place; a code thread or a Work Chat has none to offer. */
const WORK = { id: "ws", name: "Purdue Esports", path: "/w/p", kind: "work", sector: "purdue", createdAt: 1, environmentId: "box" } as WorkspaceMeta;
const LAN = { id: "p1", workspaceId: "ws", name: "Spring LAN", environmentId: "box" } as ProjectMeta;

describe("Open in Files from a transcript", () => {
  const metas: Record<string, unknown> = {
    loose: { id: "loose", scope: "work", workspaceId: "ws", projectId: null },
    inProject: { id: "inProject", scope: "work", workspaceId: null, projectId: "p1" },
    chat: { id: "chat", scope: "work", workspaceId: null, projectId: null },
    code: { id: "code", workspaceId: "ws", projectId: null },
  };
  beforeEach(() => {
    workspaceStore.reset();
    workspaceStore.hydrate([{ environmentId: "box", workspaces: [WORK], projects: [LAN] }]);
    vi.spyOn(sessionStore, "metaOf").mockImplementation((id: string) => (metas[id] ?? null) as never);
  });
  afterEach(() => {
    workspaceStore.reset();
    vi.restoreAllMocks();
  });

  it("names the job of a Work thread, loose or in a project", () => {
    expect(workFilesHome("loose")).toEqual({ id: "ws", environmentId: "box" });
    expect(workFilesHome("inProject")).toEqual({ id: "ws", environmentId: "box" });
  });

  it("offers nothing for a Work Chat, a code thread or no thread", () => {
    expect(workFilesHome("chat")).toBeNull();
    expect(workFilesHome("code")).toBeNull();
    expect(workFilesHome(undefined)).toBeNull();
  });
});
