// @vitest-environment jsdom
/**
 * A Work workspace's Tasks over the shared task client (work-kit/views),
 * answered from memory: the lead and the groups, Start thread with the task
 * as a chip, and Done through the client.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workTestClock } from "../testClock";
import { fakeTasksClient, type Task } from "work-kit/views";
import { keepPlace } from "../shell/place";
import { returnOf } from "../../lib/workReturn";

vi.mock("../../lib/tcserver/store", async (original) => ({
  ...(await original<object>()),
  // The window knows one thread, running: the one a link names for "Send Dana the budget".
  // th2 is at rest, holding a mail for his press; th3 at rest, its send failed.
  useSessionMeta: (id: string | null | undefined) =>
    id === "th1" ? { id: "th1", status: "running" } : id === "th2" ? { id: "th2", status: "idle", workOutcome: { tone: "held", words: "1 mail to send" } } : id === "th3" ? { id: "th3", status: "idle", workOutcome: { tone: "failed", words: "Outlook refused it" } } : null,
}));

// Open a code thread…: the rail lists two code workspaces on a host with Work on, one linked to Purdue.
const code = vi.hoisted(() => ({
  workspaces: [
    { id: "w-site", name: "site", path: "/r/site", git: true, createdAt: 1, environmentId: "env_mac", sector: "purdue" },
    { id: "w-app", name: "app", path: "/r/app", git: true, createdAt: 1, environmentId: "env_mac" },
  ],
  projects: [{ id: "p-api", workspaceId: "w-app", name: "api", mode: "local", branch: "main", cwd: "/r/app", archived: false, createdAt: 1, environmentId: "env_mac" }],
  /** `tasks:get`'s answer; undefined while it loads. */
  detail: { task: { description: "Ask for the east hall" } } as { task: { description: string } } | undefined,
  /** `tasks:get` failed: Convex's useQuery throws it. */
  fail: false,
}));
vi.mock("../../stores/project", async (original) => ({
  ...(await original<object>()),
  useRailRecents: () => [
    { path: "/r/site", openedAt: 2 },
    { path: "/r/app", openedAt: 1 },
  ],
}));
vi.mock("../../lib/tcserver/workspaces", async (original) => ({
  ...(await original<object>()),
  useWorkspaceCatalog: () => ({ loaded: true, workspaces: code.workspaces, projects: code.projects }),
}));
vi.mock("../../lib/workSwitch", async (original) => ({
  ...(await original<object>()),
  useWorkHosts: () => new Set(["env_mac"]),
}));
// The task's notes, as `tasks:get` reads them.
vi.mock("convex/react", async (original) => ({
  ...(await original<object>()),
  useQuery: () => {
    if (code.fail) throw new Error("LifeOS refused the read");
    return code.detail;
  },
}));

// Start thread on a task of a LifeOS project opens (or makes) its mirror on the host: here, at once.
const mirrors = vi.hoisted(() => ({ open: vi.fn(async (_w: unknown, id: string) => ({ id: `mirror-${id}` })) }));
vi.mock("../shell/actions", async (original) => ({ ...(await original<object>()), openLifeosProject: mirrors.open }));

const { Tasks, dueMidLine } = await import("./TasksView");
const { formatDue } = await import("work-kit/views/lib/format");
const { newestOpenThread } = await import("./links");
const { workOpenPort } = await import("../../lib/workSwitch");

