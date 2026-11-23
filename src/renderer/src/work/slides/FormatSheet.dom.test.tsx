// @vitest-environment jsdom
/**
 * The Format sheet, in the real canvas pane (docs/DESIGN.md "The slide
 * editor"): opened from the row, beside the stage on a wide canvas and under
 * the slide on a narrow one; place and size in his units, the turn, the
 * outline, a table's rows and columns.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMenus } from "../../chrome/menuRows";
import { BOX, harness, handView } from "./stage.testkit";

const holder = vi.hoisted(() => ({ current: null as never, pushes: new Set<(push: never) => void>(), opens: new Set<() => void>(), toasts: [] as string[] }));
vi.mock("../../lib/connection", async (original) => {
  const link = {
    environmentId: "local",
    connected: true,
    request: (method: string, params?: Record<string, unknown>) => (holder.current as unknown as { link: { request(m: string, p?: unknown): unknown } }).link.request(method, params),
    onPush: (listener: (push: never) => void) => (holder.pushes.add(listener), () => holder.pushes.delete(listener)),
    onOpen: (listener: () => void) => (holder.opens.add(listener), () => holder.opens.delete(listener)),
    onClose: () => () => undefined,
  };
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf: () => link, onLink: (listener: (l: typeof link, event: string) => void) => (listener(link, "added"), () => undefined) } };
});
vi.mock("./show/Show", () => ({ startShow: async () => ({ end: () => undefined, done: Promise.resolve() }) }));
vi.mock("../../components/ui/toaster", () => ({
  loadToast: async () => Object.assign((m: string) => void holder.toasts.push(m), { error: (m: string) => void holder.toasts.push(`error: ${m}`) }),
}));

import { resetCanvasStore } from "../canvas/store";

const t = harness(holder as never);
const OWN = BOX.own!;

beforeEach(async () => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Element.prototype.scrollIntoView ??= () => undefined;
  localStorage.clear();
  resetCanvasStore();
  t.reset();
  holder.toasts = [];
  await new Promise<void>((done) => openMenus(done));
});
afterEach(cleanup);

const toggle = (): HTMLElement => document.querySelector<HTMLElement>('[data-format-row] [data-format-item="format"] button')!;
const sheet = (): HTMLElement => document.querySelector<HTMLElement>("[data-slides-sheet]")!;
const field = (name: string): HTMLInputElement => within(sheet()).getByRole("textbox", { name }) as HTMLInputElement;
function type(name: string, value: string): void {
  const el = field(name);
  act(() => el.focus());
  fireEvent.change(el, { target: { value } });
  fireEvent.keyDown(el, { key: "Enter" });
}

describe("the Format sheet", () => {
  it("opens beside the stage from the row; with nothing picked it says what to do", async () => {
    await t.stage();
    fireEvent.click(toggle());
    await waitFor(() => expect(sheet().dataset.slidesSheet).toBe("beside"));
    expect(sheet().textContent).toContain("Pick a shape on the slide");
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(sheet()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.querySelector("[data-slides-sheet]")).toBeNull());
  });

  it("says the picked shape's place and size in his units and writes what he types: a size keeps its top-left", async () => {
    const { press } = await t.stage();
    press(0.6, 0.6);
    fireEvent.click(toggle());
    await waitFor(() => expect(field("Left").value).toBe("6.67 in"));
    expect([field("Top").value, field("Width").value, field("Height").value]).toEqual(["3.75 in", "2.67 in", "1.50 in"]);
    type("Width", "3");
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "geometry", slide: 3, shape: 5, box: [OWN.box[0], OWN.box[1], 2_743_200, OWN.box[3]] }]]));
    // A unit he names wins; a value it cannot read is put back and nothing goes.
    type("Left", "2 cm");
    await waitFor(() => expect(t.edits()[1]).toEqual([{ op: "geometry", slide: 3, shape: 5, box: [720_000, OWN.box[1], 2_743_200, OWN.box[3]] }]));
    type("Top", "wide");
    expect(field("Top").value).toBe("3.75 in");
    type("Rotation", "30");
    await waitFor(() => expect(t.edits()[2]).toEqual([{ op: "geometry", slide: 3, shape: 5, rot: 30 }]));
    expect(t.edits()).toHaveLength(3);
  });

  it("sets the outline's colour, weight and dash", async () => {
    const { press } = await t.stage();
    press(0.6, 0.6);
    fireEvent.click(toggle());
    await waitFor(() => expect(sheet()).toBeTruthy());
    fireEvent.click(within(sheet()).getByRole("button", { name: "Outline weight" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /2\.25 pt/ }));
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "line", slide: 3, shape: 5, width: 2.25 }]]));
    fireEvent.click(within(sheet()).getByRole("button", { name: "Outline dash" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Dot/ }));
    await waitFor(() => expect(t.edits()[1]).toEqual([{ op: "line", slide: 3, shape: 5, dash: "dot" }]));
    fireEvent.click(within(sheet()).getByRole("button", { name: "Outline colour" }));
    fireEvent.click(await screen.findByRole("button", { name: "No outline" }));
    await waitFor(() => expect(t.edits()[2]).toEqual([{ op: "line", slide: 3, shape: 5, color: null }]));
  });

  it("puts a table's row in above or below the one he names, or takes it out; a table has no turn and no outline here", async () => {
    const table = { ...BOX, id: 7, kind: "table" as const, cells: [["a", "b"], ["c", "d"], ["e", "f"]] };
    const view = handView();
    const { press } = await t.stage({ ...view, slides: [{ ...view.slides[0], shapes: [table as never] }, view.slides[1]] });
    press(0.6, 0.6);
    fireEvent.click(toggle());
    await waitFor(() => expect(sheet()).toBeTruthy());
    expect(within(sheet()).queryByRole("textbox", { name: "Rotation" })).toBeNull();
    expect(within(sheet()).queryByRole("button", { name: "Outline weight" })).toBeNull();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Row" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Row 2" }));
    fireEvent.click(within(sheet()).getByRole("button", { name: "Insert below" }));
    await waitFor(() => expect(t.edits()).toEqual([[{ op: "grid", slide: 3, shape: 7, what: "row", act: "insert", at: 2 }]]));
    fireEvent.click(within(sheet()).getAllByRole("button", { name: "Delete" })[1]);
    await waitFor(() => expect(t.edits()[1]).toEqual([{ op: "grid", slide: 3, shape: 7, what: "col", act: "delete", at: 0 }]));
  });

  it("lies under the slide in the notes' place on a narrow canvas", async () => {
    const { press } = await t.stage(handView(), { width: 600, height: 700 });
    press(0.6, 0.6);
    fireEvent.click(toggle());
    await waitFor(() => expect(sheet().dataset.slidesSheet).toBe("under"));
    expect(document.querySelector("[data-slides-main]")!.contains(sheet())).toBe(true);
    expect(document.querySelector("[data-slides-main]")!.textContent).not.toContain("Notes");
  });
});
