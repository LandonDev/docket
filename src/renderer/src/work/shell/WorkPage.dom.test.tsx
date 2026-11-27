// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  defaults: new Map<string, { defaults: { permission: string } }>(),
  errors: new Map<string, string>(),
  stale: new Map<string, string>(),
  loads: [] as string[],
  /** A read held open until the test lets it go. */
  gate: null as null | Promise<void>,
  /** The jobs listed, when a test lists other than JOBS. */
  jobs: null as null | { id: string; name: string; kind: string; sector: string; environmentId: string }[],
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
    useWorkspaces: () => store.jobs ?? JOBS,
    useWorkspaceCatalog: () => ({ defaults: store.defaults, defaultsErrors: store.errors, defaultsStale: store.stale }),
    workspaceStore: Object.assign(Object.create(real.workspaceStore), { loadDefaults: async (env: string, id: string) => {
      store.loads.push(`${env}:${id}`);
      await store.gate;
    } }),
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
  store.jobs = null;
  store.gate = null;
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

  it("draws one computer's jobs alone on that computer's page, each a way into its New threads", () => {
    store.defaults.set("env_box:j1", { defaults: { permission: "edits" } });
    store.defaults.set("env_box:j2", { defaults: { permission: "edits" } });
    store.defaults.set("env_pc:j3", { defaults: { permission: "auto" } });
    render(<JobsAccess computer="env_pc" />);
    expect([...document.querySelectorAll("[data-job]")].map((row) => row.getAttribute("data-job"))).toEqual(["j3"]);
    expect(document.querySelector('section[data-setting="pc.jobs"]')).toBeTruthy();
    // One computer's page: its jobs need no computer named, and its one level is said once.
    expect(document.querySelector('[data-job="j3"]')!.textContent).toBe("Purdue Esports");
    expect(screen.getByRole("button", { name: "New threads in Purdue Esports" })).toBeTruthy();
  });

  it("puts Find a job over more than eight jobs, on Work and on a computer's page, each found row still opening its dialog", () => {
    store.jobs = Array.from({ length: 10 }, (_, i) => ({ id: `k${i}`, name: i === 4 ? "Purdue Esports" : `Job ${i}`, kind: "work", sector: "life", environmentId: "env_box" }));
    for (const job of store.jobs) store.defaults.set(`env_box:${job.id}`, { defaults: { permission: "edits" } });
    for (const computer of [undefined, "env_box"]) {
      render(<JobsAccess computer={computer} />);
      const find = screen.getByRole("searchbox", { name: "Find a job" });
      fireEvent.change(find, { target: { value: "purdue" } });
      expect([...document.querySelectorAll("[data-job]")].map((row) => row.getAttribute("data-job"))).toEqual(["k4"]);
      expect(screen.getByRole("button", { name: "New threads in Purdue Esports" })).toBeTruthy();
      cleanup();
    }
    // Eight or fewer: no field.
    store.jobs = store.jobs.slice(0, 8);
    render(<JobsAccess />);
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("says a filtered list's only, failed match once, at the list, with one Retry that stays busy until its read settles", async () => {
    store.jobs = Array.from({ length: 10 }, (_, i) => ({ id: `k${i}`, name: i === 4 ? "Purdue Esports" : `Job ${i}`, kind: "work", sector: "life", environmentId: "env_box" }));
    for (const job of store.jobs) if (job.id !== "k4") store.defaults.set(`env_box:${job.id}`, { defaults: { permission: "edits" } });
    store.errors.set("env_box:k4", NO_ANSWER);
    render(<JobsAccess />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Find a job" }), { target: { value: "purdue" } });
    expect(document.querySelectorAll("[data-job]")).toHaveLength(0);
    // One failure on the page, the list's own: the page's head does not say it again.
    expect(screen.getAllByRole("alert").map((line) => line.textContent)).toEqual(["Purdue Esports: The box did not answer."]);
    const line = () => document.querySelector<HTMLElement>("[data-missed]")!.closest<HTMLElement>("[data-slot=page-error-line]")!;
    expect(within(line()).getAllByRole("button")).toHaveLength(1);
    let let_go!: () => void;
    store.gate = new Promise<void>((done) => (let_go = done));
    store.loads.length = 0;
    // The retry clears the store's error at once (loadDefaults); the line and its busy Retry stay until it settles.
    store.errors.delete("env_box:k4");
    await act(async () => fireEvent.click(within(line()).getByRole("button", { name: "Retry" })));
    expect(store.loads).toEqual(["env_box:k4"]);
    expect(line().textContent).toContain("Purdue Esports: The box did not answer.");
    expect((within(line()).getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    store.defaults.set("env_box:k4", { defaults: { permission: "edits" } });
    await act(async () => {
      let_go();
      await store.gate;
    });
    expect(document.querySelector("[data-missed]")).toBeNull();
    expect([...document.querySelectorAll("[data-job]")].map((row) => row.getAttribute("data-job"))).toEqual(["k4"]);
  });

  it("keeps Retry's busy state and words with the jobs it asked: a filter change mid-retry shows the other job's own failure and Retry", async () => {
    store.jobs = Array.from({ length: 10 }, (_, i) => ({ id: `k${i}`, name: i === 4 ? "Purdue Esports" : i === 7 ? "Purdue Club" : `Job ${i}`, kind: "work", sector: "life", environmentId: "env_box" }));
    for (const job of store.jobs) if (job.id !== "k4" && job.id !== "k7") store.defaults.set(`env_box:${job.id}`, { defaults: { permission: "edits" } });
    store.errors.set("env_box:k4", NO_ANSWER);
    store.errors.set("env_box:k7", "Refused: the key may not read it");
    render(<JobsAccess />);
    const find = screen.getByRole("searchbox", { name: "Find a job" });
    const line = () => document.querySelector<HTMLElement>("[data-missed]")!.closest<HTMLElement>("[data-slot=page-error-line]")!;
    fireEvent.change(find, { target: { value: "esports" } });
    let let_go!: () => void;
    store.gate = new Promise<void>((done) => (let_go = done));
    store.loads.length = 0;
    store.errors.delete("env_box:k4");
    await act(async () => fireEvent.click(within(line()).getByRole("button", { name: "Retry" })));
    expect((within(line()).getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    // Mid-retry, a query for the other failed job: its own words, its own Retry, nothing of the first job's.
    fireEvent.change(find, { target: { value: "club" } });
    expect(line().textContent).toContain("Purdue Club: Refused: the key may not read it.");
    expect(line().textContent).not.toContain("Purdue Esports");
    expect((within(line()).getByRole("button") as HTMLButtonElement).disabled).toBe(false);
    // Back to the first: still its words, still busy.
    fireEvent.change(find, { target: { value: "esports" } });
    expect(document.querySelector("[data-missed]")!.textContent).toBe("Purdue Esports: The box did not answer.");
    expect((within(line()).getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    // Its read fails again: its failure stands with Retry ready.
    store.errors.set("env_box:k4", NO_ANSWER);
    await act(async () => {
      let_go();
      await store.gate;
    });
    expect(document.querySelector("[data-missed]")!.textContent).toBe("Purdue Esports: The box did not answer.");
    expect((within(line()).getByRole("button") as HTMLButtonElement).disabled).toBe(false);
    expect(store.loads).toEqual(["env_box:k4"]);
  });

  it("marks a level held over a failed refresh as last read, and counts only current levels toward the heading", () => {
    store.defaults.set("env_box:j1", { defaults: { permission: "edits" } });
    store.defaults.set("env_box:j2", { defaults: { permission: "auto" } });
    store.defaults.set("env_pc:j3", { defaults: { permission: "auto" } });
    store.stale.set("env_pc:j3", NO_ANSWER);
    render(<JobsAccess />);
    // Two jobs answered and disagree: no shared level, each says its own; the held one says it is the last read.
    expect(document.querySelector('[data-job="j3"]')!.textContent).toContain("Full access, as last read");
    expect(document.querySelector('[data-job="j2"]')!.textContent).toContain("Full access");
    expect(document.querySelector('[data-job="j2"]')!.textContent).not.toContain("as last read");
    expect(screen.queryByText(/^Full access asks/, { selector: "section > p" })).toBeNull();
  });

  it("reads the set of a job pushed into the list while it is open", () => {
    const { rerender } = render(<JobsAccess />);
    store.loads.length = 0;
    store.jobs = [...JOBS, { id: "j4", name: "Unify", kind: "work", sector: "unify", environmentId: "env_box" }];
    rerender(<JobsAccess />);
    expect(store.loads).toContain("env_box:j4");
  });
});
