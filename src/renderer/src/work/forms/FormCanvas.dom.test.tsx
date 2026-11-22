// @vitest-environment jsdom
/**
 * The form kind in the real canvas pane, with a host that keeps one form's
 * view: the questions as a filler sees them, an agent's changes stepped
 * from the bar, his edit saved where it stands, Publish as his press, the
 * live link with Close form, the closed line with Reopen, and the
 * responses' summary, bars and table.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FormBody, FormResponses, FormView } from "@shared/contract-work-forms";
import type { CanvasItem } from "@shared/work";
import { openMenus } from "../../chrome/menuRows";
import { defineChunk } from "../../lib/lazyChunk";
import { CANVAS } from "../canvas/registry";
import { canvasItem, fakeHost } from "../canvas/testkit";
import { contextChipsOf, resetContextChips } from "../canvas/chips";
import type { CanvasBodyProps, CanvasKindDef } from "../canvas/kind";
import type { FormHost } from "./host";
import { liveView, optionDiff, resolvePick, shownQuestions } from "./model";

const host = vi.hoisted(() => ({
  current: null as ReturnType<typeof import("../canvas/testkit").fakeHost> | null,
  pushes: new Set<(push: never) => void>(),
  opens: new Set<() => void>(),
  toasts: [] as string[],
}));
vi.mock("../../components/ui/toaster", async (original) => ({
  ...(await original<typeof import("../../components/ui/toaster")>()),
  loadToast: async () =>
    Object.assign((m: string, o?: { description?: string }) => void host.toasts.push(o?.description ? `${m}: ${o.description}` : m), {
      error: (m: string) => void host.toasts.push(`error: ${m}`),
      success: (m: string) => void host.toasts.push(m),
    }),
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
  host.toasts = [];
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

  it("Add question opens a dialog and makes nothing until Add; Cancel makes nothing", async () => {
    open(view());
    await found("[data-form]");
    fireEvent.click(screen.getByRole("button", { name: "Add question" }));
    const dialog = await screen.findByRole("dialog", { name: "Add question" });
    // Nothing reaches the form while he writes it: no save, no placeholder question.
    fireEvent.change(screen.getByRole("textbox", { name: "Question" }), { target: { value: "Team name" } });
    await new Promise((r) => setTimeout(r, 700));
    expect(formHost.save).not.toHaveBeenCalled();
    expect(document.querySelectorAll("[data-q]")).toHaveLength(3);
    expect(dialog.textContent).not.toContain("Not saved");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await new Promise((r) => setTimeout(r, 700));
    expect(formHost.save).not.toHaveBeenCalled();
    expect(document.querySelectorAll("[data-q]")).toHaveLength(3);
  });

  it("Add makes one question with what he typed, at once", async () => {
    open(view());
    await found("[data-form]");
    fireEvent.click(screen.getByRole("button", { name: "Add question" }));
    await screen.findByRole("dialog", { name: "Add question" });
    const add = screen.getByRole("button", { name: "Add" });
    // Add waits for words.
    expect(add.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Question" }), { target: { value: "Platform" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("combobox", { name: "Kind" }));
    });
    const option = await screen.findByRole("option", { name: "Dropdown" });
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: "mouse" });
      fireEvent.click(option);
    });
    // A dropdown needs its options before it can be added.
    expect(screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Options" }), { target: { value: "PC\n\nConsole\n" } });
    fireEvent.click(screen.getByRole("switch", { name: "Required" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(formHost.save).toHaveBeenCalledTimes(1));
    const saved = formHost.save.mock.calls[0][1].questions;
    expect(saved).toHaveLength(4);
    expect(saved[3]).toMatchObject({ label: "Platform", type: "dropdown", required: true, options: ["PC", "Console"] });
    expect(saved.some((q) => q.label === "Question")).toBe(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.querySelector(`[data-q="${saved[3].id}"]`)?.textContent).toContain("Platform");
  });

  it("a refused Add keeps the dialog and his words, with the reason, and shows nothing on the form", async () => {
    open(view());
    await found("[data-form]");
    formHost.save.mockRejectedValueOnce(new Error("The form changed since"));
    fireEvent.click(screen.getByRole("button", { name: "Add question" }));
    await screen.findByRole("dialog", { name: "Add question" });
    fireEvent.change(screen.getByRole("textbox", { name: "Question" }), { target: { value: "Team name" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Add question" }).textContent).toContain("The form changed since"));
    expect((screen.getByRole("textbox", { name: "Question" }) as HTMLInputElement).value).toBe("Team name");
    // The form shows only what was made: no new question, no second account of the failure.
    expect(document.querySelectorAll("[data-q]")).toHaveLength(3);
    expect(screen.queryByText("Not saved")).toBeNull();
    // Add again lands it.
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(formHost.save).toHaveBeenCalledTimes(2);
    expect(formHost.save.mock.calls[1][1].questions.at(-1)).toMatchObject({ label: "Team name", type: "short", required: false });
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

describe("Add option", () => {
  const live = () => view({ state: "open", link: "https://tempcode.landonhale.com/f/AbCdEfGhIjKlMnOp", publishedAt: 1 });
  const openGame = async () => {
    await found("[data-form]");
    fireEvent.click(document.querySelector('[data-q="game"]')!);
    await screen.findByRole("textbox", { name: "Option 1" });
    fireEvent.click(screen.getByRole("button", { name: "Add option" }));
    return screen.findByRole("dialog", { name: "Add option" });
  };

  it("asks for the option's name and saves it on Add, never a placeholder on the live form; Cancel adds nothing", async () => {
    open(live());
    await openGame();
    // Nothing reaches the form while he names it: no save, no "Option 4".
    expect(formHost.save).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Option 4" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(formHost.save).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Option 4" })).toBeNull();
    // Named and added: one save, carrying his words.
    fireEvent.click(screen.getByRole("button", { name: "Add option" }));
    await screen.findByRole("dialog", { name: "Add option" });
    expect(screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Option" }), { target: { value: "Marvel Rivals" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(formHost.save).toHaveBeenCalledTimes(1);
    const game = formHost.save.mock.calls[0][1].questions.find((q) => q.id === "game")!;
    expect(game.options).toEqual(["Valorant", "Rocket League", "Super Smash Bros. Ultimate", "Marvel Rivals"]);
    expect(game.options!.some((o) => /^Option \d+$/.test(o))).toBe(false);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Option 4" }) as HTMLInputElement).value).toBe("Marvel Rivals"));
  });

  it("a refused Add keeps the dialog and the name, with the reason, and adds nothing to the form", async () => {
    open(live());
    formHost.save.mockRejectedValueOnce(new Error("The form changed since"));
    await openGame();
    fireEvent.change(screen.getByRole("textbox", { name: "Option" }), { target: { value: "Marvel Rivals" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Add option" }).textContent).toContain("The form changed since"));
    expect((screen.getByRole("textbox", { name: "Option" }) as HTMLInputElement).value).toBe("Marvel Rivals");
    expect(screen.queryByRole("textbox", { name: "Option 4" })).toBeNull();
    // Add again lands it.
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(formHost.save.mock.calls[1][1].questions.find((q) => q.id === "game")!.options!.at(-1)).toBe("Marvel Rivals");
  });
});

describe("turning a question to a type that takes options", () => {
  it("asks for the first option's name: Add saves the type and that option together, Cancel leaves the question as it was", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      open(view({ state: "open", link: "https://tempcode.landonhale.com/f/AbCdEfGhIjKlMnOp", publishedAt: 1 }));
      await found("[data-form]");
      fireEvent.click(document.querySelector('[data-q="diet"]')!);
      const pick = async (type: string) => {
        const trigger = await screen.findByRole("button", { name: /Long answer|Dropdown/ });
        fireEvent.click(trigger);
        fireEvent.click(await screen.findByRole("menuitem", { name: type }));
      };
      await pick("Dropdown");
      await screen.findByRole("dialog", { name: "Add option" });
      // Nothing reaches the form while he names it: no save, no "Option 1", the question still a long answer.
      await act(() => vi.advanceTimersByTimeAsync(1_000));
      expect(formHost.save).not.toHaveBeenCalled();
      expect(screen.queryByRole("textbox", { name: "Option 1" })).toBeNull();
      // Cancel: the question is as it was, and nothing is saved, then or later.
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await act(() => vi.advanceTimersByTimeAsync(1_000));
      expect(formHost.save).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: /Long answer/ })).toBeTruthy();
      // Named and added: one save, the new type and his option together.
      await pick("Dropdown");
      await screen.findByRole("dialog", { name: "Add option" });
      fireEvent.change(screen.getByRole("textbox", { name: "Option" }), { target: { value: "Vegetarian" } });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await act(() => vi.advanceTimersByTimeAsync(1_000));
      expect(formHost.save).toHaveBeenCalledTimes(1);
      const diet = formHost.save.mock.calls[0][1].questions.find((q) => q.id === "diet")!;
      expect(diet.type).toBe("dropdown");
      expect(diet.options).toEqual(["Vegetarian"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a question that already has options turns at once, keeping them, with no dialog", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      open(view({ state: "open", link: "https://tempcode.landonhale.com/f/AbCdEfGhIjKlMnOp", publishedAt: 1 }));
      await found("[data-form]");
      fireEvent.click(document.querySelector('[data-q="game"]')!);
      fireEvent.click(await screen.findByRole("button", { name: /^Choice/ }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Dropdown" }));
      expect(screen.queryByRole("dialog", { name: "Add option" })).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(1_000));
      await waitFor(() => expect(formHost.save).toHaveBeenCalledTimes(1));
      const game = formHost.save.mock.calls[0][1].questions.find((q) => q.id === "game")!;
      expect(game.type).toBe("dropdown");
      expect(game.options).toEqual(["Valorant", "Rocket League", "Super Smash Bros. Ultimate"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the responses' ticks", () => {
  it("follow each response, not its row: a newer answer above keeps his tick and Ask's quote on the same response; a removed one drops", async () => {
    resetContextChips();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      open(view({ state: "open", link: "https://tempcode.landonhale.com/f/AbCdEfGhIjKlMnOp", publishedAt: 1 }));
      await found("[data-form]");
      fireEvent.click(screen.getByRole("tab", { name: "Responses" }));
      const table = await found("[data-form-responses]");
      const rowOf = (name: string) => [...table.querySelectorAll("tbody tr")].find((r) => r.textContent?.includes(name))!;
      const ticked = () => [...table.querySelectorAll("tbody tr[data-picked]")].map((r) => r.querySelectorAll("td")[1].textContent);
      fireEvent.click(rowOf("Ava Thompson").querySelector('[aria-label="Select"]')!);
      expect(ticked()).toEqual(["Ava Thompson"]);
      // A newer answer arrives at the top on the next poll: Ava's row moves down, his tick goes with her.
      const newer = ["Riley Chen", "Valorant", "", "2026-11-19 14:05"];
      formHost.responses.mockImplementation(async () => ({ ...RESPONSES, rev: 5, rows: [newer, ...RESPONSES.rows], count: 4 }));
      await act(async () => void vi.advanceTimersByTime(10_000));
      await waitFor(() => expect(rowOf("Riley Chen")).toBeTruthy());
      expect(ticked()).toEqual(["Ava Thompson"]);
      // Ask carries the response he chose, not whichever now sits in her old row.
      const bar = await screen.findByRole("toolbar", { name: "Selection" });
      fireEvent.click(within(bar).getByRole("button", { name: /^Ask/ }));
      const chip = contextChipsOf("t1")[0]!;
      expect(chip.label).toBe("1 response, Spring LAN registration");
      expect(chip.quote).toContain("Ava Thompson");
      expect(chip.quote).not.toContain("Marcus Lee");
      // Her response is gone from the next revision: nothing stays ticked in her place.
      formHost.responses.mockImplementation(async () => ({ ...RESPONSES, rev: 6, rows: [newer, RESPONSES.rows[0]!, RESPONSES.rows[2]!], count: 3 }));
      await act(async () => void vi.advanceTimersByTime(10_000));
      await waitFor(() => expect(rowOf("Ava Thompson")).toBeUndefined());
      expect(ticked()).toEqual([]);
      expect(screen.queryByRole("toolbar", { name: "Selection" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the form kind, round two", () => {
  it("drops the switch whole in a narrow bar only while changes wait, and stepping to a change shows the questions", async () => {
    const by = "agent:env:t1" as const;
    open(
      view({
        suggestions: [
          { id: "s1", op: "change", question: { ...BODY.questions[1], options: ["Valorant", "Marvel Rivals"] }, by, at: 1 },
          { id: "s2", op: "add", question: { id: "shirt", label: "T-shirt size", type: "dropdown", required: false, options: ["S", "M"] }, after: "diet", by, at: 1 },
        ],
      }),
    );
    await found("[data-form]");
    const tabs = screen.getByRole("tablist", { name: "Half" }).closest<HTMLElement>("[data-narrow-hide]")!;
    expect(tabs).not.toBeNull();
    expect(tabs.className).toContain("@max-[560px]/bar:hidden");
    // On Questions the stepper steps through the changes on screen.
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Next change" })));
    await waitFor(() => expect(screen.getByText("2/2")).toBeTruthy());
    expect(document.querySelector('[data-q="shirt"]')).not.toBeNull();
    cleanup();
    open(view());
    await found("[data-form]");
    const calm = screen.getByRole("tablist", { name: "Half" }).closest<HTMLElement>('[class*="shrink-0"]')!;
    expect(calm.hasAttribute("data-narrow-hide")).toBe(false);
    expect(calm.className).not.toContain("@max-[560px]/bar:hidden");
  });

  it("on Responses with changes waiting draws no stepper, only one compact Questions control that brings the stepper back", async () => {
    const by = "agent:env:t1" as const;
    open(view({ suggestions: [{ id: "s1", op: "change", question: { ...BODY.questions[1], options: ["Valorant", "Marvel Rivals"] }, by, at: 1 }] }));
    await found("[data-form]");
    await waitFor(() => expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Responses" }));
    await waitFor(() => expect(document.querySelector("[data-q]")).toBeNull());
    // No change is on screen: no stepper, no "0/1", no verbs waiting on nothing.
    await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Review changes" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.queryByText("0/1")).toBeNull();
    // The switch gives way whole in a narrow bar, and the one compact control shows only there: never both.
    const tabs = screen.getByRole("tablist", { name: "Half" }).closest<HTMLElement>("[data-narrow-hide]")!;
    expect(tabs.className).toContain("@max-[560px]/bar:hidden");
    const controls = document.querySelectorAll<HTMLElement>("[data-form-to-questions]");
    expect(controls).toHaveLength(1);
    expect(controls[0].className).toContain("hidden");
    expect(controls[0].className).toContain("@max-[560px]/bar:inline-flex");
    expect(controls[0].className).toContain("shrink-0");
    expect(controls[0].textContent).toBe("Questions1");
    fireEvent.click(controls[0]);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Questions" }).getAttribute("aria-selected")).toBe("true"));
    expect(document.querySelector("[data-form-to-questions]")).toBeNull();
    // The change is on screen again, and so is the stepper that decides it.
    await waitFor(() => expect(screen.getByRole("button", { name: "Accept" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(formHost.review).toHaveBeenCalledWith({ ids: ["s1"] }, "accept"));
  });

  it("gives the live link a worded Copy link for a narrow bar in place of the address and its glyph", async () => {
    open(view({ state: "open", link: "https://tempcode.landonhale.com/f/AbCdEfGhIjKlMnOp", publishedAt: 1 }));
    const link = await found("[data-form-link]");
    expect(link.querySelector("a")?.className).toContain("@max-[600px]/bar:hidden");
    expect(link.querySelector('[aria-label="Copy link"]')?.className).toContain("@max-[600px]/bar:hidden");
    const word = link.querySelector<HTMLElement>("[data-form-copy-word]")!;
    expect(word.className).toContain("hidden @max-[600px]/bar:inline-flex");
    expect(word.textContent).toBe("Copy link");
  });

  it("edits a question in the design system's fields", async () => {
    open(view());
    await found("[data-form]");
    expect(screen.getByRole("textbox", { name: "Title" }).getAttribute("data-slot")).toBe("input");
    expect(screen.getByRole("textbox", { name: "Description" }).getAttribute("data-slot")).toBe("textarea");
    fireEvent.click(document.querySelector('[data-q="game"]')!);
    expect((await waitFor(() => screen.getByRole("textbox", { name: "Question" }))).getAttribute("data-slot")).toBe("input");
    expect(screen.getByRole("textbox", { name: "Option 1" }).getAttribute("data-slot")).toBe("input");
  });

  it("says a draft's responses are not there because it is not published, never as none", async () => {
    open(view({ state: "draft" }));
    await found("[data-form]");
    fireEvent.click(screen.getByRole("tab", { name: "Responses" }));
    await waitFor(() => expect(screen.getByText("Not published")).toBeTruthy());
    expect(screen.queryByText("No responses yet")).toBeNull();
  });

  it("says responses that fail to read on the state line with Retry, not as none", async () => {
    open(view({ state: "open", link: "https://tempcode.landonhale.com/f/AbCdEfGhIjKlMnOp", publishedAt: 1 }));
    await found("[data-form]");
    formHost.responses.mockRejectedValueOnce(new Error("not connected"));
    fireEvent.click(screen.getByRole("tab", { name: "Responses" }));
    await waitFor(() => expect(screen.getByText("Couldn't read the responses")).toBeTruthy());
    expect(screen.queryByText("No responses yet")).toBeNull();
    expect(document.querySelector("[data-form-responses]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await found("[data-form-responses]");
    expect(screen.queryByText("Couldn't read the responses")).toBeNull();
    // Back on Questions the line is gone: it was Responses' to say.
    formHost.responses.mockRejectedValue(new Error("not connected"));
    fireEvent.click(screen.getByRole("tab", { name: "Questions" }));
    expect(screen.queryByText("Couldn't read the responses")).toBeNull();
    formHost.responses.mockReset();
  });
});

describe("the form kind, round seven", () => {
  const by = "agent:env:t1" as const;
  const waitingChange = () => view({ suggestions: [{ id: "s1", op: "change", question: { ...BODY.questions[1], options: ["Valorant", "Marvel Rivals"] }, by, at: 1 }] });
  /** More's rows as the menu draws them, the menu closed again. */
  const moreRows = async (): Promise<string[]> => {
    // The tab row's More comes first; an open question has a More of its own.
    fireEvent.click(screen.getAllByRole("button", { name: "More" })[0]);
    const rows = (await screen.findAllByRole("menuitem")).map((row) => row.textContent ?? "");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
    return rows;
  };
  const edit = async (value: string): Promise<void> => {
    fireEvent.click(document.querySelector('[data-q="name"]')!);
    const input = await waitFor(() => screen.getByRole("textbox", { name: "Question" }));
    fireEvent.change(input, { target: { value } });
  };

  it("holds the stepper with its verbs off while his unsaved edits hide the change, and lets go once the save lands", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      open(waitingChange());
      await found("[data-form]");
      await waitFor(() => expect(screen.getByRole("toolbar", { name: "Review changes" })).toBeTruthy());
      expect(await moreRows()).toContain("Accept all");
      let land: (() => void) | null = null;
      const save = formHost.save.getMockImplementation()!;
      formHost.save.mockImplementationOnce((rev, body) => new Promise((done) => (land = () => done(save(rev, body) as never))));
      await edit("Full name");
      // His words stand over the questions and the diff is gone. The stepper stays drawn, so the bar does not flicker at each
      // pause in his typing, but neither it nor More decides anything he cannot see.
      await waitFor(() => expect(document.querySelector('[data-q="game"]')?.textContent).not.toContain("Marvel Rivals"));
      const verbsOff = (): void => {
        expect(screen.getByRole("toolbar", { name: "Review changes" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Accept" }).hasAttribute("disabled")).toBe(true);
        expect(screen.getByRole("button", { name: "Reject" }).hasAttribute("disabled")).toBe(true);
      };
      await waitFor(verbsOff);
      fireEvent.click(screen.getAllByRole("button", { name: "More" })[0]);
      const acceptAll = await screen.findByRole("menuitem", { name: /Accept all/ });
      expect(acceptAll.getAttribute("aria-disabled") ?? acceptAll.getAttribute("data-disabled")).not.toBeNull();
      fireEvent.click(acceptAll);
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
      // The save goes out, and while it is out nothing changes.
      await act(async () => void vi.advanceTimersByTime(600));
      expect(formHost.save).toHaveBeenCalledTimes(1);
      verbsOff();
      await act(async () => land!());
      await waitFor(() => expect(screen.getByRole("button", { name: "Accept" }).hasAttribute("disabled")).toBe(false));
      expect(document.querySelector('[data-q="game"]')?.textContent).toContain("Marvel Rivals");
      expect(await moreRows()).toContain("Accept all");
      expect(formHost.review).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the review away through a failed save, and gives it back once Retry lands the edit", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      open(waitingChange());
      await found("[data-form]");
      await waitFor(() => expect(screen.getByRole("toolbar", { name: "Review changes" })).toBeTruthy());
      formHost.save.mockRejectedValueOnce(new Error("The host did not answer"));
      await edit("Full name");
      await act(async () => void vi.advanceTimersByTime(600));
      await waitFor(() => expect(screen.getByText("Not saved")).toBeTruthy());
      expect(screen.queryByRole("toolbar", { name: "Review changes" })).toBeNull();
      expect(await moreRows()).not.toContain("Reject all");
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(screen.queryByText("Not saved")).toBeNull());
      await waitFor(() => expect(screen.getByRole("toolbar", { name: "Review changes" })).toBeTruthy());
      expect(formHost.review).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds Publish until his latest edit has saved, and through a failed save until Retry lands it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      open(view());
      await found("[data-form]");
      const publish = () => screen.getByRole("button", { name: "Publish" });
      expect(publish().hasAttribute("disabled")).toBe(false);
      let land: (() => void) | null = null;
      const save = formHost.save.getMockImplementation()!;
      formHost.save.mockImplementationOnce((rev, body) => new Promise((done) => (land = () => done(save(rev, body) as never))));
      // Queued: the host still holds the copy before this edit.
      await edit("Full name");
      await waitFor(() => expect(publish().hasAttribute("disabled")).toBe(true));
      fireEvent.click(publish());
      expect(formHost.publish).not.toHaveBeenCalled();
      // Out: still off. Landed: on.
      await act(async () => void vi.advanceTimersByTime(600));
      expect(formHost.save).toHaveBeenCalledTimes(1);
      expect(publish().hasAttribute("disabled")).toBe(true);
      await act(async () => land!());
      await waitFor(() => expect(publish().hasAttribute("disabled")).toBe(false));
      // A save refused: off, with the save's error and Retry; on once Retry lands it.
      formHost.save.mockRejectedValueOnce(new Error("The host did not answer"));
      fireEvent.change(screen.getByRole("textbox", { name: "Question" }), { target: { value: "Your name" } });
      await act(async () => void vi.advanceTimersByTime(600));
      await waitFor(() => expect(screen.getByText("Not saved")).toBeTruthy());
      expect(publish().hasAttribute("disabled")).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(publish().hasAttribute("disabled")).toBe(false));
      fireEvent.click(publish());
      await waitFor(() => expect(formHost.publish).toHaveBeenCalledTimes(1));
      expect(formHost.save.mock.calls.at(-1)![1].questions[0].label).toBe("Your name");
    } finally {
      vi.useRealTimers();
    }
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

describe("the form kind, round eight", () => {
  const by = "agent:env:t1" as const;
  const game = BODY.questions[1];
  const outlined = (): string | null => document.querySelector('[data-q][aria-current="true"]')?.getAttribute("data-change") ?? null;

  it("draws each of two changes to one question against the saved question, and the outline, scroll and press follow the one shown", async () => {
    const scrolled: Element[] = [];
    const was = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      open(
        view({
          suggestions: [
            { id: "s1", op: "change", question: { ...game, options: ["Valorant", "Rocket League", "Marvel Rivals"] }, by, at: 1 },
            { id: "s2", op: "change", question: { ...game, label: "Main game" }, by, at: 2 },
          ],
        }),
      );
      await found("[data-form]");
      await waitFor(() => expect(screen.getByText("1/2")).toBeTruthy());
      const row = (): Element => document.querySelector('[data-q="game"]')!;
      // The first: its own options, never the second's label.
      expect(row().textContent).toContain("Marvel Rivals");
      expect(row().textContent).not.toContain("Main game");
      expect(outlined()).toBe("0");
      fireEvent.click(screen.getByRole("button", { name: "Next change" }));
      await waitFor(() => expect(screen.getByText("2/2")).toBeTruthy());
      // The second, against the saved question: its new label over the old, and the saved options with no diff.
      expect(row().textContent).toContain("Main game");
      expect(row().querySelector("s")?.textContent).toBe("Game");
      expect(row().textContent).not.toContain("Marvel Rivals");
      expect(outlined()).toBe("1");
      await waitFor(() => expect(scrolled.at(-1)?.getAttribute("data-change")).toBe("1"));
      fireEvent.click(screen.getByRole("button", { name: "Accept" }));
      await waitFor(() => expect(formHost.review).toHaveBeenLastCalledWith({ ids: ["s2"] }, "accept"));
      // Decided, it goes: the selection re-seats on the change left, which the question now draws, outlined.
      await waitFor(() => expect(row().textContent).toContain("Marvel Rivals"));
      expect(outlined()).toBe("0");
      fireEvent.click(screen.getByRole("button", { name: "Accept" }));
      await waitFor(() => expect(formHost.review).toHaveBeenLastCalledWith({ ids: ["s1"] }, "accept"));
    } finally {
      Element.prototype.scrollIntoView = was;
    }
  });

  it("after the last of several changes is decided, the stepper and the body take the one now last, and it comes into view", async () => {
    const scrolled: Element[] = [];
    const was = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      open(
        view({
          suggestions: [
            { id: "s1", op: "change", question: { ...BODY.questions[0], label: "Full name" }, by, at: 1 },
            { id: "s2", op: "change", question: { ...game, label: "Main game" }, by, at: 1 },
            { id: "s3", op: "remove", question: BODY.questions[2], by, at: 1 },
          ],
        }),
      );
      await found("[data-form]");
      fireEvent.click(document.querySelector('[data-q="diet"]')!);
      await waitFor(() => expect(screen.getByText("3/3")).toBeTruthy());
      expect(outlined()).toBe("2");
      fireEvent.click(screen.getByRole("button", { name: "Accept" }));
      await waitFor(() => expect(formHost.review).toHaveBeenLastCalledWith({ ids: ["s3"] }, "accept"));
      await waitFor(() => expect(screen.getByText("2/2")).toBeTruthy());
      // One selection: the body outlines what the bar's Accept would take, and scrolls to it.
      expect(outlined()).toBe("1");
      expect(document.querySelector('[data-change="1"]')?.getAttribute("data-q")).toBe("game");
      await waitFor(() => expect(scrolled.at(-1)?.getAttribute("data-q")).toBe("game"));
      fireEvent.click(screen.getByRole("button", { name: "Accept" }));
      await waitFor(() => expect(formHost.review).toHaveBeenLastCalledWith({ ids: ["s2"] }, "accept"));
    } finally {
      Element.prototype.scrollIntoView = was;
    }
  });

  it("lists a proposed dropdown's choices, with the options it adds and drops, and leaves a dropdown at rest a closed box", async () => {
    const size = { id: "size", label: "T-shirt size", type: "dropdown" as const, required: false, options: ["S", "M", "L"] };
    open(
      view({
        body: { ...BODY, questions: [...BODY.questions, size, { ...size, id: "team", label: "Team", options: ["Red", "Blue"] }] },
        suggestions: [
          { id: "s1", op: "change", question: { ...size, options: ["S", "M", "XL"] }, by, at: 1 },
          { id: "s2", op: "add", question: { id: "shirt", label: "Hoodie size", type: "dropdown", required: false, options: ["S", "M"] }, after: "diet", by, at: 1 },
        ],
      }),
    );
    await found("[data-form]");
    const options = (id: string) => [...document.querySelectorAll(`[data-q="${id}"] [data-option]`)].map((o) => `${o.textContent}${o.getAttribute("data-option") ? `:${o.getAttribute("data-option")}` : ""}`);
    expect(options("size")).toEqual(["S", "M", "XL:add", "L:del"]);
    expect(options("shirt")).toEqual(["S", "M"]);
    // At rest: the filler's closed box, no list.
    expect(document.querySelector('[data-q="team"]')?.textContent).toContain("Choose");
    expect(options("team")).toEqual([]);
  });

  it("shows Required turned on or off by a change, either way", async () => {
    open(
      view({
        suggestions: [
          { id: "s1", op: "change", question: { ...BODY.questions[0], required: false }, by, at: 1 },
          { id: "s2", op: "change", question: { ...BODY.questions[2], required: true }, by, at: 1 },
        ],
      }),
    );
    await found("[data-form]");
    const off = document.querySelector('[data-q="name"] [data-required]');
    expect(off?.getAttribute("data-required")).toBe("del");
    expect(off?.textContent).toBe("Required");
    const on = document.querySelector('[data-q="diet"] [data-required]');
    expect(on?.getAttribute("data-required")).toBe("add");
    expect(on?.textContent).toBe("Required");
    // A question no change touches keeps the filler's asterisk alone.
    expect(document.querySelector('[data-q="game"] [data-required]')).toBeNull();
    expect(document.querySelector('[data-q="game"]')?.textContent).toContain("*");
  });
});

