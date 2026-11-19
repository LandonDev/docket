// @vitest-environment jsdom
/**
 * The form kind in the real canvas pane, with a host that keeps one form's
 * view: the questions as a filler sees them, an agent's changes stepped
 * from the bar, his edit saved where it stands, Publish as his press, the
 * live link with Close form, the closed line with Reopen, and the
 * responses' summary, bars and table.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FormBody, FormResponses, FormView } from "@shared/contract-work-forms";
import type { CanvasItem } from "@shared/work";
import { openMenus } from "../../chrome/menuRows";
import { defineChunk } from "../../lib/lazyChunk";
import { CANVAS } from "../canvas/registry";
import { canvasItem, fakeHost } from "../canvas/testkit";
import type { CanvasBodyProps, CanvasKindDef } from "../canvas/kind";
import type { FormHost } from "./host";
import { optionDiff, shownQuestions } from "./model";

const host = vi.hoisted(() => ({
  current: null as ReturnType<typeof import("../canvas/testkit").fakeHost> | null,
  pushes: new Set<(push: never) => void>(),
  opens: new Set<() => void>(),
}));
vi.mock("../../lib/connection", async (original) => {
  const link = {
    environmentId: "local",
    connected: true,
    request: (method: string, params?: Record<string, unknown>) => host.current!.link.request(method, params),
    onPush: (listener: (push: never) => void) => (host.pushes.add(listener), () => host.pushes.delete(listener)),
    onOpen: (listener: () => void) => (host.opens.add(listener), () => host.opens.delete(listener)),
    onClose: () => () => undefined,
  };
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf: () => link, onLink: (listener: (l: typeof link, event: string) => void) => (listener(link, "added"), () => undefined) } };
});
import { CanvasSeat } from "../canvas/CanvasSeat";
import { resetCanvasStore } from "../canvas/store";

const BODY: FormBody = {
  title: "Spring LAN registration",
  description: "Saturday, April 10.",
  questions: [
    { id: "name", label: "Name", type: "short", required: true },
    { id: "game", label: "Game", type: "choice", required: true, options: ["Valorant", "Rocket League", "Super Smash Bros. Ultimate"] },
    { id: "diet", label: "Dietary needs", type: "long", required: false },
  ],
};

function view(over: Partial<FormView> = {}): FormView {
  return { itemId: "", rev: 1, body: BODY, state: "draft", mode: "suggests", suggestions: [], link: null, publishedAt: null, closedAt: null, held: null, sheet: null, written: null, ...over };
}

const RESPONSES: FormResponses = {
  rev: 4,
  columns: [
    { id: "name", label: "Name" },
    { id: "game", label: "Game" },
    { id: "diet", label: "Dietary needs" },
    { id: "submitted", label: "Submitted" },
  ],
  rows: [
    ["Marcus Lee", "Rocket League", "Vegetarian", "2026-11-19 13:40"],
    ["Ava Thompson", "Valorant", "", "2026-11-19 13:52"],
    ["Jordan Kim", "Valorant", "No peanuts", "2026-11-19 12:18"],
  ],
  count: 3,
  cut: false,
};

function fakeFormHost(start: FormView) {
  let v = start;
  const set = (next: FormView): FormView => (v = next);
  const fh = {
    open: vi.fn(async () => v),
    save: vi.fn(async (_rev: number, body: FormBody) => set({ ...v, rev: v.rev + 1, body })),
    review: vi.fn(async (which: { ids: string[] } | "all") => set({ ...v, suggestions: which === "all" ? [] : v.suggestions.filter((s) => !which.ids.includes(s.id)) })),
    mode: vi.fn(async (mode: FormView["mode"]) => set({ ...v, mode })),
    publish: vi.fn(async () => set({ ...v, state: "open", link: "https://tempcode.landonhale.com/f/AbCdEfGhIjKlMnOp", publishedAt: Date.now() })),
    close: vi.fn(async (open: boolean) => set({ ...v, state: open ? "open" : "closed", closedAt: open ? null : Date.now() })),
    responses: vi.fn(async () => RESPONSES),
    openSheet: vi.fn(async () => undefined),
    watch: () => () => undefined,
  } satisfies FormHost;
  return fh;
}

let formHost: ReturnType<typeof fakeFormHost>;
let item: CanvasItem;
let n = 0;
function kinds(): Record<string, CanvasKindDef> {
  const module = import("./FormCanvas").then((m) => ({
    Body: (props: CanvasBodyProps) => <m.Body {...(props as CanvasBodyProps<never>)} host={formHost} />,
    Bar: (props: CanvasBodyProps) => <m.Bar {...(props as CanvasBodyProps<never>)} host={formHost} />,
  }));
  return { ...CANVAS, form: { ...CANVAS.form, chunk: defineChunk(`test-form-${Math.random()}`, () => module) } };
}
function open(start: FormView) {
  item = canvasItem(`form${++n}`, { kind: "form", title: "Spring LAN registration", source: { at: "thread" } });
  formHost = fakeFormHost({ ...start, itemId: item.id });
  host.current = fakeHost([item], host as never);
  return render(
    <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
      <div />
    </CanvasSeat>,
  );
}
const found = (selector: string): Promise<HTMLElement> =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(selector);
    expect(el).not.toBeNull();
    return el!;
  });

beforeEach(async () => {
  Element.prototype.scrollIntoView ??= () => undefined;
  localStorage.clear();
  resetCanvasStore();
  await new Promise<void>((done) => openMenus(done));
});
afterEach(cleanup);

describe("the form kind", () => {
  it("draws the form as a filler sees it, and Publish is his press", async () => {
    open(view());
    await found("[data-form]");
    expect(screen.getByDisplayValue("Spring LAN registration")).toBeTruthy();
    expect([...document.querySelectorAll("[data-q]")].map((q) => q.getAttribute("data-q"))).toEqual(["name", "game", "diet"]);
    expect(screen.getByRole("tab", { name: "Questions" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(formHost.publish).toHaveBeenCalledTimes(1));
    const link = await found("[data-form-link] a");
    expect(link.textContent).toBe("tempcode.landonhale.com/f/AbCdEfGhIjKlMnOp");
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close form" }));
    await waitFor(() => expect(formHost.close).toHaveBeenCalledWith(false));
    await found("[data-form-closed]");
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(formHost.close).toHaveBeenCalledWith(true));
  });

  it("steps an agent's changes from the bar, tinted where they stand, in place of Publish", async () => {
    const by = "agent:env:t1" as const;
    open(
      view({
        suggestions: [
          { id: "s1", op: "change", question: { ...BODY.questions[1], options: ["Valorant", "Rocket League", "Marvel Rivals"] }, by, at: 1 },
          { id: "s2", op: "add", question: { id: "shirt", label: "T-shirt size", type: "dropdown", required: false, options: ["S", "M"] }, after: "diet", by, at: 1 },
        ],
      }),
    );
    await found("[data-form]");
    expect(document.querySelector('[data-q="shirt"]')?.getAttribute("data-mark")).toBe("add");
    expect(document.querySelector('[data-q="game"]')?.textContent).toContain("Marvel Rivals");
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    await waitFor(() => expect(screen.getByText("1/2")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(formHost.review).toHaveBeenCalledWith({ ids: ["s1"] }, "accept"));
  });

  it("saves his edit to a question where it stands", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      open(view());
      await found("[data-form]");
      fireEvent.click(document.querySelector('[data-q="name"]')!);
      const input = await waitFor(() => screen.getByRole("textbox", { name: "Question" }));
      fireEvent.change(input, { target: { value: "Full name" } });
      await act(async () => void vi.advanceTimersByTime(600));
      await waitFor(() => expect(formHost.save).toHaveBeenCalledTimes(1));
      expect(formHost.save.mock.calls[0][1].questions[0].label).toBe("Full name");
      fireEvent.click(screen.getByRole("switch", { name: "Required" }));
      await act(async () => void vi.advanceTimersByTime(600));
      await waitFor(() => expect(formHost.save).toHaveBeenCalledTimes(2));
      expect(formHost.save.mock.calls[1][1].questions[0].required).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends an edit made while a save is out after it, at the rev the host answered, and sends a pending one when the half closes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      open(view());
      await found("[data-form]");
      let answer: (() => void) | null = null;
      const save = formHost.save.getMockImplementation()!;
      formHost.save.mockImplementationOnce((rev, body) => new Promise((done) => (answer = () => done(save(rev, body) as never))));
      fireEvent.click(document.querySelector('[data-q="name"]')!);
      const input = await waitFor(() => screen.getByRole("textbox", { name: "Question" }));
      fireEvent.change(input, { target: { value: "Full name" } });
      await act(async () => void vi.advanceTimersByTime(600));
      expect(formHost.save).toHaveBeenCalledTimes(1);
      fireEvent.change(input, { target: { value: "Your full name" } });
      await act(async () => void vi.advanceTimersByTime(600));
      // The first is still out: the second waits for it.
      expect(formHost.save).toHaveBeenCalledTimes(1);
      await act(async () => answer!());
      await waitFor(() => expect(formHost.save).toHaveBeenCalledTimes(2));
      expect(formHost.save.mock.calls[1][0]).toBe(2);
      expect(formHost.save.mock.calls[1][1].questions[0].label).toBe("Your full name");
      // An edit, then straight to Responses: it is sent, not lost.
      fireEvent.change(screen.getByRole("textbox", { name: "Question" }), { target: { value: "Name" } });
      fireEvent.click(screen.getByRole("tab", { name: "Responses" }));
      await waitFor(() => expect(formHost.save).toHaveBeenCalledTimes(3));
      expect(formHost.save.mock.calls[2][1].questions[0].label).toBe("Name");
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds a bone in the bar while the form loads, and says a failed open on the state line with Retry", async () => {
    open(view());
    let fail: (e: Error) => void = () => undefined;
    formHost.open.mockImplementationOnce(() => new Promise((_, no) => (fail = no)));
    await found("[data-form-bar-bone]");
    expect(document.querySelector("[data-form-loading]")).not.toBeNull();
    await waitFor(() => expect(formHost.open).toHaveBeenCalled());
    fail(new Error("The host did not answer"));
    await waitFor(() => expect(screen.getByText("Couldn't open this form")).toBeTruthy());
    expect(document.querySelector("[data-form-loading]")).toBeNull();
    expect(document.querySelector("[data-form-bar-bone]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await found("[data-form]");
    expect(screen.queryByText("Couldn't open this form")).toBeNull();
  });

  it("keeps his edit when a save fails, says so on the state line, and Retry sends it again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      open(view());
      await found("[data-form]");
      formHost.save.mockRejectedValueOnce(new Error("The host did not answer"));
      fireEvent.click(document.querySelector('[data-q="name"]')!);
      const input = await waitFor(() => screen.getByRole("textbox", { name: "Question" }));
      fireEvent.change(input, { target: { value: "Full name" } });
      await act(async () => void vi.advanceTimersByTime(600));
      await waitFor(() => expect(screen.getByText("Not saved")).toBeTruthy());
      expect((screen.getByRole("textbox", { name: "Question" }) as HTMLInputElement).value).toBe("Full name");
      // Over to Responses and back: the unsaved edit is still his.
      fireEvent.click(screen.getByRole("tab", { name: "Responses" }));
      fireEvent.click(screen.getByRole("tab", { name: "Questions" }));
      expect(document.querySelector('[data-q="name"]')?.textContent).toContain("Full name");
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(formHost.save).toHaveBeenCalledTimes(2));
      expect(formHost.save.mock.calls[1][1].questions[0].label).toBe("Full name");
      await waitFor(() => expect(screen.queryByText("Not saved")).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a question from the keyboard, and a closed form's questions only read", async () => {
    open(view());
    await found("[data-form]");
    const q = document.querySelector<HTMLElement>('[data-q="name"]')!;
    expect(q.tabIndex).toBe(0);
    expect(q.getAttribute("role")).toBe("button");
    fireEvent.keyDown(q, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Question" })).toBeTruthy());
    cleanup();
    open(view({ state: "closed", closedAt: 1, link: "https://tempcode.landonhale.com/f/x" }));
    await found("[data-form-closed]");
    const closed = document.querySelector<HTMLElement>('[data-q="name"]')!;
    expect(closed.getAttribute("role")).toBeNull();
    expect(closed.className).not.toContain("hover:bg-foreground/4");
    fireEvent.click(closed);
    expect(screen.queryByRole("textbox", { name: "Question" })).toBeNull();
  });

  it("shows the responses: one summary line, the choice's bars and the table, newest first", async () => {
    open(view({ state: "open", link: "https://tempcode.landonhale.com/f/AbCdEfGhIjKlMnOp", publishedAt: 1 }));
    await found("[data-form]");
    fireEvent.click(screen.getByRole("tab", { name: "Responses" }));
    const table = await found("[data-form-responses]");
    expect(table.textContent).toContain("3 responses, the last");
    expect(screen.getByRole("img", { name: "Game: Valorant 2, Rocket League 1, Super Smash Bros. Ultimate 0" })).toBeTruthy();
    expect([...table.querySelectorAll("tbody tr")].map((r) => r.querySelectorAll("td")[1].textContent)).toEqual(["Marcus Lee", "Ava Thompson", "Jordan Kim"]);
    expect(table.querySelector('[data-slot="table"]')).not.toBeNull();
  });
});

describe("what the form canvas shows", () => {
  it("lays waiting changes over the questions where they land", () => {
    const shown = shownQuestions(BODY, [
      { id: "a", op: "add", question: { id: "x", label: "X", type: "short", required: false }, after: null, by: "agent:e:t", at: 1 },
      { id: "b", op: "remove", question: BODY.questions[2], by: "agent:e:t", at: 1 },
    ]);
    expect(shown.map((s) => [s.q.id, s.mark ?? "", s.change ?? -1])).toEqual([
      ["x", "add", 0],
      ["name", "", -1],
      ["game", "", -1],
      ["diet", "del", 1],
    ]);
  });
  it("keeps a dropped option where it stood", () => {
    expect(optionDiff(["A", "B", "C"], ["A", "C", "D"])).toEqual([{ text: "A" }, { text: "B", mark: "del" }, { text: "C" }, { text: "D", mark: "add" }]);
  });
});
