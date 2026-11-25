// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RowActions } from "../../chrome/WorkspaceSessions";
import type { SessionMeta } from "../../lib/tcserver/types";
import type { ProjectMeta } from "../../lib/tcserver/types";
import type { ProjectGroup } from "../../lib/workspaceSessions";
import { openWorkView, workViewNow } from "../../lib/workSwitch";
import type { ThreadRow } from "../../lib/workspaceSessions";

/**
 * A Work job's column under its views (docs/DESIGN.md "The column"): the Projects rows (the lead says what is live,
 * the end the target, paused and backlog behind one row, the heading opening the Projects view), the Threads rows
 * (two lines, newest first, the time gone while it works) and the archived row (a count, the list, Restore).
 */

const store = vi.hoisted(() => ({ metas: [] as SessionMeta[], asked: [] as string[] }));
vi.mock("../../lib/tcserver/store", async (original) => ({
  ...(await original<object>()),
  sessionStore: { ensureArchivedWork: (id: string) => (store.asked.push(id), Promise.resolve()), metas: () => store.metas, onMetaChange: () => () => {} },
}));
const CATALOG = vi.hoisted(() => ({ projects: [{ id: "m-lan", name: "Spring LAN", workspaceId: "w-job", environmentId: "local" }], workspaces: [{ id: "w-job", name: "Purdue Esports", path: "/w/Purdue Esports", kind: "work", environmentId: "local" }], loaded: true }));
vi.mock("../../lib/tcserver/workspaces", async (original) => {
  const real = await original<{ workspaceStore: object }>();
  return { ...real, workspaceStore: { ...real.workspaceStore, getSnapshot: () => CATALOG, subscribe: () => () => {} } };
});
const restored = vi.hoisted(() => [] as string[]);
vi.mock("../../lib/sessionStore", async (original) => ({ ...(await original<object>()), setSessionArchived: async (id: string, archived: boolean) => void (!archived && restored.push(id)) }));
vi.mock("../../lib/hoverPrefetch", async (original) => ({ ...(await original<object>()), whenIdle: (fn: () => void) => fn() }));

const { ArchivedRow, WorkProjectsSection, WorkThreadsSection } = await import("./WorkColumnRows");
const { setColumnProjects } = await import("./columnProjects");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  openWorkView(null);
  store.metas = [];
  store.asked = [];
  restored.length = 0;
});

const row = (over: Partial<ThreadRow> = {}): ThreadRow => ({
  id: "t",
  title: "Thread",
  status: "idle",
  updatedAt: Date.now(),
  unread: false,
  paused: false,
  running: false,
  failed: false,
  needsYou: false,
  busySince: null,
  threadType: "chat",
  frozenActiveElapsed: null,
  createdAt: 1,
  ...over,
});

const actions = (opened: string[] = []): RowActions => ({
  focusedTree: new Set(),
  onOpen: (id) => opened.push(id),
  onRename: () => {},
  menu: { rowsFor: () => [], onPick: () => {}, onOpenChange: () => {} },
  renamingId: null,
  onStartRename: () => {},
});

const day = (offset: number) => new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + offset).getTime();