describe("the form's one selection", () => {
  const s = (id: string) => ({ id, op: "remove" as const, question: BODY.questions[0], by: "agent:env:t1" as const, at: 1 });
  it("follows the picked change by its id, and re-seats where a decision took it away", () => {
    expect(resolvePick([], { id: null, at: 0 })).toBe(-1);
    expect(resolvePick([s("a"), s("b"), s("c")], { id: "b", at: 1 })).toBe(1);
    // Another change decided before it: the pick moves with its change.
    expect(resolvePick([s("b"), s("c")], { id: "b", at: 1 })).toBe(0);
    // The pick itself decided: the change now in its place, or the last.
    expect(resolvePick([s("a"), s("c")], { id: "b", at: 1 })).toBe(1);
    expect(resolvePick([s("a"), s("b")], { id: "c", at: 2 })).toBe(1);
  });
  it("draws, of two changes to one question, the selected one, else the first", () => {
    const two = [
      { id: "s1", op: "change" as const, question: { ...BODY.questions[1], label: "First" }, by: "agent:env:t1" as const, at: 1 },
      { id: "s2", op: "change" as const, question: { ...BODY.questions[1], label: "Second" }, by: "agent:env:t1" as const, at: 1 },
    ];
    expect(shownQuestions(BODY, two).find((x) => x.q.id === "game")).toMatchObject({ change: 0, q: { label: "First" }, was: { label: "Game" } });
    expect(shownQuestions(BODY, two, 1).find((x) => x.q.id === "game")).toMatchObject({ change: 1, q: { label: "Second" }, was: { label: "Game" } });
  });
});

