// @vitest-environment jsdom
/**
 * A Work thread's head (docs/DESIGN.md "A thread's head"): what it left him, drawn from the host's record in each
 * state (held, a question, a failure, live work, made, the task it works on), a held row opening the Outbox's own
 * detail in a sheet, never amber for held; and the slot that puts it over a Work thread's first message alone.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboxItem } from "@shared/contract-work-outbox";
import type { ThreadRecord } from "@shared/work/threadRecord";

const world = vi.hoisted(() => ({
  calls: [] as { method: string; params: Record<string, unknown> }[],
  record: null as unknown as ThreadRecord,
  /** Each record read answers this way: the record, or a refusal. */
  refuse: false,
}));

vi.mock("../../lib/connection", async (original) => {
  const link = {
    environmentId: "box",
    connected: true,
    onPush: () => () => undefined,
    onOpen: () => () => undefined,
    onClose: () => () => undefined,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      world.calls.push({ method, params });
      switch (method) {
        case "work.threads.record":
          if (world.refuse) throw new Error("not connected");
          return world.record;
        case "work.outbox.list":
          return { items: [], waiting: 0 };
        case "work.outbox.requests":
          return { requests: [] };
        case "work.outbox.get":
          return heldItem();
      }
      return null;
    },
  };
  return {
    ...(await original<typeof import("../../lib/connection")>()),
    registry: { linkOf: () => link, onLink: () => () => undefined },
  };
});

const opened = vi.hoisted(() => ({ files: [] as unknown[], views: [] as unknown[] }));
vi.mock("../../work/files/openFrom", () => ({ openInFiles: async (...args: unknown[]) => void opened.files.push(args) }));
vi.mock("../../lib/workSwitch", async (original) => ({
  ...(await original<typeof import("../../lib/workSwitch")>()),
  openWorkView: (view: unknown) => void opened.views.push(view),
}));

// The Outbox's waiting list and LifeOS's task reads, as the head hears them: set here, told to their readers.
const live = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const tasks = new Map<string, { result: unknown; tell: Set<() => void> }>();
  return {
    waiting: [] as unknown[],
    listeners,
    setWaiting(next: unknown[]) {
      this.waiting = next;
      listeners.forEach((fn) => fn());
    },
    tasks,
    setTask(id: string, result: unknown) {
      const entry = tasks.get(id) ?? { result: undefined, tell: new Set<() => void>() };
      entry.result = result;
      tasks.set(id, entry);
      entry.tell.forEach((fn) => fn());
    },
    client: {
      watchQuery: (_ref: unknown, args: { id: string }) => {
        const entry = tasks.get(args.id) ?? { result: undefined, tell: new Set<() => void>() };
        tasks.set(args.id, entry);
        return {
          localQueryResult: () => entry.result,
          onUpdate: (fn: () => void) => {
            entry.tell.add(fn);
            queueMicrotask(fn);
            return () => void entry.tell.delete(fn);
          },
        };
      },
    },
  };
});
vi.mock("../../work/outbox/store", async (original) => {
  const real = await original<typeof import("../../work/outbox/store")>();
  const { useSyncExternalStore } = await import("react");
  const subscribe = (fn: () => void) => (live.listeners.add(fn), () => void live.listeners.delete(fn));
  return { ...real, useOutbox: () => ({ ...real.outboxNow(), waiting: useSyncExternalStore(subscribe, () => live.waiting) }) };
});
vi.mock("../../work/shell/lifeos", async (original) => ({
  ...(await original<typeof import("../../work/shell/lifeos")>()),
  useLifeosSession: (environmentId: string, sector: string | null) => ({ environmentId, sector, client: environmentId ? live.client : null, state: "connected" }),
}));
vi.mock("../../lib/tcserver/workspaces", async (original) => {
  const ws = [{ id: "ws1", environmentId: "box", sector: "purdue", name: "Purdue Esports", kind: "work" }];
  return { ...(await original<typeof import("../../lib/tcserver/workspaces")>()), useWorkspaces: () => ws };
});

import { useThreadRecord, waitingWords, WorkHeadView } from "./WorkHead";

const NOW = new Date(2026, 10, 25, 11, 0).getTime();
const HELD_AT = new Date(2026, 10, 25, 10, 2).getTime();

