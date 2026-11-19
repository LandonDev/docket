// @vitest-environment jsdom
/**
 * A Work workspace's Tasks over the shared task client (work-kit/views),
 * answered from memory: the lead and the groups, Start thread with the task
 * as a chip, and Done through the client.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeTasksClient, type Task } from "work-kit/views";

vi.mock("../../lib/tcserver/store", async (original) => ({
  ...(await original<object>()),
  // The window knows one thread, running: the one a link names for "Send Dana the budget".
  useSessionMeta: (id: string | null | undefined) => (id === "th1" ? { id: "th1", status: "running" } : null),
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
  useQuery: () => code.detail,
}));

const { Tasks } = await import("./TasksView");
const { newestOpenThread } = await import("./links");
const { workOpenPort } = await import("../../lib/workSwitch");

afterEach(cleanup);
// jsdom draws no layout: the picker's keyboard list scrolls its pick into view.
Element.prototype.scrollIntoView ??= () => {};

const now = Date.now();
const rows: Task[] = [
  { _id: "t1", title: "Book the ballroom", sector: "purdue", status: "todo", projectId: "p1", dueAt: now + 3_600_000 },
  { _id: "t2", title: "Send Dana the budget", sector: "purdue", status: "todo", dueAt: now + 3 * 86_400_000 },
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

  it("starts a thread with the task as its chip, and nothing else", () => {
    const startThread = vi.fn();
    render(<Tasks client={fakeTasksClient(rows)} startThread={startThread} />);
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(startThread).toHaveBeenCalledWith({ kind: "task", label: "Book the ballroom", ref: { at: "lifeos", table: "tasks", id: "t1" } });
  });

  it("marks a row done after its tick holds, through the client", async () => {
    vi.useFakeTimers();
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
    // A link to a thread this window does not know keeps Start.
    const waiting = screen.getByRole("button", { name: "Open Approve the scrim schedule" }).closest("[role=listitem]") as HTMLElement;
    expect(within(waiting).getByRole("button", { name: "Start" })).toBeTruthy();
    workOpenPort.set(null);
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

  it("says when nothing is open", () => {
    render(<Tasks client={fakeTasksClient([])} startThread={() => {}} />);
    expect(screen.getByText("Nothing open")).toBeTruthy();
  });
});
