// @vitest-environment jsdom
/**
 * Changed by others, against hosts that answer `work.files.changed` from
 * memory (the read Files is to build): one call a job, the rows and their
 * words, asked again on the `work.files` push, and the press.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "@shared/work/files";

const world = vi.hoisted(() => ({
  calls: [] as { env: string; method: string; params: unknown }[],
  changed: new Map<string, unknown[]>(),
  down: new Set<string>(),
  pushes: new Map<string, Set<(push: unknown) => void>>(),
}));

vi.mock("../../lib/connection", async (original) => ({
  ...(await original<typeof import("../../lib/connection")>()),
  registry: {
    linkOf: (env: string) => ({
      environmentId: env,
      connected: true,
      request: async (method: string, params: { workspaceId: string }) => {
        world.calls.push({ env, method, params });
        if (world.down.has(env)) throw new Error("It did not answer in time");
        return method === "work.files.changed" ? { entries: world.changed.get(params.workspaceId) ?? [] } : { rev: 1, tabs: [] };
      },
      onPush: (listener: (push: unknown) => void) => {
        const set = world.pushes.get(env) ?? new Set();
        world.pushes.set(env, set.add(listener));
        return () => set.delete(listener);
      },
      onOpen: () => () => undefined,
      onClose: () => () => undefined,
    }),
    onLink: () => () => undefined,
  },
}));

import { openWorkView, workViewNow } from "../../lib/workSwitch";
import { projectStore } from "../../stores/project";
import { fileRows, source as files } from "./files";
import { dayBounds } from "./model";
import { TODAY_SOURCES } from "./sources";
import type { TodayEnv, TodayWorkspace } from "./types";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const job = (environmentId: string, sector: string, open = true): TodayWorkspace => ({ environmentId, workspaceId: `${environmentId}-${sector}`, sector: sector as TodayWorkspace["sector"], name: sector, path: `/w/${sector}`, open });
const JOBS = [job("box", "purdue"), job("mac", "hypixel")];
const entry = (key: string, name: string, kind: FileEntry["kind"], changed: number, by?: string): FileEntry => ({ key, ref: { at: "file", host: "h", path: `/files/${name}` }, folder: null, name, kind, changed, ...(by ? { by } : {}) });
const env = (): TodayEnv => ({ day: dayBounds(at(23, 9)), workspaces: JOBS, lifeos: { environmentId: "", sector: null, client: null, state: "off" }, workspaceOf: (sector) => JOBS.find((w) => w.sector === sector) ?? null });

beforeEach(() => {
  world.calls.length = 0;
  world.changed.clear();
  world.down.clear();
  world.pushes.clear();
  world.changed.set("box-purdue", [entry("k1", "FY27 budget.xlsx", "sheet", at(22, 21, 14), "Dana Reyes"), entry("k2", "Roster.docx", "document", at(18, 9), "Marcus Bell")]);
  world.changed.set("mac-hypixel", [entry("k3", "Trailer v3.mp4", "video", at(23, 8, 5), "Priya Nair")]);
});
afterEach(() => {
  cleanup();
  openWorkView(null);
});

describe("the files source", () => {
  it("stays off the page until Files' read is on master", () => {
    expect(TODAY_SOURCES.map((s) => s.id)).not.toContain("files");
  });

  it("asks each job's host once, and lists the files newest change first with who changed each and when", async () => {
    const e = env();
    const { result } = renderHook(() => files.use(e));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    expect(world.calls).toEqual([
      { env: "box", method: "work.files.changed", params: { workspaceId: "box-purdue" } },
      { env: "mac", method: "work.files.changed", params: { workspaceId: "mac-hypixel" } },
    ]);
    expect(result.current.rows!.map((r) => [r.key, r.title, r.detail, r.when, r.sector])).toEqual([
      ["file:k3", "Trailer v3.mp4", "Priya Nair", "8:05 AM", "hypixel"],
      ["file:k1", "FY27 budget.xlsx", "Dana Reyes", "Sun 9:14 PM", "purdue"],
      ["file:k2", "Roster.docx", "Marcus Bell", "Wed 9:00 AM", "purdue"],
    ]);
    // The lead is the file's kind; a file row has no verbs.
    expect(result.current.rows!.every((r) => r.lead?.kind === "glyph" && !r.acts)).toBe(true);
    expect(result.current.loading).toBeUndefined();
  });

  it("asks a job again on its work.files push, and a host that did not answer is named while the other's rows show", async () => {
    world.down.add("mac");
    const e = env();
    const { result } = renderHook(() => files.use(e));
    await waitFor(() => expect(result.current.failed?.map((f) => f.environmentId)).toEqual(["mac"]));
    expect(result.current.rows!.map((r) => r.key)).toEqual(["file:k1", "file:k2"]);
    world.changed.set("box-purdue", [entry("k1", "FY27 budget.xlsx", "sheet", at(22, 21, 14), "Dana Reyes")]);
    await act(async () => {
      for (const listener of world.pushes.get("box") ?? []) listener({ push: "work.files", workspaceId: "box-purdue" });
    });
    await waitFor(() => expect(result.current.rows!.map((r) => r.key)).toEqual(["file:k1"]));
    expect(world.calls.filter((c) => c.env === "box")).toHaveLength(2);
  });

  it("the press opens the file in a Files tab on its job's host, then shows that job's Files view", async () => {
    const e = env();
    const { result } = renderHook(() => files.use(e));
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    result.current.rows![0]!.open();
    await waitFor(() => expect(workViewNow()).toEqual({ workspaceId: "mac-hypixel", view: "files" }));
    expect(world.calls.at(-1)).toEqual({ env: "mac", method: "work.files.open", params: { workspaceId: "mac-hypixel", ref: { at: "file", host: "h", path: "/files/Trailer v3.mp4" }, name: "Trailer v3.mp4" } });
    expect(projectStore.getState().projectCwd).toBe("/w/hypixel");
  });

  it("a folder is no row, and a file with no author or time says only its name", () => {
    const rows = fileRows([{ workspace: JOBS[0]!, value: { entries: [{ key: "f", ref: null, folder: { at: "place", id: "p" }, name: "Budgets", kind: "folder" }, { key: "k9", ref: { at: "file", host: "h", path: "/x" }, folder: null, name: "Notes.txt", kind: "text" }] } }], at(23, 9), { open: () => {} });
    expect(rows.map((r) => [r.key, r.title, r.detail, r.when])).toEqual([["file:k9", "Notes.txt", undefined, undefined]]);
  });
});