function heldItem(over: Partial<OutboxItem> = {}): OutboxItem {
  return {
    ref: { at: "lifeos", table: "outbox", id: "m1" },
    kind: "mail.send",
    workspaceId: "ws1",
    sessionId: "t1",
    sector: "purdue",
    summary: "Send to Sam Ortiz: Two switches for the spring LAN",
    verb: "Send",
    account: "landon@purdue.edu",
    state: "held",
    payload: { message: { to: [{ name: "Sam Ortiz", address: "sortiz@purdue.edu" }], subject: "Two switches for the spring LAN", text: "Hi Sam" } },
    createdAt: HELD_AT,
    decidedBy: null,
    decidedAt: null,
    n: null,
    why: "lifeos",
    grantId: null,
    error: null,
    result: null,
    routineRunId: null,
    updatedAt: HELD_AT,
    ...over,
  };
}

const empty = (over: Partial<ThreadRecord> = {}): ThreadRecord => ({ sessionId: "t1", workspaceId: "ws1", waits: [], works: [], made: [], outcome: null, ...over });

const task = { table: "tasks" as const, id: "task1", title: "Borrow two switches from ITaP", state: "open" as const, at: HELD_AT - 1000, task: { status: "waiting", due: null, projectId: "p1", waitingOn: { name: "Sam Ortiz", since: NOW - 6 * 86_400_000 } } };

const draw = (record: ThreadRecord) => render(<WorkHeadView record={record} environmentId="box" now={NOW} />);
const head = () => document.querySelector<HTMLElement>("[data-work-head]");
const rows = () => [...(head()?.querySelectorAll<HTMLElement>("[data-head-row]") ?? [])].map((r) => r.textContent);

beforeEach(() => {
  world.calls = [];
  opened.files = [];
  opened.views = [];
});
afterEach(cleanup);

