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
    expect(rows()[1]).toBe("Borrow two switches from ITaPWaiting on Sam Ortiz, 6 days");
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

  it("a failure: its words and cause, in red", () => {
    draw(empty({ waits: [{ kind: "failed", sessionId: "t1", words: "Couldn't sign in", cause: "The Purdue Outlook sign-in ran out" }] }));
    expect(rows()).toEqual(["Couldn't sign inThe Purdue Outlook sign-in ran out"]);
    expect([...head()!.querySelectorAll(".text-destructive")].map((el) => el.textContent)).toContain("Couldn't sign in");
  });

  it("a failed send says why in red under the act", () => {
    draw(empty({ waits: [{ kind: "held", item: heldItem({ state: "failed", error: "Outlook refused it" }) }] }));
    expect([...head()!.querySelectorAll(".text-destructive")].map((el) => el.textContent)).toContain("Outlook refused it");
  });

  it("working: nothing waits, so the head holds the task alone and the transcript's working line says the rest", () => {
    draw(empty({ works: [task], outcome: { words: "Writing the mail", tone: "working" } }));
    expect(rows()).toEqual(["Borrow two switches from ITaPWaiting on Sam Ortiz, 6 days"]);
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
    expect(waitingWords("Sam Ortiz", NOW - 86_400_000, NOW)).toBe("Waiting on Sam Ortiz, 1 day");
    expect(waitingWords("Sam Ortiz", null, NOW)).toBe("Waiting on Sam Ortiz");
  });
});

describe("the record read", () => {
  it("asks the thread's host for its record", async () => {
    world.record = empty({ works: [task] });
    function Probe() {
      const record = useThreadRecord("box", "t1");
      return <span data-testid="probe">{record ? record.works[0]!.title : "none"}</span>;
    }
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("Borrow two switches from ITaP"));
    expect(world.calls.find((c) => c.method === "work.threads.record")?.params).toEqual({ sessionId: "t1" });
    await act(async () => {});
  });
});