describe("the Projects section", () => {
  const card = (id: string, name: string, threads: ThreadRow[] = []): ProjectGroup => ({
    project: { id: `lifeos:${id}`, name, workspaceId: "w-job", mode: "local", branch: null, cwd: "/w", archived: false, createdAt: 0, lifeosProjectId: id } as ProjectMeta,
    threads,
    latest: 0,
    archivedCount: 0,
  });
  const groups = [
    card("budget", "FY27 budget", [row({ status: "running", running: true })]),
    card("lan", "Spring LAN", [row({ workOutcome: { words: "1 mail to send", tone: "held" } })]),
    card("ask", "Alumni night", [row({ status: "waiting", needsYou: true })]),
    card("fall", "Fall league"),
    card("kit", "Club kit"),
  ];
  // As the column's head keeps them (WorkColumn.tsx `setColumnProjects`).
  setColumnProjects("w-job", [
    { id: "budget", name: "FY27 budget", status: "active", targetDate: day(-2) },
    { id: "lan", name: "Spring LAN", status: "active", targetDate: day(20) },
    { id: "ask", name: "Alumni night", status: "active", targetDate: null },
    { id: "fall", name: "Fall league", status: "paused", targetDate: null },
    { id: "kit", name: "Club kit", status: "backlog", targetDate: null },
  ]);
  const Section = (props: { linked?: boolean; groups?: ProjectGroup[]; onOpen?: (r: { id: string }) => void }) => (
    <WorkProjectsSection workspaceId="w-job" linked={props.linked ?? true} groups={props.groups ?? groups} onOpen={props.onOpen ?? (() => {})} />
  );

  it("leads each row with what is live (the spinner, the Outbox glyph muted, the amber mark) and ends it with its target, red once passed", () => {
    render(<Section />);
    const rows = [...document.querySelectorAll("[data-project-row]")];
    expect(rows.map((r) => r.textContent?.trim().split(/\s/)[0])).toEqual(["FY27", "Spring", "Alumni"]);
    expect(rows[0]!.querySelector('[data-slot="status-mark"]')!.getAttribute("data-state")).toBe("working");
    expect(rows[1]!.querySelector('[data-lead="held"]')!.getAttribute("class")).toContain("text-muted-foreground");
    expect(rows[1]!.querySelector('[data-slot="status-mark"]')).toBeNull();
    expect(rows[2]!.querySelector('[data-slot="status-mark"]')!.getAttribute("data-state")).toBe("waiting");
    expect(rows[0]!.querySelector("[data-rail-trailing] span")!.className).toContain("text-destructive");
    expect(rows[1]!.querySelector("[data-rail-trailing] span")!.className).not.toContain("text-destructive");
    expect(rows[2]!.querySelector("[data-rail-trailing]")).toBeNull();
    expect(screen.getByRole("button", { name: /FY27 budget, Working, late, was due/ })).toBeTruthy();
  });

  it("folds paused and backlog into one quiet row, counted each as the tracker says it, that shows them on a press", () => {
    render(<Section />);
    const fold = screen.getByRole("button", { name: "1 paused, 1 in backlog" });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Fall league")).toBeNull();
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Fall league")).toBeTruthy();
    expect(screen.getByText("Club kit")).toBeTruthy();
  });

  it("lights the project whose page shows, not the heading; the heading only while the list shows", () => {
    render(<Section />);
    act(() => openWorkView({ workspaceId: "w-job", view: "projects", project: "lan" }));
    expect(screen.getByRole("button", { name: /^Spring LAN/ }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: /^FY27 budget/ }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("button", { name: "Projects" }).getAttribute("aria-current")).toBeNull();
    act(() => openWorkView({ workspaceId: "w-job", view: "projects" }));
    expect(screen.getByRole("button", { name: /^Spring LAN/ }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("button", { name: "Projects" }).getAttribute("aria-current")).toBe("true");
  });

  it("opens a project's page from its row, and the job's Projects view from the heading, which then reads as open", () => {
    const opened: string[] = [];
    render(<Section onOpen={(r) => opened.push(r.id)} />);
    fireEvent.click(screen.getByRole("button", { name: /^Spring LAN/ }));
    expect(opened).toEqual(["lifeos:lan"]);
    const heading = screen.getByRole("button", { name: "Projects" });
    act(() => heading.click());
    expect(workViewNow()).toEqual({ workspaceId: "w-job", view: "projects" });
    expect(screen.getByRole("button", { name: "Projects" }).getAttribute("aria-current")).toBe("true");
    act(() => screen.getByRole("button", { name: "Projects" }).click());
    expect(workViewNow()).toBeNull();
  });

  it("is a plain heading in a job with no LifeOS sector, and nothing there with no project", () => {
    const { container, rerender } = render(<Section linked={false} />);
    expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy();
    rerender(<Section linked={false} groups={[]} />);
    expect(container.textContent).toBe("");
  });
});

describe("the Threads section", () => {
  const scope = { scope: "w-job", environmentIds: ["local"] };
  const items = [
    { row: row({ id: "held", title: "Ask ITaP for two switches", workOutcome: { words: "1 mail to send", tone: "held" } }), project: "Spring LAN" },
    { row: row({ id: "work", title: "Fill the travel lines", status: "running", running: true, workOutcome: { words: "Editing Budget FY27.xlsx", tone: "working" } }), project: "FY27 budget" },
    { row: row({ id: "done", title: "Reply to Dana", updatedAt: day(-1), workOutcome: { words: "Mail sent", tone: "done" } }), project: null },
    { row: row({ id: "bare", title: "Notes", updatedAt: day(-1) }), project: null },
  ];

  it("draws each thread on two lines, in the order given (newest first): title and time, then its project and outcome", () => {
    render(<WorkThreadsSection items={items} actions={actions()} requested={30} onMore={() => {}} archived={scope} />);
    const rows = [...document.querySelectorAll("[data-work-thread]")];
    expect(rows.map((r) => r.getAttribute("data-work-thread"))).toEqual(["held", "work", "done", "bare"]);
    expect(rows[0]!.textContent).toContain("Ask ITaP for two switches");
    expect(rows[0]!.textContent).toContain("Spring LAN, 1 mail to send");
    expect(rows[0]!.querySelector('[data-lead="held"]')).toBeTruthy();
    expect(rows[2]!.textContent).toContain("Mail sent");
    // A thread with neither a project nor an outcome is its first line alone.
    expect(rows[3]!.querySelectorAll(".text-xs.leading-4")).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "Threads" })).toBeTruthy();
  });

  it("drops the time while a thread works (the spinner says now) and keeps it otherwise", () => {
    render(<WorkThreadsSection items={items} actions={actions()} requested={30} onMore={() => {}} archived={scope} />);
    const [held, work] = [...document.querySelectorAll("[data-work-thread]")];
    expect(held!.querySelector(".tabular-nums")).toBeTruthy();
    expect(work!.querySelector('[data-slot="status-mark"]')!.getAttribute("data-state")).toBe("working");
    expect(work!.querySelector(".tabular-nums")).toBeNull();
  });

  it("opens a thread from its row, named with its state and its second line", () => {
    const opened: string[] = [];
    render(<WorkThreadsSection items={items} actions={actions(opened)} requested={30} onMore={() => {}} archived={scope} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask ITaP for two switches, Held, Spring LAN, 1 mail to send" }));
    expect(opened).toEqual(["held"]);
  });

  it("says a cut title and second line whole on focus, and draws no tip while nothing is cut", async () => {
    const focusTip = async () => {
      await act(async () => {
        document.querySelector<HTMLElement>('[data-work-thread="held"] [data-row-open]')!.focus();
        await new Promise((r) => setTimeout(r, 50));
      });
      return document.querySelector('[data-slot="tooltip-content"]');
    };
    const { tooltipChunk, warmTooltips } = await import("../../components/ui/tooltip");
    await act(async () => {
      await tooltipChunk.load();
      warmTooltips();
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
    const wide = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(100);
    const { unmount } = render(<WorkThreadsSection items={items.slice(0, 1)} actions={actions()} requested={30} onMore={() => {}} archived={scope} />);
    expect(await focusTip()).toBeNull();
    unmount();
    wide.mockImplementation(function (this: HTMLElement) {
      return this.textContent === "Spring LAN, 1 mail to send" ? 300 : 100;
    });
    render(<WorkThreadsSection items={items.slice(0, 1)} actions={actions()} requested={30} onMore={() => {}} archived={scope} />);
    expect((await focusTip())?.textContent).toBe("Ask ITaP for two switchesSpring LAN, 1 mail to send");
  });

  it("shows one page (32 rows), then N more", () => {
    const more = vi.fn();
    const many = Array.from({ length: 34 }, (_, i) => ({ row: row({ id: `t${i}`, title: `Thread ${i}` }), project: null }));
    render(<WorkThreadsSection items={many} actions={actions()} requested={32} onMore={more} archived={scope} />);
    expect(document.querySelectorAll("[data-work-thread]")).toHaveLength(32);
    fireEvent.click(screen.getByRole("button", { name: "2 more" }));
    expect(more).toHaveBeenCalled();
  });

  it("is nothing with no thread and nothing archived", () => {
    const { container } = render(<WorkThreadsSection items={[]} actions={actions()} requested={30} onMore={() => {}} archived={scope} />);
    expect(container.textContent).toBe("");
  });
});

describe("the archived row", () => {
  const meta = (over: Partial<SessionMeta>): SessionMeta =>
    ({ id: "x", title: "T", status: "idle", updatedAt: 1, createdAt: 1, cwd: "/w/Purdue Esports", environmentId: "local", scope: "work", archived: true, threadType: "chat", ...over }) as SessionMeta;

  it("asks the job's hosts for their archived Work threads, counts the job's (loose and in projects), and restores and opens a pick", async () => {
    store.metas = [meta({ id: "loose", title: "Old loose", workspaceId: "w-job", updatedAt: 2 }), meta({ id: "filed", title: "Old filed", projectId: "m-lan", updatedAt: 3 }), meta({ id: "chat", cwd: "~" })];
    const opened: string[] = [];
    render(<ArchivedRow scope={{ scope: "w-job", environmentIds: ["local"] }} onOpen={(id) => opened.push(id)} />);
    expect(store.asked).toEqual(["local"]);
    const trigger = screen.getByRole("button", { name: "2 archived" });
    await act(async () => trigger.click());
    const listed = [...document.querySelectorAll("[data-listed]")].map((el) => el.getAttribute("data-listed"));
    expect(listed).toEqual(["filed", "loose"]);
    await act(async () => (document.querySelector('[data-listed="loose"]') as HTMLElement).click());
    expect(restored).toEqual(["loose"]);
    expect(opened).toEqual(["loose"]);
  });

  it("lists Work Chats' own for Work Chats, and is nothing with none archived", () => {
    store.metas = [meta({ id: "chat", cwd: "~" })];
    const { container, rerender } = render(<ArchivedRow scope={{ scope: "~work", environmentIds: ["box"] }} onOpen={() => {}} />);
    expect(screen.getByRole("button", { name: "1 archived" })).toBeTruthy();
    store.metas = [];
    rerender(<ArchivedRow scope={{ scope: "~work", environmentIds: ["box"] }} onOpen={() => {}} />);
    expect(container.textContent).toBe("");
  });
});

describe("the column's LifeOS projects in Work's chunk", () => {
  it("tell their readers only when a project's name, state or target changed", async () => {
    const { renderHook } = await import("@testing-library/react");
    const { useColumnProjects } = await import("./columnProjects");
    let renders = 0;
    const rows = [{ id: "lan", name: "Spring LAN", status: "active", targetDate: null }];
    setColumnProjects("w-other", rows);
    const { result } = renderHook(() => (renders++, useColumnProjects("w-other")));
    const before = renders;
    act(() => setColumnProjects("w-other", rows.map((r) => ({ ...r }))));
    expect(renders).toBe(before);
    act(() => setColumnProjects("w-other", [{ ...rows[0]!, status: "paused" }]));
    expect(renders).toBe(before + 1);
    expect(result.current[0]!.status).toBe("paused");
  });
});
