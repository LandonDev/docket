import { describe, expect, it } from "vitest";
import type { RailItem } from "../../lib/linkedRail";
import type { ProjectMeta, WorkspaceMeta } from "../../lib/tcserver/types";
import { codeThreadChip, codeWorkspaces, pickedProject } from "./codeThread";

/** Open a code thread… on a task: the code workspaces as the rail lists them, and what the thread is told. */

const ws = (id: string, extra: Partial<WorkspaceMeta> = {}): WorkspaceMeta =>
  ({ id, name: id, path: `/r/${id}`, git: true, createdAt: 1, environmentId: "env_mac", ...extra }) as WorkspaceMeta;
const row = (...ids: string[]): RailItem => ({ path: `/r/${ids[0]}`, openedAt: 1, paths: ids.map((id) => `/r/${id}`), workspaceIds: ids, hosts: [] });
const project = (id: string, workspaceId: string, extra: Partial<ProjectMeta> = {}): ProjectMeta =>
  ({ id, workspaceId, name: id, mode: "local", branch: "main", cwd: `/r/${workspaceId}`, archived: false, createdAt: 1, environmentId: "env_mac", ...extra }) as ProjectMeta;

describe("the code workspaces a task's code thread can start in", () => {
  const workspaces = [
    ws("site", { sector: "purdue" }),
    ws("app"),
    ws("app-box", { name: "app", environmentId: "env_box" }),
    ws("work", { kind: "work", sector: "purdue" }),
    ws("off", { environmentId: "env_off" }),
    ws("lib", { environmentId: "env_off" }),
    ws("lib-box", { name: "lib", environmentId: "env_box" }),
  ];
  const projects = [
    project("p-api", "app", { linkId: "L1" }),
    project("p-api-box", "app-box", { linkId: "L1", environmentId: "env_box" }),
    project("p-web", "app"),
    project("p-old", "app", { archived: true }),
    project("p-core-box", "lib-box", { environmentId: "env_box" }),
  ];
  const hosts = new Set(["env_mac", "env_box"]);

  it("are the rail's code rows in its order, one per link, only where Work is on", () => {
    const listed = codeWorkspaces([row("site"), row("work"), row("app", "app-box"), row("off")], workspaces, projects, hosts);
    expect(listed.map((w) => [w.id, w.sector])).toEqual([
      ["site", "purdue"],
      ["app", null],
    ]);
  });

  it("offer the picked copy's own projects, never an archived one or another host's", () => {
    const [app] = codeWorkspaces([row("app", "app-box")], workspaces, projects, hosts);
    expect(app!.projects.map((p) => p.id)).toEqual(["p-api", "p-web"]);
  });

  it("keep a picked project only while the workspace picked holds it, so a search that moves the pick drops it", () => {
    const [site, app] = codeWorkspaces([row("site"), row("app")], workspaces, projects, hosts);
    expect(pickedProject(app!, "p-web")).toBe("p-web");
    expect(pickedProject(site!, "p-web")).toBe("");
    expect(pickedProject(null, "p-web")).toBe("");
  });

  it("take a linked row's next copy when its lead's host has Work off", () => {
    const [lib] = codeWorkspaces([row("lib", "lib-box")], workspaces, projects, hosts);
    expect([lib!.id, lib!.path, lib!.environmentId, lib!.projects.map((p) => p.id)]).toEqual(["lib-box", "/r/lib-box", "env_box", ["p-core-box"]]);
  });
});

describe("what a task's code thread is told", () => {
  const task = { _id: "k1", title: "Fix the bracket page" };
  const ref = { at: "lifeos", table: "tasks", id: "k1" };

  it("is the task's own chip in a workspace linked to its sector, which reads LifeOS itself", () => {
    expect(codeThreadChip(task, "Seeds are wrong", true)).toEqual({ kind: "task", label: task.title, ref });
  });

  it("carries the title and notes as text in any other, still naming the task so the host links it", () => {
    expect(codeThreadChip(task, "  Seeds are wrong \n", false)).toEqual({ kind: "task", label: task.title, ref, quote: "Seeds are wrong" });
    expect(codeThreadChip(task, undefined, false)).toEqual({ kind: "task", label: task.title, ref });
  });
});
