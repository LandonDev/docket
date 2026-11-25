// @vitest-environment jsdom
/**
 * TempCode's fill of the kit's thread slots (kit.tsx, docs/agents/work-tracker.md "The slots"): every open link's
 * mark on a task, the project's threads in its Log, the files they made in its Files, and each project's lead thread
 * for the list's Threads column. The window's summaries are faked at their one seam (work/threads/roots.ts); the
 * files come from each host's one answer for the project's mirror (`work.projects.files`).
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectTask } from "work-kit/projects";
import type { ProjectMadeFile } from "@shared/work/threadRecord";
import type { TrackerThread } from "@shared/work/tracker";
import type { SessionMeta } from "@shared/events";
import { registry } from "../../lib/connection";
import { sessionStore } from "../../lib/tcserver/store";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { workOpenPort } from "../../lib/workSwitch";

const seam = vi.hoisted(() => ({
  roots: new Map<string, unknown[]>(),
  links: [] as string[],
  metas: {} as Record<string, { status: string; title: string; workOutcome?: { words: string; tone: string } | null }>,
  /** each host's answer, by `env|mirror`; an Error refuses */
  answers: {} as Record<string, ProjectMadeFile[] | Error>,
  reads: [] as string[],
  files: [] as unknown[],
}));
vi.mock("../threads/roots", async (original) => ({ ...(await original<object>()), useProjectRoots: () => seam.roots }));
vi.mock("../tasks/links", () => ({ useLinkedThreads: () => seam.links, useLinkedThread: () => seam.links[0] ?? null }));
vi.mock("../../lib/tcserver/store", async (original) => ({
  ...(await original<object>()),
  useSessionMetaValue: (id: string, read: (meta: unknown) => unknown) => (seam.metas[id] ? read(seam.metas[id]) : undefined),
}));
vi.mock("../files/openFrom", () => ({ openInFiles: async (workspace: unknown, what: unknown) => void seam.files.push({ workspace, what }) }));

const { jobName, projectsKitFor, resetProjectFiles, useThreadFacts, useThreadFiles, useThreadLog } = await import("./kit");

