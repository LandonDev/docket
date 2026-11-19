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

const { Tasks } = await import("./TasksView");
const { newestOpenThread } = await import("./links");
const { workOpenPort } = await import("../../lib/workSwitch");

afterEach(cleanup);

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
    // A link to a thread this window does not know keeps Start.
    const waiting = screen.getByRole("button", { name: "Open Approve the scrim schedule" }).closest("[role=listitem]") as HTMLElement;
    expect(within(waiting).getByRole("button", { name: "Start" })).toBeTruthy();
    workOpenPort.set(null);
  });

  it("names the newest open link's thread, and none once its links are done", () => {
    expect(newestOpenThread([{ threadId: "a", state: "open", at: 1 }, { threadId: "b", state: "open", at: 2 }, { threadId: "c", state: "done", at: 3 }])).toBe("b");
    expect(newestOpenThread([{ threadId: "c", state: "done", at: 3 }])).toBeNull();
    expect(newestOpenThread(undefined)).toBeNull();
  });

  it("says when nothing is open", () => {
    render(<Tasks client={fakeTasksClient([])} startThread={() => {}} />);
    expect(screen.getByText("Nothing open")).toBeTruthy();
  });
});
