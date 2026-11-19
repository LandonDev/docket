import { describe, expect, it } from "vitest";
import { splitWorkRows, type RailItem } from "./linkedRail";
import type { WorkspaceMeta } from "./tcserver/types";

const item = (path: string, id: string): RailItem => ({ path, openedAt: 1, paths: [path], workspaceIds: [id], hosts: ["local"] });
const ws = (id: string, kind?: "work"): WorkspaceMeta => ({ id, name: id, path: `/${id}`, git: !kind, createdAt: 1, environmentId: "local", ...(kind ? { kind, sector: "life" } : {}) }) as WorkspaceMeta;

describe("splitWorkRows", () => {
  const code = item("/code", "code");
  const work = item("/work", "work");

  it("hands back the very rows when there is no Work workspace", () => {
    const rows = { pinned: [code], projects: [] };
    const split = splitWorkRows(rows, [ws("code")], true);
    expect(split.pinned).toBe(rows.pinned);
    expect(split.projects).toBe(rows.projects);
    expect(split.work).toEqual([]);
  });

  it("never lists a Work workspace among the code ones, pinned or not, and lists it as Work only while Work is on", () => {
    const rows = { pinned: [work], projects: [code] };
    const catalog = [ws("code"), ws("work", "work")];
    expect(splitWorkRows(rows, catalog, false)).toEqual({ pinned: [], projects: [code], work: [] });
    expect(splitWorkRows(rows, catalog, true)).toEqual({ pinned: [], projects: [code], work: [work] });
  });
});
