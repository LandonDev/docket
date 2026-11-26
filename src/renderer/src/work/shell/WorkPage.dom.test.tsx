// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  defaults: new Map<string, { defaults: { permission: string } }>(),
  errors: new Map<string, string>(),
  loads: [] as string[],
}));
const JOBS = [
  { id: "j1", name: "Cosmic", kind: "work", sector: "cosmic", environmentId: "env_box" },
  { id: "j2", name: "Hypixel", kind: "work", sector: "hypixel", environmentId: "env_box" },
  { id: "j3", name: "Purdue Esports", kind: "work", sector: "purdue", environmentId: "env_pc" },
];
vi.mock("../../lib/tcserver/workspaces", async (original) => {
  const real = await original<typeof import("../../lib/tcserver/workspaces")>();
  return {
    ...real,
    scopeKey: (env: string, id: string) => `${env}:${id}`,
    useWorkspaces: () => JOBS,
    useWorkspaceCatalog: () => ({ defaults: store.defaults, defaultsErrors: store.errors }),
    workspaceStore: Object.assign(Object.create(real.workspaceStore), { loadDefaults: async (env: string, id: string) => void store.loads.push(`${env}:${id}`) }),
  };
});
vi.mock("../../lib/linkMay", async (original) => ({ ...(await original<object>()), useLinksMay: () => () => true }));
vi.mock("../../lib/settings/computerName", async (original) => {
  const real = await original<typeof import("../../lib/settings/computerName")>();
  const nameOf = (id: string) => ({ name: id === "env_box" ? "The box" : "PURDUE-LT", own: false });
  return { ...real, useComputerNames: () => nameOf, useComputerName: nameOf, useReadFailWords: (id: string) => (error: string) => real.readFailWords(error, nameOf(id)) };
});

const { JobsAccess } = await import("./WorkPage");
const { NO_ANSWER } = await import("../../lib/connection/openRead");

afterEach(() => {
  cleanup();
  store.defaults.clear();
  store.errors.clear();
});

describe("Access for each job's new threads", () => {
  it("keeps the jobs that answered and draws no row for one whose read failed: the failure line stands for it", () => {
    store.defaults.set("env_box:j1", { defaults: { permission: "edits" } });
    store.defaults.set("env_box:j2", { defaults: { permission: "edits" } });
    store.errors.set("env_pc:j3", NO_ANSWER);
    render(<JobsAccess />);
    expect([...document.querySelectorAll("[data-job]")].map((row) => row.getAttribute("data-job"))).toEqual(["j1", "j2"]);
    expect(screen.getByRole("alert").textContent).toBe("PURDUE-LT did not answer.");
    // The jobs that answered share a level: it is said once, under the heading.
    expect(screen.getByText("Auto-accept edits asks before anything but edits.")).toBeTruthy();
  });

  it("holds a job still out as its name and a bone, with no way in yet", () => {
    store.defaults.set("env_box:j1", { defaults: { permission: "edits" } });
    render(<JobsAccess />);
    const out = document.querySelector<HTMLElement>('[data-job="j3"]')!;
    expect(out.querySelector("[data-slot=skeleton]")).toBeTruthy();
    expect(out.querySelector("[data-slot=open-cue]")).toBeNull();
  });
});