describe("the head", () => {
  it("held: the act, what it is about and when it was held, muted, never amber; the task it works on with who it waits on", () => {
    draw(empty({ waits: [{ kind: "held", item: heldItem() }], works: [task], outcome: { words: "1 mail to send", tone: "held" } }));
    expect(rows()[0]).toMatch(/^Send to Sam Ortiz.*Held 10:02 AM$/);
    expect(rows()[1]).toBe("Borrow two switches from ITaPWaiting on Sam Ortiz 6 days");
    expect(head()!.innerHTML).not.toMatch(/warning|amber/);
  });

  it("a held row opens the Outbox's own detail in a sheet over the thread", async () => {
    draw(empty({ waits: [{ kind: "held", item: heldItem() }] }));
    fireEvent.click(screen.getByRole("button", { name: /^Open Send to Sam Ortiz/ }));
    const sheet = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-work-head-held]");
      if (!el) throw new Error("no sheet");
      return el;
    });
    expect(sheet.getAttribute("aria-label")).toBe("Send to Sam Ortiz: Two switches for the spring LAN");
    await waitFor(() => expect(sheet.querySelector('[data-slot="act-payload"]')).not.toBeNull(), { timeout: 5000 });
    expect(sheet.textContent).toContain("Two switches for the spring LAN");
    expect(within(sheet).getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("a question: one amber row, first", () => {
    draw(empty({ waits: [{ kind: "asks", sessionId: "t1" }, { kind: "held", item: heldItem() }] }));
    expect(rows()[0]).toBe("Asks you");
    expect(head()!.querySelector("[data-head-row]")!.innerHTML).toMatch(/warning/);
  });

  it("Asks you takes him to the question's card in the transcript", () => {
    const scroller = document.createElement("div");
    scroller.className = "agent-transcript";
    document.body.append(scroller);
    const card = document.createElement("div");
    card.dataset.slot = "question-card";
    const seen: ScrollIntoViewOptions[] = [];
    card.scrollIntoView = (options) => void seen.push(options as ScrollIntoViewOptions);
    render(<WorkHeadView record={empty({ waits: [{ kind: "asks", sessionId: "t1" }] })} environmentId="box" now={NOW} />, { container: scroller.appendChild(document.createElement("div")) });
    scroller.append(card);
    fireEvent.click(screen.getByRole("button", { name: "Go to the question" }), { detail: 1 });
    // From the keyboard it lands at once.
    fireEvent.click(screen.getByRole("button", { name: "Go to the question" }), { detail: 0 });
    expect(seen).toEqual([
      { block: "center", behavior: "smooth" },
      { block: "center", behavior: "auto" },
    ]);
    scroller.remove();
  });

  it("a failure: its words and cause, in red", () => {
    draw(empty({ waits: [{ kind: "failed", sessionId: "t1", words: "Couldn't sign in", cause: "The Purdue Outlook sign-in ran out" }] }));
    expect(rows()).toEqual(["Couldn't sign inThe Purdue Outlook sign-in ran out"]);
    expect([...head()!.querySelectorAll(".text-destructive")].map((el) => el.textContent)).toContain("Couldn't sign in");
  });

  it("a failed send is drawn as failed: the red mark, why in red, and when it failed, never Held", () => {
    const at = new Date(2026, 10, 25, 10, 4).getTime();
    draw(empty({ waits: [{ kind: "held", item: heldItem({ state: "failed", error: "Outlook refused it", updatedAt: at }) }] }));
    expect([...head()!.querySelectorAll(".text-destructive")].map((el) => el.textContent)).toContain("Outlook refused it");
    expect(rows()[0]).toMatch(/Failed 10:04 AM$/);
    expect(rows()[0]).not.toMatch(/Held/);
    expect(head()!.querySelector("[data-head-row]")!.innerHTML).toMatch(/destructive/);
  });

  it("out of date is muted, not red", () => {
    draw(empty({ waits: [{ kind: "held", item: heldItem({ state: "stale", error: "The chat moved" }) }] }));
    expect(screen.getByText("Out of date").className).toMatch(/text-muted-foreground/);
    expect(head()!.querySelector(".text-destructive")).toBeNull();
  });

  it("a task is late once its due time passes, not only after midnight", () => {
    const due = (at: number) => ({ ...task, task: { ...task.task, waitingOn: null, due: at } });
    draw(empty({ works: [due(NOW - 3_600_000)] }));
    expect(head()!.querySelector(".text-destructive")?.textContent).toMatch(/^Due /);
    cleanup();
    draw(empty({ works: [due(NOW + 3_600_000)] }));
    expect(head()!.querySelector(".text-destructive")).toBeNull();
  });

  it("a refresh that failed keeps the facts with one quiet line", () => {
    render(<WorkHeadView record={empty({ works: [task] })} environmentId="box" now={NOW} behind={HELD_AT} />);
    expect(document.querySelector("[data-head-behind]")!.textContent).toBe("Couldn't refresh. As of 10:02 AM");
  });

  it("working: nothing waits, so the head holds the task alone and the transcript's working line says the rest", () => {
    draw(empty({ works: [task], outcome: { words: "Writing the mail", tone: "working" } }));
    expect(rows()).toEqual(["Borrow two switches from ITaPWaiting on Sam Ortiz 6 days"]);
  });

  it("made: each thing it made or changed with its verb and time, opening in Files", () => {
    draw(
      empty({
        made: [{ id: "r1", sessionId: "child", kind: "file.make", verb: "Made", name: "Seat map.xlsx", summary: "Made Seat map.xlsx in Spring LAN", at: HELD_AT, undone: false, open: { at: "files", workspaceId: "ws1", ref: { at: "file", host: "box", path: "/w/Seat map.xlsx" }, name: "Seat map.xlsx" } }],
        outcome: { words: "Made Seat map.xlsx", tone: "made" },
      }),
    );
    expect(rows()).toEqual(["Seat map.xlsxMade 10:02 AM"]);
    fireEvent.click(screen.getByRole("button", { name: "Open Seat map.xlsx in Files" }));
    expect(opened.files).toEqual([[{ id: "ws1", environmentId: "box" }, { ref: { at: "file", host: "box", path: "/w/Seat map.xlsx" }, name: "Seat map.xlsx" }]]);
  });

  it("says From the task over the first message once the task is done, opening the task's sheet; an open task is its row alone", () => {
    draw(empty({ works: [task] }));
    expect(document.querySelector("[data-from-task]")).toBeNull();
    cleanup();
    draw(empty({ works: [{ ...task, state: "done" }] }));
    expect(head()).toBeNull();
    const from = document.querySelector<HTMLElement>("[data-from-task]")!;
    expect(from.textContent).toBe("From the taskBorrow two switches from ITaP");
    fireEvent.click(within(from).getByRole("button"));
    expect(opened.views).toEqual([{ workspaceId: "ws1", view: "tasks", task: "task1" }]);
  });

  it("a thread that left nothing draws nothing", () => {
    const { container } = draw(empty());
    expect(container.innerHTML).toBe("");
  });

  it("waiting words: who, then days once a day has passed", () => {
    expect(waitingWords("Sam Ortiz", NOW - 3_600_000, NOW)).toBe("Waiting on Sam Ortiz");
    expect(waitingWords("Sam Ortiz", NOW - 86_400_000, NOW)).toBe("Waiting on Sam Ortiz 1 day");
    expect(waitingWords("Sam Ortiz", null, NOW)).toBe("Waiting on Sam Ortiz");
  });
});