describe("the form kind, round nine", () => {
  const by = "agent:env:t1" as const;

  it("never counts, steps to or decides a saved change to a question that is gone", async () => {
    open(
      view({
        suggestions: [
          { id: "gone", op: "change", question: { id: "old", label: "Old question", type: "short", required: false }, by, at: 1 },
          { id: "s1", op: "change", question: { ...BODY.questions[1], options: ["Valorant", "Marvel Rivals"] }, by, at: 1 },
        ],
      }),
    );
    await found("[data-form]");
    // One change stands, so the stepper counts one (a lone change shows no "1/2"), and its Accept is that change's.
    await waitFor(() => expect(screen.getByRole("toolbar", { name: "Review changes" })).toBeTruthy());
    expect(screen.queryByText("1/2")).toBeNull();
    expect(screen.queryByText("2/2")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(formHost.review).toHaveBeenCalledWith({ ids: ["s1"] }, "accept"));
    expect(document.querySelector('[data-q="old"]')).toBeNull();
  });

  it("names, once, the changes an accepted removal cleared with its question", async () => {
    open(
      view({
        suggestions: [
          { id: "s1", op: "remove", question: BODY.questions[2], by, at: 1 },
          { id: "s2", op: "change", question: { ...BODY.questions[2], label: "Allergies" }, by, at: 1 },
        ],
      }),
    );
    await found("[data-form]");
    formHost.review.mockImplementationOnce(async () => ({ ...view({ itemId: item.id, body: { ...BODY, questions: BODY.questions.slice(0, 2) } }), cleared: ["Change Dietary needs"] }));
    await waitFor(() => expect(screen.getByText("1/2")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(host.toasts).toEqual(["Cleared 1 change to the removed question: Change Dietary needs"]));
    expect(document.querySelector('[data-q="diet"]')).toBeNull();
    expect(screen.queryByRole("toolbar", { name: "Review changes" })).toBeNull();
  });

  it("an accept that cleared nothing says nothing", async () => {
    open(view({ suggestions: [{ id: "s1", op: "change", question: { ...BODY.questions[0], label: "Full name" }, by, at: 1 }] }));
    await found("[data-form]");
    await waitFor(() => expect(screen.getByRole("toolbar", { name: "Review changes" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(formHost.review).toHaveBeenCalled());
    expect(host.toasts).toEqual([]);
  });

  it("keeps the view as it is when every change stands", () => {
    const v = view({ suggestions: [{ id: "a", op: "add", question: { id: "new", label: "New", type: "short", required: false }, after: null, by, at: 1 }] });
    expect(liveView(v)).toBe(v);
    const gone = view({ suggestions: [{ id: "g", op: "remove", question: { id: "old", label: "Old", type: "short", required: false }, by, at: 1 }] });
    expect(liveView(gone).suggestions).toEqual([]);
  });
});
