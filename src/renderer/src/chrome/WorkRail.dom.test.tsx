// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { registry, type Environment, type EnvironmentStatus, type Link } from "../lib/connection";
import type { ServerPush, WorkspaceMeta } from "../lib/tcserver/types";
import { sessionStore } from "../lib/tcserver/store";
import { workspaceStore } from "../lib/tcserver/workspaces";
import { setOutboxFailed, setOutboxWaiting, setWorkOn, workSwitch } from "../lib/workSwitch";
import { WORK_PLACE_ROWS } from "../lib/workPlaces";
import { shellStore } from "../stores/shell";
import { Clock } from "./icons";
import { onWorkSearch } from "../lib/workSearchPort";
import { mountProbe } from "../test/renderProbe";
import { ProjectRail } from "./ProjectRail";
import { SettingsNav } from "./SettingsRail";

/**
 * The rail and the settings list with the Work switch off and on (plan
 * milestone 8, architecture §15): off, a host's Work workspace is nowhere
 * and the rows are those of a host with no Work at all; on, it sits under
 * the Work heading led by its sector's dot, Work Chats sits after Chats,
 * and only then is Work's chunk asked for.
 */

const loads = vi.hoisted(() => ({ shell: 0 }));
vi.mock("../surfaces/chunks", async (importOriginal) => {
  const real = await importOriginal<typeof import("../surfaces/chunks")>();
  const preload = real.workShellChunk.preload;
  real.workShellChunk.preload = () => {
    loads.shell++;
    preload();
  };
  return real;
});

const LOCAL: Environment = { id: "local", name: "This Mac", routes: [], credentialRef: null };
const open: EnvironmentStatus = { transport: "open", fresh: true, lastHello: null, lastError: null, nextRetryAt: null, route: null, attempts: 0 };
const CODE = { id: "w-code", name: "temp-code", path: "/r/temp-code", git: true, createdAt: 1, environmentId: "local" } as WorkspaceMeta;
const WORK = { id: "w-work", name: "Purdue Esports", path: "/w/Work/Purdue Esports", git: false, createdAt: 2, kind: "work", sector: "purdue", environmentId: "local" } as WorkspaceMeta;