describe("the record read", () => {
  beforeEach(() => {
    world.refuse = false;
  });

  function Probe({ env = "box", id = "t1" }: { env?: string; id?: string }) {
    const head = useThreadRecord(env, id);
    return <span data-testid="probe">{head ? `${head.record.sessionId}:${head.record.works[0]?.title ?? ""}${head.behind ? ":behind" : ""}` : "none"}</span>;
  }
  const probe = () => screen.getByTestId("probe").textContent;

  it("asks the thread's host for its record", async () => {
    world.record = empty({ works: [task] });
    render(<Probe />);
    await waitFor(() => expect(probe()).toBe("t1:Borrow two switches from ITaP"));
    expect(world.calls.find((c) => c.method === "work.threads.record")?.params).toEqual({ sessionId: "t1" });
    await act(async () => {});
  });

  it("never shows one thread's record for another while the new one is read", async () => {
    world.record = empty({ works: [task] });
    const { rerender } = render(<Probe />);
    await waitFor(() => expect(probe()).toBe("t1:Borrow two switches from ITaP"));
    world.refuse = true;
    rerender(<Probe id="t2" />);
    expect(probe()).toBe("none");
    await act(async () => {});
    expect(probe()).toBe("none");
  });

  const reads = () => world.calls.filter((c) => c.method === "work.threads.record").length;

  it("reads again when one of its held items changes in the Outbox, not when another thread's does", async () => {
    const item = heldItem();
    world.record = empty({ waits: [{ kind: "held", item }] });
    live.setWaiting([{ ...item, environmentId: "box" }]);
    render(<Probe />);
    await waitFor(() => expect(probe()).toBe("t1:"));
    await act(async () => {});
    const before = reads();
    act(() => live.setWaiting([{ ...item, environmentId: "box" }, { ...heldItem({ ref: { at: "lifeos", table: "outbox", id: "m9" }, sessionId: "t9" }), environmentId: "box" }]));
    await act(async () => {});
    expect(reads()).toBe(before);
    act(() => live.setWaiting([{ ...item, updatedAt: HELD_AT + 5, environmentId: "box" }]));
    await waitFor(() => expect(reads()).toBe(before + 1));
    live.setWaiting([]);
  });

  it("reads again when LifeOS changes one of its open tasks", async () => {
    world.record = empty({ works: [task] });
    live.setTask("task1", { task: { status: "waiting" } });
    render(<Probe />);
    await waitFor(() => expect(probe()).toBe("t1:Borrow two switches from ITaP"));
    await act(async () => {});
    const before = reads();
    act(() => live.setTask("task1", { task: { status: "done" } }));
    await waitFor(() => expect(reads()).toBe(before + 1));
  });

  it("a refresh that fails keeps the last facts, marked behind", async () => {
    world.record = empty({ works: [task] });
    const { rerender } = render(<Probe />);
    await waitFor(() => expect(probe()).toBe("t1:Borrow two switches from ITaP"));
    world.refuse = true;
    // The same thread asked again (the host moved): here by a new host and back, which reads it fresh.
    rerender(<Probe env="mac" />);
    rerender(<Probe />);
    await act(async () => {});
    expect(probe()).toBe("t1:Borrow two switches from ITaP:behind");
  });
});
