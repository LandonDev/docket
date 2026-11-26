// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  defaults: new Map<string, { defaults: { permission: string } }>(),
  errors: new Map<string, string>(),
  stale: new Map<string, string>(),
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
    useWorkspaceCatalog: () => ({ defaults: store.defaults, defaultsErrors: store.errors, defaultsStale: store.stale }),
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
  store.stale.clear();
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
    expect(screen.getAllByText("Auto-accept edits asks before anything but edits.")).toHaveLength(1);
  });

  it("says the level most jobs share once, and only a job on another level says its own", () => {
    store.defaults.set("env_box:j1", { defaults: { permission: "edits" } });
    store.defaults.set("env_box:j2", { defaults: { permission: "edits" } });
    store.defaults.set("env_pc:j3", { defaults: { permission: "auto" } });
    render(<JobsAccess />);
    expect(screen.getAllByText(/^Auto-accept edits/)).toHaveLength(1);
    expect(document.querySelector('[data-job="j1"]')!.textContent).toBe("Cosmic on the box");
    expect(document.querySelector('[data-job="j3"]')!.textContent).toContain("Full access");
  });

  it("says a failed refresh even while the job's earlier level is held, and keeps its row", () => {
    store.defaults.set("env_box:j1", { defaults: { permission: "edits" } });
    store.defaults.set("env_box:j2", { defaults: { permission: "edits" } });
    store.defaults.set("env_pc:j3", { defaults: { permission: "edits" } });
    store.stale.set("env_pc:j3", NO_ANSWER);
    render(<JobsAccess />);
    expect(screen.getByRole("alert").textContent).toBe("PURDUE-LT did not answer.");
    expect(document.querySelector('[data-job="j3"]')).toBeTruthy();
  });

  it("waits as one bone under the heading, each row its name alone as when loaded, and a job still out has no way in", () => {
    store.defaults.set("env_box:j1", { defaults: { permission: "edits" } });
    store.defaults.set("env_box:j2", { defaults: { permission: "auto" } });
    render(<JobsAccess />);
    expect(document.querySelectorAll("[data-slot=skeleton]")).toHaveLength(1);
    expect(document.querySelector("[data-job] [data-slot=skeleton]")).toBeNull();
    // No row says a line until all have answered: none jumps when the shared level lands.
    expect(document.querySelector('[data-job="j2"]')!.textContent).not.toContain("Full access");
    expect(document.querySelector('[data-job="j3"] [data-slot=open-cue]')).toBeNull();
  });

  it("names each job's computer when the jobs sit on more than one", () => {
    store.defaults.set("env_box:j1", { defaults: { permission: "edits" } });
    store.defaults.set("env_box:j2", { defaults: { permission: "edits" } });
    store.defaults.set("env_pc:j3", { defaults: { permission: "edits" } });
    render(<JobsAccess />);
    expect(document.querySelector('[data-job="j1"]')!.textContent).toBe("Cosmic on the box");
    expect(document.querySelector('[data-job="j3"]')!.textContent).toBe("Purdue Esports on PURDUE-LT");
  });
});