beforeEach(() => void vi.useFakeTimers({ now, toFake: ["Date"] }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
// jsdom draws no layout: the picker's keyboard list scrolls its pick into view.
Element.prototype.scrollIntoView ??= () => {};

const now = workTestClock();
const local = new Date(now);
const due = (days: number, hour: number, minute: number) => new Date(local.getFullYear(), local.getMonth(), local.getDate() + days, hour, minute).getTime();
const rows: Task[] = [
  { _id: "t1", title: "Book the ballroom", sector: "purdue", status: "todo", projectId: "p1", dueAt: due(0, 23, 59) },
  { _id: "t2", title: "Send Dana the budget", sector: "purdue", status: "todo", dueAt: due(3, 12, 0) },
  { _id: "t3", title: "Approve the scrim schedule", sector: "purdue", status: "waiting", waitingOn: "Sam Ortiz" },
];

describe("the Tasks view", () => {
  it("leads with the first of Today, then the groups by name", () => {
    render(<Tasks client={fakeTasksClient(rows)} startThread={() => {}} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Book the ballroom");
    expect(screen.getByText("Spring LAN")).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["This week", "Waiting"]);
    expect(screen.getByText("Waiting on Sam Ortiz")).toBeTruthy();
  });

  it("says a late lead's due day in lower case after Due, as the rows' own label says it alone", () => {
    const late: Task = { _id: "t0", title: "Confirm the bus", sector: "purdue", status: "todo", dueAt: due(-1, 9, 0) };
    render(<Tasks client={fakeTasksClient([late, ...rows])} startThread={() => {}} />);
    expect(screen.getByText("Due yesterday")).toBeTruthy();
    expect(dueMidLine(due(1, 9, 0), now)).toBe("tomorrow");
    expect(dueMidLine(due(0, 15, 0), now)).toBe(formatDue(due(0, 15, 0), now));
  });

  it("keeps the lead's presses on the rows' column when narrow: Open gives way first, the task's menu holds it", () => {
    render(<Tasks client={fakeTasksClient(rows)} startThread={() => {}} />);
    const presses = document.querySelector<HTMLElement>("[data-lead-presses]")!;
    expect(presses.className).toContain("@container/leadpresses");
    const open = [...presses.querySelectorAll("button")].find((b) => b.textContent === "Open")!;
    expect(open.className).toContain("@max-[22rem]/leadpresses:hidden");
    // Start thread, Done and Snooze never give way.
    for (const name of ["Start thread", "Done", "Snooze"]) expect([...presses.querySelectorAll("button")].find((b) => b.textContent === name)!.className).not.toContain("hidden");
  });

  it("draws a one-line row at 32px, so it sits centred among the two-line rows", () => {
    render(<Tasks client={fakeTasksClient(rows)} startThread={() => {}} />);
    const row = screen.getByRole("button", { name: "Open Send Dana the budget" }).closest<HTMLElement>("[role=listitem]")!;
    expect(row.className).toContain("min-h-8");
    expect(row.className).not.toContain("min-h-11");
  });

  it("opens the sheet of a task a person's page asks for", async () => {
    render(<Tasks client={fakeTasksClient(rows)} startThread={() => {}} openTask={{ id: "t3" }} />);
    const dialog = await screen.findByRole("dialog");
    // The sheet reads the task from LifeOS (`tasks:get`): here its notes stand in.
    expect(within(dialog).getByText("Ask for the east hall")).toBeTruthy();
  });

  it("starts a thread with the task as its chip, and nothing else", () => {
    const startThread = vi.fn();
    render(<Tasks client={fakeTasksClient(rows)} startThread={startThread} />);
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(startThread).toHaveBeenCalledWith({ kind: "task", label: "Book the ballroom", ref: { at: "lifeos", table: "tasks", id: "t1" } });
  });

  it("files a task of a LifeOS project under the project's mirror, from the lead and from its sheet", async () => {
    const startThread = vi.fn();
    const place = { id: "ws-purdue", environmentId: "box", path: "/w/Purdue" };
    render(<Tasks client={fakeTasksClient(rows)} startThread={startThread} place={place} />);
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    await act(async () => {});
    const chip = { kind: "task", label: "Book the ballroom", ref: { at: "lifeos", table: "tasks", id: "t1" } };
    expect(mirrors.open).toHaveBeenCalledWith(place, "p1", "Spring LAN");
    expect(startThread).toHaveBeenCalledWith(chip, { cwd: "/w/Purdue", projectId: "mirror-p1" });
    // A task with no project starts loose, as before.
    fireEvent.click(screen.getByRole("button", { name: "Open Send Dana the budget" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Start thread" }));
    await act(async () => {});
    expect(startThread).toHaveBeenLastCalledWith({ kind: "task", label: "Send Dana the budget", ref: { at: "lifeos", table: "tasks", id: "t2" } });
  });

  it("marks a row done after its tick holds, through the client", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ now });
    const client = fakeTasksClient(rows);
    render(<Tasks client={client} startThread={() => {}} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Mark Send Dana the budget done" }));
    expect(client.acts).toEqual([]);
    await act(async () => void vi.advanceTimersByTime(400));
    expect(client.acts).toEqual(["complete t2"]);
    vi.useRealTimers();
  });

  it("opens a row through one button over the whole row, so keyboard focus rings the row", () => {
    render(<Tasks client={fakeTasksClient(rows)} startThread={() => {}} />);
    const open = screen.getByRole("button", { name: "Open Send Dana the budget" });
    expect(open.hasAttribute("data-row-open")).toBe(true);
    expect(open.closest("[role=listitem]")?.contains(screen.getByRole("checkbox", { name: "Mark Send Dana the budget done" }))).toBe(true);
    expect(open.contains(screen.getByText("Send Dana the budget"))).toBe(false);
  });

  it("a task a thread works on shows the thread's mark and Open thread in Start's place", () => {
    const opened: string[] = [];
    workOpenPort.set((id) => void opened.push(id));
    const startThread = vi.fn();
    render(<Tasks client={fakeTasksClient(rows)} startThread={startThread} useThread={(id) => (id === "t2" ? "th1" : id === "t3" ? "gone" : null)} />);
    const row = screen.getByRole("button", { name: "Open Send Dana the budget" }).closest("[role=listitem]") as HTMLElement;
    expect(row.querySelector("[data-task-thread=working]")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Open thread" }));
    expect(opened).toEqual(["th1"]);
    expect(startThread).not.toHaveBeenCalled();
    // The lead (Book the ballroom) leads its Open thread with the thread's mark too.
    expect(document.querySelector("[data-lead-thread]")).toBeNull();
    workOpenPort.set(null);
  });

  it("a link to a thread the window holds no meta for yet offers Open thread, never Start, and Open asks the hosts for it first", async () => {
    const opened: string[] = [];
    workOpenPort.set((id) => void opened.push(id));
    const { sessionStore } = await import("../../lib/tcserver/store");
    const ensure = vi.spyOn(sessionStore, "ensureMeta").mockResolvedValue({ id: "gone" } as never);
    const startThread = vi.fn();
    render(<Tasks client={fakeTasksClient(rows)} startThread={startThread} useThread={(id) => (id === "t3" ? "gone" : null)} />);
    const waiting = screen.getByRole("button", { name: "Open Approve the scrim schedule" }).closest("[role=listitem]") as HTMLElement;
    expect(within(waiting).queryByRole("button", { name: "Start" })).toBeNull();
    // No mark while its state is unknown.
    expect(waiting.querySelector("[data-task-thread]")).toBeNull();
    fireEvent.click(within(waiting).getByRole("button", { name: "Open thread" }));
    await act(async () => {});
    expect(ensure).toHaveBeenCalledWith("gone");
    expect(opened).toEqual(["gone"]);
    // Its sheet says the same.
    fireEvent.click(screen.getByRole("button", { name: "Open Approve the scrim schedule" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).queryByRole("button", { name: "Start thread" })).toBeNull();
    expect(within(sheet).getByRole("button", { name: "Open thread" })).toBeTruthy();
    expect(startThread).not.toHaveBeenCalled();
    ensure.mockRestore();
    workOpenPort.set(null);
  });

  it("marks a task by what its thread left him first, as the project's plan does: the Outbox glyph for held, red for failed", () => {
    render(<Tasks client={fakeTasksClient(rows)} startThread={() => {}} useThread={(id) => (id === "t1" ? "th3" : id === "t2" ? "th2" : null)} />);
    const row = screen.getByRole("button", { name: "Open Send Dana the budget" }).closest("[role=listitem]") as HTMLElement;
    expect(row.querySelector("[data-task-thread=held] [data-outcome=held]")).toBeTruthy();
    expect(document.querySelector("[data-lead-thread=failed]")).toBeTruthy();
  });

  it("offers neither Start nor Open thread while a task's link read has not answered", () => {
    const startThread = vi.fn();
    render(<Tasks client={fakeTasksClient(rows)} startThread={startThread} useThread={() => undefined} />);
    const row = screen.getByRole("button", { name: "Open Send Dana the budget" }).closest("[role=listitem]") as HTMLElement;
    expect(within(row).queryByRole("button", { name: "Start" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Open thread" })).toBeNull();
    // The lead keeps the press's place, out of reach, so Done does not move when the answer comes.
    expect(screen.queryByRole("button", { name: "Start thread" })).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(startThread).not.toHaveBeenCalled();
  });
  it("the task's sheet, too, offers neither Start nor Open thread while the link read has not answered", async () => {
    render(<Tasks client={fakeTasksClient(rows)} startThread={() => {}} useThread={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Send Dana the budget" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).queryByRole("button", { name: "Start thread" })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Open thread" })).toBeNull();
    expect(within(sheet).getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it("leads the lead task's Open thread with its thread's mark", () => {
    render(<Tasks client={fakeTasksClient(rows)} startThread={() => {}} useThread={(id) => (id === "t1" ? "th1" : null)} />);
    const mark = document.querySelector("[data-lead-thread=working]") as HTMLElement;
    expect(mark).toBeTruthy();
    expect(mark.nextElementSibling?.textContent).toBe("Open thread");
  });

  it("names the newest open link's thread, and none once its links are done", () => {
    expect(newestOpenThread([{ threadId: "a", state: "open", at: 1 }, { threadId: "b", state: "open", at: 2 }, { threadId: "c", state: "done", at: 3 }])).toBe("b");
    expect(newestOpenThread([{ threadId: "c", state: "done", at: 3 }])).toBeNull();
    expect(newestOpenThread(undefined)).toBeNull();
  });

  it("opens a code thread from a row's menu in the workspace picked, the notes as text where it cannot read LifeOS", async () => {
    const startThread = vi.fn();
    render(<Tasks client={fakeTasksClient(rows)} sector="purdue" startThread={startThread} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Open Send Dana the budget" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open a code thread…" }));
    const dialog = await screen.findByRole("dialog");
    // The rail's code rows, in its order; the first is the pick, and it has no projects to offer.
    const options = within(dialog).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["site", "app"]);
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    expect(within(dialog).queryByText("Project")).toBeNull();
    // The search narrows the list; app is not linked to Purdue, so it is handed the notes.
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Workspace" }), { target: { value: "ap" } });
    expect(within(dialog).getAllByRole("option").map((o) => o.textContent)).toEqual(["app"]);
    expect(within(dialog).getByText("Project")).toBeTruthy();
    fireEvent.submit(dialog.querySelector("form")!);
    expect(startThread).toHaveBeenCalledWith(
      { kind: "task", label: "Send Dana the budget", ref: { at: "lifeos", table: "tasks", id: "t2" }, quote: "Ask for the east hall" },
      { cwd: "/r/app", projectId: null },
    );
  });

  it("waits for the task's notes when Start comes first, then starts with them", async () => {
    const startThread = vi.fn();
    const notes = code.detail;
    code.detail = undefined;
    try {
      const view = render(<Tasks client={fakeTasksClient(rows)} sector="purdue" startThread={startThread} />);
      fireEvent.contextMenu(screen.getByRole("button", { name: "Open Send Dana the budget" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Open a code thread…" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("option", { name: "app" }));
      fireEvent.submit(dialog.querySelector("form")!);
      expect(startThread).not.toHaveBeenCalled();
      code.detail = notes;
      view.rerender(<Tasks client={fakeTasksClient(rows)} sector="purdue" startThread={startThread} />);
      await act(async () => {});
      expect(startThread.mock.calls[0]![0].quote).toBe("Ask for the east hall");
    } finally {
      code.detail = notes;
    }
  });

  it("spins Start alone while it waits for the notes, Cancel live, and after five seconds starts with the title alone", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ now, shouldAdvanceTime: true });
    const startThread = vi.fn();
    const notes = code.detail;
    code.detail = undefined;
    try {
      render(<Tasks client={fakeTasksClient(rows)} sector="purdue" startThread={startThread} />);
      fireEvent.contextMenu(screen.getByRole("button", { name: "Open Send Dana the budget" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Open a code thread…" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("option", { name: "app" }));
      fireEvent.submit(dialog.querySelector("form")!);
      const start = within(dialog).getByRole("button", { name: "Start" });
      expect(start.hasAttribute("disabled")).toBe(true);
      expect(start.querySelector("[data-busy]")).not.toBeNull();
      expect(within(dialog).getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(false);
      expect(startThread).not.toHaveBeenCalled();
      await act(async () => void vi.advanceTimersByTime(5_000));
      expect(startThread).toHaveBeenCalledOnce();
      expect(startThread.mock.calls[0]![0]).toEqual({ kind: "task", label: "Send Dana the budget", ref: { at: "lifeos", table: "tasks", id: "t2" } });
    } finally {
      code.detail = notes;
      vi.useRealTimers();
    }
  });

  it("starts with the title alone when the notes' read failed", async () => {
    const startThread = vi.fn();
    code.fail = true;
    try {
      render(<Tasks client={fakeTasksClient(rows)} sector="purdue" startThread={startThread} />);
      fireEvent.contextMenu(screen.getByRole("button", { name: "Open Send Dana the budget" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Open a code thread…" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("option", { name: "app" }));
      fireEvent.submit(dialog.querySelector("form")!);
      expect(startThread).toHaveBeenCalledWith({ kind: "task", label: "Send Dana the budget", ref: { at: "lifeos", table: "tasks", id: "t2" } }, { cwd: "/r/app", projectId: null });
    } finally {
      code.fail = false;
    }
  });

  it("gives a code workspace linked to the task's sector the task alone, from the lead's menu too", async () => {
    const startThread = vi.fn();
    render(<Tasks client={fakeTasksClient(rows)} sector="purdue" startThread={startThread} />);
    fireEvent.contextMenu(screen.getByRole("heading", { level: 1 }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open a code thread…" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("option", { name: "site" }));
    fireEvent.submit(dialog.querySelector("form")!);
    expect(startThread).toHaveBeenCalledWith({ kind: "task", label: "Book the ballroom", ref: { at: "lifeos", table: "tasks", id: "t1" } }, { cwd: "/r/site", projectId: null });
  });

  it("starts each group's heading on its rows' title edge, past the tick", () => {
    render(<Tasks client={fakeTasksClient(rows)} startThread={() => {}} />);
    for (const h of screen.getAllByRole("heading", { level: 2 })) expect(h.className).toContain("ps-9");
  });

  it("loads in the list's own shape: the lead's presses, a heading on the title edge, then rows", () => {
    const { container } = render(<Tasks client={{ ...fakeTasksClient(rows), useOpenTasks: () => undefined }} startThread={() => {}} />);
    const bones = container.querySelector("[data-tasks-bones]")!;
    expect(bones.querySelector("[data-bones-presses]")).not.toBeNull();
    expect(bones.querySelector("[data-bones-heading]")!.className).toContain("ps-9");
  });

  it("says when nothing is open", () => {
    render(<Tasks client={fakeTasksClient([])} startThread={() => {}} />);
    expect(screen.getByText("Nothing open")).toBeTruthy();
  });
});

describe("Tasks coming back", () => {
  afterEach(() => localStorage.clear());

  it("opens the sheet of the task he left open, and keeps the one he opens", async () => {
    keepPlace("ws", "tasks", { task: "t3" });
    render(<Tasks client={fakeTasksClient(rows)} startThread={() => {}} workspaceId="ws" />);
    expect(within(await screen.findByRole("dialog")).getByText("Ask for the east hall")).toBeTruthy();
    cleanup();
    localStorage.clear();
    render(<Tasks client={fakeTasksClient(rows)} startThread={() => {}} openTask={{ id: "t1" }} workspaceId="ws2" />);
    await screen.findByRole("dialog");
    expect(returnOf("ws2").places?.tasks).toEqual({ task: "t1" });
  });

  it("a task done since opens nothing, quietly", async () => {
    keepPlace("ws", "tasks", { task: "gone" });
    render(<Tasks client={fakeTasksClient(rows)} startThread={() => {}} workspaceId="ws" />);
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(returnOf("ws").places?.tasks).toEqual({});
  });
});