const thread = (sessionId: string, updatedAt: number, outcome: TrackerThread["outcome"] = null): TrackerThread => ({ sessionId, title: `Thread ${sessionId}`, updatedAt, outcome });
const made = (id: string, sessionId: string, at: number, over: Partial<ProjectMadeFile> = {}): ProjectMadeFile => ({
  id,
  sessionId,
  rootId: sessionId,
  key: `files:${id}`,
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
  seam.answers = {};
  seam.reads = [];
  seam.files = [];
  resetProjectFiles();
  // Threads named t-mac… live on the Mac, the rest on the box; each in its host's mirror of the project.
  vi.spyOn(sessionStore, "environmentOf").mockImplementation((id) => (id.startsWith("t-mac") ? "env_mac" : "env_box"));
  vi.spyOn(sessionStore, "metaOf").mockImplementation((id) => ({ id, projectId: id.startsWith("t-mac") ? "m-mac" : "m-box" }) as SessionMeta);
  vi.spyOn(registry, "linkOf").mockImplementation(
    (env) =>
      ({
        request: async (method: string, params: { mirrorId: string }) => {
          const at = `${env}|${params.mirrorId}`;
          seam.reads.push(`${method} ${at}`);
          const answer = seam.answers[at] ?? [];
          if (answer instanceof Error) throw answer;
          return { files: answer };
        },
      }) as never,
  );
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

  it("files lists what the threads made or changed, newest first, with which thread, from one ask a host; Open goes to Files", async () => {
    seam.roots = new Map([["p-files", [thread("t-seat", 9, { words: "Made Seat map.xlsx", tone: "made" }), thread("t-budget", 4, { words: "Made Budget.xlsx", tone: "made" })]]]);
    seam.answers = { "env_box|m-box": [made("budget", "t-budget", 50, { verb: "Saved" }), made("seat", "t-seat", 30)] };
    const { result } = renderHook(() => useThreadFiles({ id: "p-files", sector: "purdue" }));
    await waitFor(() => expect(result.current?.length).toBe(2));
    expect(result.current!.map((f) => [f.name, f.by, f.at])).toEqual([
      ["budget.xlsx", "Saved by Thread t-budget", 50],
      ["seat.xlsx", "Made by Thread t-seat", 30],
    ]);
    // Two threads in one mirror: one ask, not one a thread, and no task reads.
    expect(seam.reads).toEqual(["work.projects.files env_box|m-box"]);
    await act(async () => result.current![1]!.open());
    expect(seam.files).toEqual([{ workspace: { id: "ws", environmentId: "env_box" }, what: { ref: { at: "work", workspaceId: "ws", path: "seat.xlsx" }, name: "seat.xlsx" } }]);
    // Asked once a mirror and state: a second reader takes what the first read.
    renderHook(() => useThreadFiles({ id: "p-files", sector: "purdue" }));
    expect(seam.reads).toHaveLength(1);
  });

  it("two files of one name stay two; one LifeOS item is one row whichever host linked it, with its item id", async () => {
    seam.roots = new Map([["p-two", [thread("t-a", 9), thread("t-mac-b", 4)]]]);
    seam.answers = {
      "env_box|m-box": [made("b1", "t-a", 50, { name: "Budget.xlsx", key: "files:/a/Budget.xlsx" }), made("l1", "t-a", 20, { name: "Run of show", key: "item:i-run", itemId: "i-run", verb: "Linked" })],
      "env_mac|m-mac": [made("b2", "t-mac-b", 40, { name: "Budget.xlsx", key: "files:/b/Budget.xlsx" }), made("l2", "t-mac-b", 30, { name: "Run of show", key: "item:i-run", itemId: "i-run", verb: "Linked" })],
    };
    const { result } = renderHook(() => useThreadFiles({ id: "p-two", sector: "purdue" }));
    await waitFor(() => expect(result.current?.length).toBe(3));
    expect(result.current!.map((f) => [f.name, f.itemId])).toEqual([
      ["Budget.xlsx", undefined],
      ["Budget.xlsx", undefined],
      ["Run of show", "i-run"],
    ]);
    expect(seam.reads.sort()).toEqual(["work.projects.files env_box|m-box", "work.projects.files env_mac|m-mac"]);
  });

  it("a host that refuses lists nothing this time and is asked again at the next look; the other host's rows stand", async () => {
    seam.roots = new Map([["p-down", [thread("t-a", 9), thread("t-mac-b", 4)]]]);
    seam.answers = { "env_box|m-box": [made("a", "t-a", 50)], "env_mac|m-mac": new Error("not connected") };
    const first = renderHook(() => useThreadFiles({ id: "p-down", sector: "purdue" }));
    await waitFor(() => expect(first.result.current?.map((f) => f.name)).toEqual(["a.xlsx"]));
    first.unmount();
    seam.answers["env_mac|m-mac"] = [made("b", "t-mac-b", 60)];
    const second = renderHook(() => useThreadFiles({ id: "p-down", sector: "purdue" }));
    await waitFor(() => expect(second.result.current?.map((f) => f.name)).toEqual(["b.xlsx", "a.xlsx"]));
    // The box answered and its threads did not move: only the Mac is asked again.
    expect(seam.reads.filter((r) => r.includes("env_box"))).toHaveLength(1);
  });

  it("a made thing with nowhere to open opens its thread", async () => {
    seam.roots = new Map([["p-vm", [thread("t-vm", 2, { words: "Made Plan.docx", tone: "made" })]]]);
    seam.answers = { "env_box|m-box": [made("plan", "t-vm", 10, { open: null })] };
    const { result } = renderHook(() => useThreadFiles({ id: "p-vm", sector: "purdue" }));
    await waitFor(() => expect(result.current?.length).toBe(1));
    result.current![0]!.open();
    expect(opened).toEqual(["t-vm"]);
    expect(screen.queryByText("plan.xlsx")).toBeNull();
  });

  it("the facts line names the job by its workspace, as the rail and the tracker do", () => {
    expect(jobName({ name: "Purdue Esports", sector: "purdue" }, "purdue")).toBe("Purdue Esports");
    expect(jobName(undefined, "purdue")).toBe("Purdue");
    vi.spyOn(workspaceStore, "workspace").mockReturnValue({ id: "ws-name", name: "Purdue Esports", sector: "purdue" } as never);
    const Mark = projectsKitFor("env_box", "ws-name").SectorMark;
    render(<Mark sector="purdue" />);
    expect(screen.getByText("Purdue Esports")).toBeTruthy();
  });
});
