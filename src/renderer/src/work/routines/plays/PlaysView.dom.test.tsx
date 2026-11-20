// @vitest-environment jsdom
/**
 * The plays on screen: the view lists his plays, then an agent's proposals,
 * then the starters he has not added; a play that takes nothing starts on
 * its row's press, one that takes something asks for it; Run a play… on a
 * mail offers the plays that take a mail; Save as a play drafts only on its
 * own press, and never for a Purdue thread.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayRow } from "@shared/contract-work-routines";
import type { ContextChip } from "@shared/work";

const host: { plays: PlayRow[]; asked: { method: string; params: unknown }[]; answer: (method: string, params: unknown) => unknown } = { plays: [], asked: [], answer: () => null };
vi.mock("../../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    linkOf: () => ({
      onPush: () => () => {},
      request: async (method: string, params: unknown) => {
        host.asked.push({ method, params });
        if (method === "work.routines.plays") return { plays: host.plays };
        return host.answer(method, params);
      },
    }),
  },
}));

const { View } = await import("./PlaysView");
const { RunDialog } = await import("./RunDialog");
const { PlayDialog } = await import("./PlayDialog");

const play = (over: Partial<PlayRow> = {}): PlayRow => ({ id: "p", workspaceId: "ws", name: "Game assignment", instructions: "Turn it into an event.", takes: ["mail"], proposed: false, madeIn: null, starter: null, createdBy: "owner", createdAt: 1, updatedAt: 1, host: "box", ...over });
const mail: ContextChip = { kind: "mail", label: "Varsity football, Fri", ref: { at: "lifeos", table: "mailThreads", id: "m1" } };
const props = { env: "box", workspace: { id: "ws", environmentId: "box" }, sector: "ref", lifeos: {}, startThread: () => {} } as never;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const asked = (method: string) => host.asked.filter((a) => a.method === method).map((a) => a.params);

beforeEach(() => {
  host.asked.length = 0;
  host.plays = [];
  host.answer = (method) => (method === "work.routines.playStart" ? { sessionId: "t-new" } : null);
});
afterEach(cleanup);

describe("the Plays view", () => {
  it("lists his plays, then proposals, then the starters he has not added", async () => {
    host.plays = [play({ id: "a", name: "Weekly sweep", takes: [] }), play({ id: "b", name: "From a thread", proposed: true, createdBy: "model" }), play({ id: "c", name: "Game assignment", starter: "ref.assignment" })];
    render(<View {...props} />);
    await settle();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["Proposed", "Starters"]);
    expect(within(screen.getByRole("region", { name: "Starters" })).getAllByRole("button").map((b) => b.textContent)).toEqual(["Month’s payTakes a date"]);
    expect(within(screen.getByRole("region", { name: "Plays" })).getByRole("button", { name: /^Weekly sweep/ }).textContent).toBe("Weekly sweepTakes nothing");
  });

  it("starts a play that takes nothing on one press, and asks first for what another takes", async () => {
    host.plays = [play({ id: "a", name: "Weekly sweep", takes: [] }), play({ id: "b", name: "Game assignment" })];
    render(<View {...props} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /^Weekly sweep/ }));
    await settle();
    expect(asked("work.routines.playStart")).toEqual([{ id: "a", inputs: {} }]);
    fireEvent.click(screen.getByRole("button", { name: /^Game assignment/ }));
    await settle();
    expect(asked("work.routines.playStart")).toHaveLength(1);
    expect(screen.getByRole("dialog").textContent).toContain("Game assignment");
    expect(screen.getByPlaceholderText("Search mail")).toBeTruthy();
  });

  it("adds a starter only on his Add, filled for him to change", async () => {
    host.plays = [play({ id: "b", name: "From a thread", proposed: true })];
    render(<View {...props} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Month’s pay/ }));
    expect(asked("work.routines.playSave")).toEqual([]);
    expect((screen.getByPlaceholderText("Game assignment") as HTMLInputElement).value).toBe("Month’s pay");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await settle();
    expect(asked("work.routines.playSave")).toEqual([expect.objectContaining({ workspaceId: "ws", name: "Month’s pay", takes: ["date"], starter: "ref.month" })]);
  });

  it("lets a proposal go with Not now, asking nothing", async () => {
    host.plays = [play({ id: "b", name: "From a thread", proposed: true })];
    render(<View {...props} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /From a thread/ }));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await settle();
    expect(asked("work.routines.playRemove")).toEqual([{ id: "b" }]);
  });

  it("says an empty list in one line, with New play", async () => {
    render(<View {...{ ...(props as object), sector: "none" } as never} />);
    await settle();
    expect(screen.getByText("No plays yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New play" })).toBeTruthy();
  });
});

describe("Run a play… on a mail", () => {
  it("offers the plays that take a mail, starts one that needs nothing more, and asks the date of one that does", async () => {
    host.plays = [play({ id: "a" }), play({ id: "b", name: "Month’s pay", takes: ["date"] }), play({ id: "c", name: "Assignment and date", takes: ["mail", "date"] })];
    const onClose = vi.fn();
    render(<RunDialog env="box" workspaceId="ws" chip={mail} onClose={onClose} />);
    await settle();
    const list = screen.getByRole("list", { name: "Plays" });
    expect(within(list).getAllByRole("button").map((b) => b.textContent)).toEqual(["Game assignmentTakes a mail", "Assignment and dateTakes a mail and a date"]);
    fireEvent.click(within(list).getByRole("button", { name: /Assignment and date/ }));
    expect((screen.getByLabelText("Date") as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-11-27" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await settle();
    expect(asked("work.routines.playStart")).toEqual([{ id: "c", inputs: { chips: [mail], date: "2026-11-27" } }]);
  });

  it("starts at once a play the mail fills", async () => {
    host.plays = [play({ id: "a" })];
    render(<RunDialog env="box" workspaceId="ws" chip={mail} onClose={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Game assignment/ }));
    await settle();
    expect(asked("work.routines.playStart")).toEqual([{ id: "a", inputs: { chips: [mail] } }]);
  });
});

describe("Save as a play", () => {
  it("drafts from the thread only on its press, and offers no draft where it may not", async () => {
    host.answer = (method) => (method === "work.routines.playDraft" ? { name: "Game assignment", instructions: "1. Read the mail.", takes: ["mail"] } : null);
    render(<PlayDialog env="box" workspaceId="ws" source={{ kind: "thread", sessionId: "t1", mayDraft: true }} onClose={() => {}} />);
    await settle();
    expect(asked("work.routines.playDraft")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Draft from the thread" }));
    await settle();
    expect(asked("work.routines.playDraft")).toEqual([{ sessionId: "t1" }]);
    expect((screen.getByPlaceholderText("The steps, in your words") as HTMLTextAreaElement).value).toBe("1. Read the mail.");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await settle();
    expect(asked("work.routines.playSave")).toEqual([expect.objectContaining({ name: "Game assignment", takes: ["mail"], madeIn: "t1" })]);
    cleanup();
    render(<PlayDialog env="box" workspaceId="ws" source={{ kind: "thread", sessionId: "t2", mayDraft: false }} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Draft from the thread" })).toBeNull();
  });
});
