// @vitest-environment jsdom
/**
 * TempCode's fill of the kit's thread slots (kit.tsx, docs/agents/work-tracker.md "The slots"): every open link's
 * mark on a task, the project's threads in its Log, the files they made in its Files, and each project's lead thread
 * for the list's Threads column. The window's summaries are faked at their one seam (work/threads/roots.ts); the
 * record a thread's files come from is the host's answer.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectTask } from "work-kit/projects";
import type { RecordMade, ThreadRecord } from "@shared/work/threadRecord";
import type { TrackerThread } from "@shared/work/tracker";
import { sessionStore } from "../../lib/tcserver/store";
import { workOpenPort } from "../../lib/workSwitch";

const seam = vi.hoisted(() => ({
  roots: new Map<string, unknown[]>(),
  links: [] as string[],
  metas: {} as Record<string, { status: string; title: string; workOutcome?: { words: string; tone: string } | null }>,
  records: {} as Record<string, Partial<ThreadRecord>>,
  reads: [] as string[],
  files: [] as unknown[],
}));
vi.mock("../threads/roots", async (original) => ({ ...(await original<object>()), useProjectRoots: () => seam.roots }));
vi.mock("../tasks/links", () => ({ useLinkedThreads: () => seam.links, useLinkedThread: () => seam.links[0] ?? null }));
vi.mock("../../lib/tcserver/store", async (original) => ({
  ...(await original<object>()),
  useSessionMetaValue: (id: string, read: (meta: unknown) => unknown) => (seam.metas[id] ? read(seam.metas[id]) : undefined),
}));
vi.mock("../threads/record", () => ({
  readThreadRecord: async (_env: string, sessionId: string) => {
    seam.reads.push(sessionId);
    return { sessionId, workspaceId: "ws", waits: [], works: [], made: [], outcome: null, ...seam.records[sessionId] };
  },
}));
vi.mock("../files/openFrom", () => ({ openInFiles: async (workspace: unknown, what: unknown) => void seam.files.push({ workspace, what }) }));

const { projectsKitFor, useThreadFacts, useThreadFiles, useThreadLog } = await import("./kit");

const thread = (sessionId: string, updatedAt: number, outcome: TrackerThread["outcome"] = null): TrackerThread => ({ sessionId, title: `Thread ${sessionId}`, updatedAt, outcome });
const made = (id: string, sessionId: string, at: number, over: Partial<RecordMade> = {}): RecordMade => ({
  id,
  sessionId,
  kind: "file.make",
  verb: "Made",
  name: `${id}.xlsx`,
  summary: "",
  at,
  undone: false,
  open: { at: "files", workspaceId: "ws", ref: { at: "work", workspaceId: "ws", path: `${id}.xlsx` } as never, name: `${id}.xlsx` },
  ...over,
});
const LAN = { id: "p-lan", sector: "purdue" } as const;

let opened: string[];
beforeEach(() => {
  opened = [];
  workOpenPort.set((id) => void opened.push(id));
  seam.roots = new Map();
  seam.links = [];
  seam.metas = {};
  seam.records = {};
  seam.reads = [];
  seam.files = [];
  vi.spyOn(sessionStore, "environmentOf").mockReturnValue("env_box");
});
afterEach(() => {
  cleanup();
  workOpenPort.set(null);
  vi.restoreAllMocks();
});

describe("the kit's thread slots", () => {
  it("taskMark draws every open link's thread, newest first, each with its own mark and opening its own thread", () => {
    seam.links = ["t-new", "t-old"];
    seam.metas = {
      "t-new": { status: "idle", title: "Ask ITaP", workOutcome: { words: "1 mail to send", tone: "held" } },
      "t-old": { status: "running", title: "Count cables", workOutcome: { words: "Working", tone: "working" } },
    };
    const Mark = projectsKitFor("env_box", "ws-marks").taskMark!;
    render(<Mark task={{ id: "t1", title: "Network for 64 seats" } as ProjectTask} />);
    const marks = [...document.querySelectorAll("[data-task-thread]")];
    expect(marks.map((m) => m.getAttribute("data-task-thread"))).toEqual(["held", "working"]);
    // Two threads on one task: each says which it opens.
    expect(marks.map((m) => m.getAttribute("aria-label"))).toEqual(["Open Ask ITaP", "Open Count cables"]);
    expect(marks[0]!.querySelector("[data-outcome=held]")).toBeTruthy();
    fireEvent.click(marks[1]!);
    expect(opened).toEqual(["t-old"]);
  });

  it("taskMark draws nothing for a task no thread works on, nor for a thread this window does not hold", () => {
    seam.links = ["t-gone"];
    const Mark = projectsKitFor("env_box", "ws-marks").taskMark!;
    render(<Mark task={{ id: "t1", title: "Chairs" } as ProjectTask} />);
    expect(document.querySelector("[data-task-thread]")).toBeNull();
  });

  it("log lists the project's threads newest first with what each left him, each opening its thread", () => {
    seam.roots = new Map([["p-lan", [thread("t-b", 9, { words: "1 mail to send", tone: "held" }), thread("t-a", 3)]]]);
    const { result } = renderHook(() => useThreadLog(LAN));
    expect(result.current.map((e) => [e.id, e.title, e.detail, e.at])).toEqual([
      ["t-b", "Thread t-b", "1 mail to send", 9],
      ["t-a", "Thread t-a", undefined, 3],
    ]);
    // A held thread has the Outbox's mark; one with nothing to say has none (the Log's dot).
    expect(result.current[0]!.mark).toBeTruthy();
    expect(result.current[1]!.mark).toBeUndefined();
    result.current[1]!.open!();
    expect(opened).toEqual(["t-a"]);
  });

  it("threadFacts gives each project its most pressing thread's mark and words, and none where the lead says nothing", () => {
    seam.roots = new Map([
      ["p-lan", [thread("t-made", 9, { words: "Made Seat map.xlsx", tone: "made" }), thread("t-asks", 2, { words: "Asks you", tone: "asks" })]],
      ["p-quiet", [thread("t-idle", 4)]],
    ]);
    const { result, rerender } = renderHook(() => useThreadFacts("purdue"));
    expect(result.current.get("p-lan")?.words).toBe("Asks you");
    expect(result.current.has("p-quiet")).toBe(false);
    result.current.get("p-lan")!.open!();
    expect(opened).toEqual(["t-asks"]);
    // The same map while the roots are the same: the list's memoised rows keep their cell.
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("files lists what the threads made or changed, newest first, with which thread; undone writes are left out and Open goes to Files", async () => {
    seam.roots = new Map([["p-files", [thread("t-seat", 9, { words: "Made Seat map.xlsx", tone: "made" }), thread("t-budget", 4, { words: "Made Budget.xlsx", tone: "made" })]]]);
    seam.records = {
      "t-seat": { made: [made("seat", "t-seat", 30), made("draft", "t-seat", 40, { undone: true })] },
      "t-budget": { made: [made("budget", "t-budget", 50, { verb: "Saved" })] },
    };
    const { result } = renderHook(() => useThreadFiles({ id: "p-files", sector: "purdue" }));
    // Undefined while the records are on their way.
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current!.map((f) => [f.name, f.by, f.at])).toEqual([
      ["budget.xlsx", "Saved by Thread t-budget", 50],
      ["seat.xlsx", "Made by Thread t-seat", 30],
    ]);
    await act(async () => result.current![1]!.open());
    expect(seam.files).toEqual([{ workspace: { id: "ws", environmentId: "env_box" }, what: { ref: { at: "work", workspaceId: "ws", path: "seat.xlsx" }, name: "seat.xlsx" } }]);
    // Asked once a thread and state: a second reader takes what the first read.
    const reads = seam.reads.length;
    renderHook(() => useThreadFiles({ id: "p-files", sector: "purdue" }));
    expect(seam.reads.length).toBe(reads);
  });

  it("a made thing with nowhere to open opens its thread", async () => {
    seam.roots = new Map([["p-vm", [thread("t-vm", 2, { words: "Made Plan.docx", tone: "made" })]]]);
    seam.records = { "t-vm": { made: [made("plan", "t-vm", 10, { open: null })] } };
    const { result } = renderHook(() => useThreadFiles({ id: "p-vm", sector: "purdue" }));
    await waitFor(() => expect(result.current?.length).toBe(1));
    result.current![0]!.open();
    expect(opened).toEqual(["t-vm"]);
    expect(screen.queryByText("plan.xlsx")).toBeNull();
  });
});