class FakeLink implements Link {
  profile = "local" as const;
  connected = true;
  readonly environmentId = "local";
  constructor(private readonly workspaces: WorkspaceMeta[]) {}
  request<T>(method: string): Promise<T> {
    if (method === "workspace.list") return Promise.resolve(this.workspaces as T);
    if (method === "project.list" || method === "session.list") return Promise.resolve([] as T);
    return Promise.resolve(null as T);
  }
  onPush(_listener: (push: ServerPush) => void): () => void {
    return () => {};
  }
  onOpen(): () => void {
    return () => {};
  }
  onClose(): () => void {
    return () => {};
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
let probe: ReturnType<typeof mountProbe> | null = null;
afterEach(() => {
  probe?.unmount();
  probe = null;
  sessionStore.reset();
  workspaceStore.reset();
  workSwitch.reset();
  localStorage.clear();
  loads.shell = 0;
  vi.restoreAllMocks();
});

async function mountRail(workspaces: WorkspaceMeta[], extra: { onOpenOutbox?: () => void } = {}) {
  vi.spyOn(registry, "environmentsSnapshot").mockReturnValue([LOCAL]);
  vi.spyOn(registry, "statuses").mockReturnValue(new Map([["local", open]]));
  vi.spyOn(registry, "statusOf").mockReturnValue(open);
  workspaceStore.attach(new FakeLink(workspaces));
  sessionStore.attach(new FakeLink(workspaces));
  await flush();
  probe = mountProbe(
    <ProjectRail
      cwd="~"
      recents={workspaces.map((w, i) => ({ path: w.path, openedAt: 10 - i }))}
      onSelectProject={() => {}}
      onOpenProject={() => {}}
      onOpenChats={() => {}}
      onOpenWorkChats={() => {}}
      onOpenNotes={() => {}}
      onOpenAccountsPage={() => {}}
      {...extra}
    />,
  );
  await probe.act(flush);
  return probe.container;
}

const headings = (root: HTMLElement) => [...root.querySelectorAll("nav [data-rail-heading]")].map((s) => s.textContent?.trim());
const rows = (root: HTMLElement) => [...root.querySelectorAll("nav [data-rail-path]")].map((row) => row.getAttribute("data-rail-path"));
const labels = (root: HTMLElement) => [...root.querySelectorAll("nav button")].map((b) => b.textContent?.trim()).filter(Boolean);

describe("the rail with Work off", () => {
  it("is the rail of a host with no Work: no Work heading, no Work row, no Work Chats, and no Work chunk", async () => {
    const withWork = await mountRail([CODE, WORK]);
    const shown = { headings: headings(withWork), rows: rows(withWork), labels: labels(withWork) };
    probe?.unmount();
    workspaceStore.reset();
    sessionStore.reset();
    const without = await mountRail([CODE]);
    expect(shown).toEqual({ headings: headings(without), rows: rows(without), labels: labels(without) });
    expect(shown.rows).toEqual([CODE.path]);
    expect(shown.headings).not.toContain("Work");
    expect(shown.labels).not.toContain("Work Chats");
    expect(withWork.querySelector('[aria-label="Search Work"]')).toBeNull();
    expect(loads.shell).toBe(0);
  });
});

describe("the rail with Work on", () => {
  it("lists a Work workspace under the Work heading, led by its sector's dot, never among the code workspaces", async () => {
    setWorkOn("local", true);
    const root = await mountRail([CODE, WORK]);
    expect(headings(root)).toEqual(["Workspaces", "Work"]);
    const work = root.querySelector(`[data-rail-path="${WORK.path}"]`)!;
    expect(work.querySelector('[data-sector="purdue"]')).not.toBeNull();
    // The code row keeps its glyph and the Work row offers no Pin (it has its own heading).
    expect(root.querySelector(`[data-rail-path="${CODE.path}"] [data-sector]`)).toBeNull();
    expect(work.querySelector('[aria-label="Pin workspace"]')).toBeNull();
    expect(root.querySelector('[aria-label="Add Work workspace"]')?.getAttribute("aria-haspopup")).toBe("menu");
    expect(loads.shell).toBeGreaterThan(0);
  });

  it("puts a search mark on the Work heading, before its +, that opens Work search; none while there is no job to search", async () => {
    setWorkOn("local", true);
    const heard: unknown[] = [];
    const off = onWorkSearch((seed) => heard.push(seed));
    const root = await mountRail([CODE, WORK]);
    const mark = root.querySelector<HTMLButtonElement>('[aria-label="Search Work"]')!;
    const add = root.querySelector('[aria-label="Add Work workspace"]')!;
    expect(mark.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mark.parentElement).toBe(add.parentElement);
    mark.click();
    expect(heard).toEqual([{}]);
    off();
    probe?.unmount();
    workspaceStore.reset();
    sessionStore.reset();
    const bare = await mountRail([CODE]);
    expect(bare.querySelector('[aria-label="Search Work"]')).toBeNull();
  });

  it("puts Work Chats after Chats, and draws no Outbox row with no page for it to open", async () => {
    setWorkOn("local", true);
    const root = await mountRail([CODE]);
    const names = labels(root);
    expect(names.indexOf("Work Chats")).toBe(names.indexOf("Chats") + 1);
    expect(names).not.toContain("Outbox");
    // With no Work workspace yet, the heading's own row adds the first: "Add workspace…" under Work, fitting the 200px rail, named in full for a screen reader.
    expect(names).toContain("Add workspace…");
    expect(root.querySelector('nav button[aria-label="Add Work workspace…"]')).toBeTruthy();
  });
});

describe("Review in the rail", () => {
  it("is listed under the Work heading while Work is on, with no count and no mark, and opens the review", async () => {
    setWorkOn("local", true);
    const root = await mountRail([CODE, WORK]);
    const review = [...root.querySelectorAll("nav button")].find((b) => b.textContent?.trim() === "Review") as HTMLButtonElement;
    expect(review).toBeTruthy();
    const heading = [...root.querySelectorAll("nav [data-rail-heading]")].find((h) => h.textContent?.trim() === "Work")!;
    const work = root.querySelector(`[data-rail-path="${WORK.path}"]`)!;
    expect(heading.compareDocumentPosition(review) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(review.compareDocumentPosition(work) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await probe!.act(async () => review.click());
    expect(shellStore.getState().workPlace).toBe("review");
    shellStore.setState({ workPlace: null });
  });
});

describe("the rail's Outbox row", () => {
  it("shows the waiting count, and the failed mark in its place while a send failed", async () => {
    setWorkOn("local", true);
    const root = await mountRail([CODE], { onOpenOutbox: () => {} });
    const row = () => [...root.querySelectorAll("nav button")].find((b) => b.textContent?.includes("Outbox"))!;
    // Whenever Work is on, with nothing waiting too: Sent and the grants are reached from it.
    expect(row()).toBeTruthy();
    await probe.act(async () => setOutboxWaiting(3));
    expect(row().textContent).toContain("3");
    await probe.act(async () => setOutboxFailed(1));
    expect(row().textContent).not.toContain("3");
    expect(row().querySelector('[data-status="failed"], [data-state="failed"]')).toBeTruthy();
    await probe.act(async () => {
      setOutboxFailed(0);
      setOutboxWaiting(0);
    });
  });
});

describe("the rail's rows for the pages above the Work workspaces", () => {
  // A row of the test's own, so the rule holds whichever pages master lists.
  const PLACE = { id: "probe-place", label: "Probe place", order: 5, icon: Clock };
  const listed = [...WORK_PLACE_ROWS];
  afterEach(() => {
    WORK_PLACE_ROWS.splice(0, WORK_PLACE_ROWS.length, ...listed);
    shellStore.setState({ workPlace: null });
  });

  it("draws none while Work is off: the rail is the one it was", async () => {
    const before = labels(await mountRail([CODE, WORK]));
    probe?.unmount();
    workspaceStore.reset();
    sessionStore.reset();
    WORK_PLACE_ROWS.push(PLACE);
    const after = labels(await mountRail([CODE, WORK]));
    expect(after).toEqual(before);
    expect(after).not.toContain("Probe place");
  });

  it("with Work on, a page's row leads the Work list, opens its page and is the selected row while it is open", async () => {
    setWorkOn("local", true);
    WORK_PLACE_ROWS.push(PLACE);
    const root = await mountRail([CODE, WORK]);
    const names = labels(root);
    // Under the Work heading, before the workspaces.
    expect(names.indexOf("Probe place")).toBeGreaterThan(names.indexOf("temp-code"));
    expect(names.indexOf("Probe place")).toBeLessThan(names.indexOf("Purdue Esports"));
    const row = () => [...root.querySelectorAll("nav button")].find((b) => b.textContent?.trim() === "Probe place") as HTMLButtonElement;
    expect(row().getAttribute("aria-current")).toBeNull();
    await probe!.act(async () => row().click());
    expect(shellStore.getState().workPlace).toBe("probe-place");
    expect(row().getAttribute("aria-current")).toBeTruthy();
    // The page covers the board: no workspace row reads as selected under it.
    expect(root.querySelector(`[data-rail-path="${WORK.path}"] [aria-current]`)).toBeNull();
  });

  it("with no Work workspace yet, the page's row sits over Add workspace…", async () => {
    setWorkOn("local", true);
    WORK_PLACE_ROWS.push(PLACE);
    const names = labels(await mountRail([CODE]));
    // Every page's row leads, in its order; the last of them sits right over Add workspace….
    expect(names.indexOf("Probe place")).toBeLessThan(names.indexOf("Add workspace…"));
    expect(WORK_PLACE_ROWS.map((row) => row.label)).toContain(names[names.indexOf("Add workspace…") - 1]);
  });
});

describe("the settings list", () => {
  it("keeps the Work page under its own heading, and lists a Work workspace there only while Work is on", async () => {
    vi.spyOn(registry, "environmentsSnapshot").mockReturnValue([LOCAL]);
    workspaceStore.attach(new FakeLink([CODE, WORK]));
    await flush();
    probe = mountProbe(<SettingsNav section="general" onSelect={() => {}} onClose={() => {}} />);
    const groups = () => [...probe!.container.querySelectorAll('[role="group"]')].map((g) => [...g.querySelectorAll("button")].map((b) => b.textContent?.trim()));
    const off = groups();
    expect(off.find((g) => g.includes("Work"))).toEqual(["Work"]);
    expect(off.flat()).not.toContain("Purdue Esports");
    probe.act(() => setWorkOn("local", true));
    const on = groups();
    expect(on.find((g) => g.includes("Work"))).toEqual(["Work", "Connections", "Purdue Esports"]);
    expect(on.find((g) => g.includes("temp-code"))).toEqual(["temp-code"]);
  });
});
