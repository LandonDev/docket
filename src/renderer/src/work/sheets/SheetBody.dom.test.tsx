// @vitest-environment jsdom
/**
 * The sheet kind in the real canvas pane, with a host that keeps one item's
 * view and op log and a table in place of Univer's grid: suggestions laid
 * into their cells and stepped from the bar, edits sent in batches from the
 * revision the grid stands at, a conflict caught up and sent again, another
 * person's op brought in, the written line, charts and pictures, and the switch.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SheetMutationJson, SheetView } from "@shared/contract-work-sheets";
import { SHEET_EDIT_MAX, SHEET_LOAD_MAX, SHEET_NOTES } from "@shared/contract-work-sheets";
import type { CanvasItem } from "@shared/work";
import { openMenus } from "../../chrome/menuRows";
import { defineChunk } from "../../lib/lazyChunk";
import { CANVAS } from "../canvas/registry";
import { canvasItem, fakeHost } from "../canvas/testkit";
import type { CanvasBodyProps, CanvasKindDef } from "../canvas/kind";
import { EDIT_MAX, LOAD_MAX } from "./host";
import { EDIT_WAIT, resetSheetSyncs } from "./sync";
import { fakeGrid, fakeSheetHost, sheetView, suggestion, workbookOf, type FakeGrid, type FakeSheetHost } from "./testkit";

const host = vi.hoisted(() => ({
  current: null as ReturnType<typeof import("../canvas/testkit").fakeHost> | null,
  pushes: new Set<(push: never) => void>(),
  opens: new Set<() => void>(),
}));
/** What the body said in a toast (sonner rides its own chunk; the body speaks through `loadToast`). */
const toasts = vi.hoisted(() => ({ said: [] as string[] }));
vi.mock("../../components/ui/toaster", async (original) => {
  const say = (text: string) => void toasts.said.push(text);
  return { ...(await original<typeof import("../../components/ui/toaster")>()), loadToast: async () => Object.assign(say, { message: say, success: say, error: say }) };
});
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

/** The side sheet itself is work-kit's (its own tests draw it on a real grid): here a stand-in that shows what the body gives it. */
vi.mock("work-kit/sheet", async (original) => ({
  ...(await original<typeof import("work-kit/sheet")>()),
  RulesSheet: ({ open, kinds, stacked, onOpen, onClose }: { open: { view: string }; kinds?: readonly string[]; stacked?: boolean; onOpen(next: unknown): void; onClose(): void }) => (
    <aside data-rules-sheet="" data-view={open.view} data-kinds={(kinds ?? []).join(" ")} data-stacked={String(!!stacked)}>
      <button onClick={() => onOpen({ view: "rule", kind: "conditional", id: "cf1" })}>open a rule</button>
      <button onClick={onClose}>close rules</button>
    </aside>
  ),
}));

import { CanvasSeat } from "../canvas/CanvasSeat";
import { contextChipsOf, resetContextChips } from "../canvas/chips";
import { resetCanvasStore } from "../canvas/store";

const ITEM: CanvasItem = canvasItem("s1", { kind: "sheet", title: "Nationals travel budget.xlsx", source: { at: "file", host: "local", path: "/work/budget.xlsx" } });
const BOOK = workbookOf([
  {
    id: "budget",
    name: "Budget",
    rows: [
      ["Item", "Qty", "Days", "Rate", "Total"],
      ["Flights", 14, null, 412, 5768],
      ["Hotel", 7, 3, 189, 3969],
      ["Ground", null, null, null, 1240],
      ["Meals", 14, 3, 55, 2310],
    ],
  },
  { id: "quotes", name: "Quotes", rows: [] },
]);
/** What a host sends for a sheet whose store keeps formatting. */
const ROW_ALL: NonNullable<SheetView["row"]> = ["undo", "style", "font", "size", "bold", "italic", "underline", "colour", "fill", "align", "vertical", "wrap", "merge", "borders", "number"];
const set = (row: number, col: number, v: number | string): SheetMutationJson => ({ id: "sheet.mutation.set-range-values", params: { unitId: "book", subUnitId: "budget", cellValue: { [row]: { [col]: { v } } } } });

let sheetHost: FakeSheetHost;
let grid: FakeGrid;

function kinds(): Record<string, CanvasKindDef> {
  const deps = () => ({ host: sheetHost, grid });
  const module = import("./SheetBody").then((m) => ({
    Body: (props: CanvasBodyProps) => <m.Body {...(props as CanvasBodyProps<undefined>)} {...deps()} />,
    Bar: (props: CanvasBodyProps) => <m.Bar {...(props as CanvasBodyProps<undefined>)} {...deps()} />,
    TabEnd: (props: CanvasBodyProps) => <m.TabEnd {...(props as CanvasBodyProps<undefined>)} {...deps()} />,
  }));
  return { ...CANVAS, sheet: { ...CANVAS.sheet, chunk: defineChunk("test-sheet", () => module) } };
}

function open(view: SheetView, options: { selection?: string; item?: CanvasItem; commands?: boolean } = {}) {
  sheetHost = fakeSheetHost(view, BOOK);
  grid = fakeGrid(options);
  host.current = fakeHost([options.item ?? ITEM], host as never);
  return render(
    <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
      <div data-testid="thread" />
    </CanvasSeat>,
  );
}

const cell = (a1: string): HTMLElement => document.querySelector<HTMLElement>(`[data-cell="${a1}"]`)!;
// (the first open in the file loads the grid's code cold: over a second on a busy host)
const gridUp = () => waitFor(() => expect(grid.listening()).toBe(true), { timeout: 5000 });
const edits = () => sheetHost.calls.filter((c) => c[0] === "edit").map((c) => c[1] as { baseRev: number; mutations: SheetMutationJson[] });

beforeEach(async () => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  localStorage.clear();
  resetCanvasStore();
  resetSheetSyncs();
  resetContextChips();
  await new Promise<void>((done) => openMenus(done));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  toasts.said.length = 0;
});

describe("the sheet kind", () => {
  it("holds the contract's limits", () => {
    expect(LOAD_MAX).toBe(SHEET_LOAD_MAX);
    expect(EDIT_MAX).toBe(SHEET_EDIT_MAX);
  });

  it("loads the workbook at the view's rev and shows the loading shape until then", async () => {
    sheetHost = fakeSheetHost(sheetView(), BOOK);
    sheetHost.hold = true;
    grid = fakeGrid();
    host.current = fakeHost([ITEM], host as never);
    render(
      <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
        <div />
      </CanvasSeat>,
    );
    expect(await screen.findByLabelText("Loading")).toBeTruthy();
    cleanup();
    resetSheetSyncs();
    open(sheetView({ rev: 3 }));
    await gridUp();
    expect(sheetHost.calls).toContainEqual(["load", { rev: 3, offset: 0, length: LOAD_MAX }]);
    expect(cell("A2").textContent).toBe("Flights");
  });

  it("lays each suggestion into its cell, steps a run as one, says what it replaces, and accepts it", async () => {
    open(
      sheetView({
        suggestions: [
          suggestion("a", 1, 3, { base: { v: 412 }, proposed: { v: 438 }, reason: "Delta group fare" }),
          suggestion("b", 2, 3, { base: { v: 189 }, proposed: { v: 172 } }),
          suggestion("c", 2, 4, { base: { v: 3969 }, proposed: { v: 3612 } }),
        ],
      }),
    );
    await gridUp();
    const bar = await screen.findByRole("toolbar", { name: "Review changes" });
    expect(within(bar).getByText("1/2")).toBeTruthy();
    await waitFor(() => expect(cell("D2").textContent).toBe("438"));
    expect(cell("D2").dataset.mark).toBe("current");
    expect(cell("D3").dataset.mark).toBe("pending");
    expect(cell("E3").textContent).toBe("3612");

    fireEvent.click(within(bar).getByRole("button", { name: "Next change" }));
    await waitFor(() => expect(cell("E3").dataset.mark).toBe("current"));
    expect(cell("D3").dataset.mark).toBe("current");
    expect(document.querySelector("[data-sheet-was]")?.textContent).toBe("was 189");

    fireEvent.click(within(bar).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(sheetHost.calls).toContainEqual(["review", { which: { ids: ["b", "c"] }, verdict: "accept" }]));
    // One change left: the stepper keeps its verbs and drops the count it could not step through.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Next change" })).toBeNull());
    expect(within(screen.getByRole("toolbar", { name: "Review changes" })).getByRole("button", { name: "Accept" })).toBeTruthy();
  });

  it("reads the view again when the host says it changed and sends none (a sheet others can open)", async () => {
    open(sheetView({ shared: true }));
    await gridUp();
    expect(screen.queryByRole("toolbar", { name: "Review changes" })).toBeNull();
    const opens = sheetHost.calls.filter((c) => c[0] === "open").length;
    sheetHost.view = { ...sheetHost.view, suggestions: [suggestion("a", 1, 3, { base: { v: 412 }, proposed: { v: 438 } })] };
    act(() => sheetHost.push({ rev: sheetHost.rev, stale: true }));
    await screen.findByRole("toolbar", { name: "Review changes" });
    await waitFor(() => expect(cell("D2").textContent).toBe("438"));
    expect(sheetHost.calls.filter((c) => c[0] === "open").length).toBe(opens + 1);
  });

  it("puts a cell back when its suggestion is rejected, unless something wrote it since", async () => {
    open(sheetView({ suggestions: [suggestion("a", 1, 3, { base: { v: 412 }, proposed: { v: 438 } }), suggestion("b", 3, 4, { base: { v: 1240 }, proposed: { v: 1380 }, changeSet: "cs2" })] }));
    await gridUp();
    await waitFor(() => expect(cell("D2").textContent).toBe("438"));
    // Dana writes E4 over the laid value; then both suggestions go.
    act(() => grid.handle!.apply([set(3, 4, 1500)]));
    act(() => sheetHost.push({ rev: sheetHost.rev, view: { ...sheetHost.view, suggestions: [] } }));
    await waitFor(() => expect(cell("D2").textContent).toBe("412"));
    expect(cell("E4").textContent).toBe("1500");
  });

  it("sends edits in one batch from the rev it stands at, and after a conflict catches up and sends again", async () => {
    open(sheetView({ rev: 3 }));
    await gridUp();
    act(() => {
      grid.edit(set(1, 1, 15));
      grid.edit(set(2, 1, 8));
    });
    await waitFor(() => expect(edits()).toHaveLength(1), { timeout: EDIT_WAIT * 10 });
    expect(edits()[0]).toEqual({ baseRev: 3, mutations: [set(1, 1, 15), set(2, 1, 8)] });

    sheetHost.conflictNext = true;
    act(() => grid.edit(set(4, 1, 12)));
    await waitFor(() => expect(edits()).toHaveLength(3), { timeout: EDIT_WAIT * 10 });
    // Refused at 4, Dana's op 5 brought in, sent again from 5.
    expect(edits()[1].baseRev).toBe(4);
    expect(sheetHost.calls).toContainEqual(["since", 4]);
    expect(edits()[2]).toEqual({ baseRev: 5, mutations: [set(4, 1, 12)] });
    await waitFor(() => expect(cell("F1").textContent).toBe("Dana"));
  });

  it("brings in another person's op on a push, and not its own", async () => {
    open(sheetView({ rev: 3 }));
    await gridUp();
    act(() => grid.edit(set(1, 1, 15)));
    await waitFor(() => expect(edits()).toHaveLength(1), { timeout: EDIT_WAIT * 10 });
    act(() => sheetHost.push({ rev: 4 }));
    act(() => sheetHost.land([set(4, 3, 50)]));
    await waitFor(() => expect(cell("D5").textContent).toBe("50"));
    const appliedIds = grid.applied.flat().map((m) => JSON.stringify(m.params));
    expect(appliedIds).not.toContain(JSON.stringify(set(1, 1, 15).params));
  });

  it("says a failed save once with Retry, which sends the edits again", async () => {
    open(sheetView({ store: "tcsheet" }));
    await gridUp();
    const edit = sheetHost.edit;
    sheetHost.edit = async () => {
      throw new Error("The host did not answer");
    };
    act(() => grid.edit(set(1, 1, 15)));
    expect(await screen.findByText("Couldn't save")).toBeTruthy();
    sheetHost.edit = edit;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(edits()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("Couldn't save")).toBeNull());
  });

  it("offers Reload when an opened Excel file refuses an edit, and loads it again", async () => {
    open(sheetView());
    await gridUp();
    sheetHost.edit = async () => {
      throw new Error("An opened Excel file keeps only cell contents here; formatting is not saved");
    };
    act(() => grid.edit(set(1, 1, 15)));
    expect(await screen.findByText("Couldn't save")).toBeTruthy();
    const loads = sheetHost.calls.filter((c) => c[0] === "load").length;
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(sheetHost.calls.filter((c) => c[0] === "load").length).toBeGreaterThan(loads));
    await waitFor(() => expect(screen.queryByText("Couldn't save")).toBeNull());
  });

  it("sends an opened Excel file what it saves (cells, a cell's style, a width, a merge, rows, a fill with its formulas), with no line about it, and never resends a refused batch", async () => {
    open(sheetView({ store: "package", rev: 3, row: ROW_ALL }));
    await gridUp();
    grid.formulas.set("budget!2:4", "=SUM(B3:D3)");
    const bold: SheetMutationJson = { id: "sheet.mutation.set-range-values", params: { unitId: "book", subUnitId: "budget", cellValue: { 1: { 1: { s: { bl: 1 } } } } } };
    const fill: SheetMutationJson = { id: "sheet.mutation.set-range-values", params: { unitId: "book", subUnitId: "budget", cellValue: { 2: { 4: { si: "f1" } } } } };
    const row: SheetMutationJson = { id: "sheet.mutation.insert-row", params: { unitId: "book", subUnitId: "budget" } };
    const widen: SheetMutationJson = { id: "sheet.mutation.set-worksheet-col-width", params: { unitId: "book", subUnitId: "budget", ranges: [{ startRow: 0, endRow: 0, startColumn: 1, endColumn: 1 }], colWidth: 160 } };
    const merge: SheetMutationJson = { id: "sheet.mutation.add-worksheet-merge", params: { unitId: "book", subUnitId: "budget", ranges: [{ startRow: 6, endRow: 6, startColumn: 0, endColumn: 2 }] } };
    const autoHeight: SheetMutationJson = { id: "sheet.mutation.set-worksheet-row-auto-height", params: {} };
    act(() => {
      grid.edit(bold);
      grid.edit(row);
      grid.edit(fill);
      grid.edit(widen);
      grid.edit(merge);
      grid.edit(autoHeight);
      grid.edit(set(1, 1, 15));
    });
    await waitFor(() => expect(edits()).toHaveLength(1), { timeout: EDIT_WAIT * 10 });
    const filled = { ...fill, params: { ...(fill.params as object), cellValue: { 2: { 4: { si: "f1", f: "=SUM(B3:D3)" } } } } };
    expect(edits()[0]).toEqual({ baseRev: 3, mutations: [bold, row, filled, widen, merge, set(1, 1, 15)] });
    // an Excel file is the full editor: nothing of it is said to stay out, and nothing was taken back
    expect(screen.queryByText("Not saved")).toBeNull();
    expect(grid.undone).toBe(0);
    expect(toasts.said).toEqual([]);

    // A refused batch is said with Reload and dropped: the next edit goes alone.
    const edit = sheetHost.edit;
    sheetHost.edit = async () => {
      throw new Error("That cell is locked");
    };
    act(() => grid.edit(set(2, 1, 9)));
    expect(await screen.findByText("Couldn't save")).toBeTruthy();
    sheetHost.edit = async (baseRev, mutations) => {
      sheetHost.calls.push(["edit", { baseRev, mutations }]);
      return edit(baseRev, mutations);
    };
    const before = edits().length;
    act(() => grid.edit(set(3, 1, 4)));
    await waitFor(() => expect(edits().length).toBeGreaterThan(before), { timeout: EDIT_WAIT * 10 });
    expect(edits().at(-1)!.mutations).toEqual([set(3, 1, 4)]);
  });

  it("sends a move to a host that saves moves by itself, after what he typed before it, and holds the grid still until the host has answered", async () => {
    open(sheetView({ store: "package", rev: 3, row: ROW_ALL, moves: true }));
    await gridUp();
    const range = (r1: number, c1: number, r2: number, c2: number) => ({ startRow: r1, startColumn: c1, endRow: r2, endColumn: c2 });
    const move: SheetMutationJson = {
      id: "sheet.mutation.move-range",
      params: { unitId: "book", fromRange: range(0, 0, 1, 1), toRange: range(4, 4, 5, 5), from: { subUnitId: "budget", value: {} }, to: { subUnitId: "budget", value: {} } },
    };
    // the host takes its time over a move (LibreOffice runs)
    const edit = sheetHost.edit;
    let answer = (): void => undefined;
    sheetHost.edit = async (baseRev, mutations) => {
      if (mutations[0]?.id === move.id) await new Promise<void>((resolve) => (answer = resolve));
      return edit(baseRev, mutations);
    };
    // typed just before the drag (a turn of its own), and still waiting to be sent: it goes first, as its own batch
    await act(async () => grid.edit(set(3, 1, 4)));
    // one drag: the move, the formulas the grid pointed at the block's new place and a merge it moved; only the move goes
    act(() => {
      grid.edit(move);
      grid.edit(set(7, 1, 0));
      grid.edit({ id: "sheet.mutation.add-worksheet-merge", params: { unitId: "book", subUnitId: "budget", ranges: [range(4, 4, 4, 5)] } });
      grid.edit({ id: "sheet.mutation.update-note-position", params: { unitId: "book", sheetId: "budget" } });
    });
    await waitFor(() => expect(edits()).toHaveLength(1), { timeout: EDIT_WAIT * 10 });
    expect(edits()[0]).toEqual({ baseRev: 3, mutations: [set(3, 1, 4)] });
    // the move is with the host: the grid takes no edit until it has answered
    await waitFor(() => expect(grid.readOnly).toBe(true));
    act(() => answer());
    await waitFor(() => expect(edits()).toHaveLength(2));
    expect(edits()[1]).toEqual({ baseRev: 4, mutations: [move] });
    await waitFor(() => expect(grid.readOnly).toBe(false));
    expect(grid.undone).toBe(0);
    expect(toasts.said).toEqual([]);
    sheetHost.edit = edit;
    const rows: SheetMutationJson = { id: "sheet.mutation.move-rows", params: { unitId: "book", subUnitId: "budget", sourceRange: range(0, 0, 1, 9), targetRange: range(6, 0, 7, 9) } };
    act(() => grid.edit(rows));
    await waitFor(() => expect(edits()).toHaveLength(3), { timeout: EDIT_WAIT * 10 });
    expect(edits()[2]!.mutations).toEqual([rows]);
    await waitFor(() => expect(grid.readOnly).toBe(false));
  });

  it("takes a move the host refuses back by itself: the words are said once, the book is read again from the file, and there is nothing to press", async () => {
    open(sheetView({ store: "package", rev: 3, row: ROW_ALL, moves: true }));
    await gridUp();
    const loads = () => sheetHost.calls.filter((c) => c[0] === "load").length;
    const before = loads();
    const range = (r1: number, c1: number, r2: number, c2: number) => ({ startRow: r1, startColumn: c1, endRow: r2, endColumn: c2 });
    const move: SheetMutationJson = {
      id: "sheet.mutation.move-range",
      params: { unitId: "book", fromRange: range(0, 0, 1, 1), toRange: range(4, 4, 5, 5), from: { subUnitId: "budget", value: {} }, to: { subUnitId: "budget", value: {} } },
    };
    // what only the file shows (here, a table the block cuts) comes back from the host in the canvas's words
    const edit = sheetHost.edit;
    sheetHost.edit = async () => {
      throw new Error("Move this in Excel: it crosses a table");
    };
    act(() => grid.edit(move));
    await waitFor(() => expect(toasts.said).toEqual(["Move this in Excel: it crosses a table"]));
    await waitFor(() => expect(loads()).toBeGreaterThan(before));
    await gridUp();
    await waitFor(() => expect(grid.readOnly).toBe(false));
    expect(screen.queryByText("Couldn't save")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
    // the grid is the file again, and takes his next edit
    sheetHost.edit = edit;
    act(() => grid.edit(set(3, 1, 4)));
    await waitFor(() => expect(edits().at(-1)?.mutations).toEqual([set(3, 1, 4)]), { timeout: EDIT_WAIT * 10 });
  });

  it("reads the file again after a move it saved: the file is LibreOffice's, not the grid's own picture", async () => {
    open(sheetView({ store: "package", rev: 3, row: ROW_ALL, moves: true }));
    await gridUp();
    const loads = () => sheetHost.calls.filter((c) => c[0] === "load").length;
    const before = loads();
    const range = (r1: number, c1: number, r2: number, c2: number) => ({ startRow: r1, startColumn: c1, endRow: r2, endColumn: c2 });
    const rows: SheetMutationJson = { id: "sheet.mutation.move-rows", params: { unitId: "book", subUnitId: "budget", sourceRange: range(0, 0, 1, 9), targetRange: range(6, 0, 7, 9) } };
    act(() => grid.edit(rows));
    await waitFor(() => expect(edits().at(-1)?.mutations).toEqual([rows]), { timeout: EDIT_WAIT * 10 });
    await waitFor(() => expect(loads()).toBeGreaterThan(before));
    await gridUp();
    await waitFor(() => expect(grid.readOnly).toBe(false));
    expect(toasts.said).toEqual([]);
  });

  it("after a refused move whose book cannot be read again, says the sheet did not open, with Retry: never a grid locked for good", async () => {
    open(sheetView({ store: "package", rev: 3, row: ROW_ALL, moves: true }));
    await gridUp();
    const range = (r1: number, c1: number, r2: number, c2: number) => ({ startRow: r1, startColumn: c1, endRow: r2, endColumn: c2 });
    const rows: SheetMutationJson = { id: "sheet.mutation.move-rows", params: { unitId: "book", subUnitId: "budget", sourceRange: range(0, 0, 1, 9), targetRange: range(6, 0, 7, 9) } };
    const { edit, open: openHost } = sheetHost;
    sheetHost.edit = async () => {
      throw new Error("Move this in Excel: it crosses a table");
    };
    // the host goes away as the move is refused: neither the view nor the book answers
    sheetHost.open = async () => {
      throw new Error("offline");
    };
    act(() => grid.edit(rows));
    await waitFor(() => expect(toasts.said).toEqual(["Move this in Excel: it crosses a table"]));
    // the host is back: Retry opens the sheet, and the grid takes edits again
    const retry = await screen.findByRole("button", { name: "Retry" });
    sheetHost.edit = edit;
    sheetHost.open = openHost;
    fireEvent.click(retry);
    await gridUp();
    await waitFor(() => expect(grid.readOnly).toBe(false));
    act(() => grid.edit(set(3, 1, 4)));
    await waitFor(() => expect(edits().at(-1)?.mutations).toEqual([set(3, 1, 4)]), { timeout: EDIT_WAIT * 10 });
  });

  it("never sends a move again on another revision: the sheet changed under it, so it is taken back and said", async () => {
    open(sheetView({ store: "package", rev: 3, row: ROW_ALL, moves: true }));
    await gridUp();
    const range = (r1: number, c1: number, r2: number, c2: number) => ({ startRow: r1, startColumn: c1, endRow: r2, endColumn: c2 });
    const rows: SheetMutationJson = { id: "sheet.mutation.move-rows", params: { unitId: "book", subUnitId: "budget", sourceRange: range(0, 0, 1, 9), targetRange: range(6, 0, 7, 9) } };
    const edit = sheetHost.edit;
    let asked = 0;
    sheetHost.edit = async () => {
      asked++;
      return { conflict: true as const, rev: 9 };
    };
    act(() => grid.edit(rows));
    await waitFor(() => expect(toasts.said).toEqual(["The sheet changed under that move. Make it again"]));
    await waitFor(() => expect(grid.readOnly).toBe(false));
    expect(asked).toBe(1);
    sheetHost.edit = edit;
  });

  it("stops a change an Excel file cannot keep as he makes it: the grid takes it back, nothing of it is sent, and he is told why in a few words", async () => {
    open(sheetView({ store: "package", rev: 3, row: ROW_ALL }));
    await gridUp();
    const move: SheetMutationJson = { id: "sheet.mutation.move-range", params: { unitId: "book", subUnitId: "budget", from: {}, to: {} } };
    // one drag is one command: the cells it cleared and wrote come with the move, and all of it is stopped (a host that does not say it saves moves)
    act(() => {
      grid.edit(set(5, 1, 7));
      grid.edit(move);
    });
    await waitFor(() => expect(grid.undone).toBe(1));
    await waitFor(() => expect(toasts.said).toEqual(["Move this in Excel"]));
    // a change with no name here (a hidden row) is stopped the same way
    act(() => grid.edit({ id: "sheet.mutation.set-row-hidden", params: { unitId: "book", subUnitId: "budget" } }));
    await waitFor(() => expect(grid.undone).toBe(2));
    expect(toasts.said.slice(1)).toEqual(["That change is not saved in an Excel file yet. Make it in Excel"]);
    // his own styled cells and the book's fonts were asked for before the grid drew
    expect(grid.fontsAsked).toHaveLength(1);
    // nothing reached the host, and no line stands over the grid
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, EDIT_WAIT * 2))));
    expect(edits()).toEqual([]);
    expect(screen.queryByText("Couldn't save")).toBeNull();
    expect(screen.queryByText("Not saved")).toBeNull();
    // the next edit he makes is his own, and goes
    act(() => grid.edit(set(3, 1, 4)));
    await waitFor(() => expect(edits()).toHaveLength(1), { timeout: EDIT_WAIT * 10 });
    expect(edits()[0].mutations).toEqual([set(3, 1, 4)]);
  });

  it("a value typed into a cell of an Excel file is sent, however the cell editor's own document changed under each key", async () => {
    // The Mac run of 2026-11-23 (Roster.xlsx in a Files tab): each key he typed changed Univer's cell editor, a document of
    // its own, and the grid reported it; it was stopped as a change the file cannot keep, so Return left the old value.
    open(sheetView({ store: "package", rev: 3, row: ROW_ALL }));
    await gridUp();
    const key = (text: string): SheetMutationJson => ({ id: "doc.mutation.rich-text-editing", params: { unitId: "__INTERNAL_EDITOR__DOCS_NORMAL", actions: [], textRanges: [], text } });
    for (const text of ["H", "a", "n", "d"]) act(() => grid.edit(key(text)));
    act(() => grid.edit(set(1, 0, "Hand")));
    await waitFor(() => expect(edits()).toHaveLength(1), { timeout: EDIT_WAIT * 10 });
    expect(edits()[0]).toEqual({ baseRev: 3, mutations: [set(1, 0, "Hand")] });
    expect(grid.undone).toBe(0);
    expect(toasts.said).toEqual([]);
  });

  it("a workbook Excel or Google holds keeps cell contents: a pasted style is left out, a width is stopped, in that store's words", async () => {
    open(sheetView({ store: "package", rev: 3, reach: { parts: ["formatting"], to: "google" } }));
    await gridUp();
    const pasted: SheetMutationJson = { id: "sheet.mutation.set-range-values", params: { unitId: "book", subUnitId: "budget", cellValue: { 1: { 1: { v: 9, s: { bl: 1 } }, 2: { s: { bl: 1 } } } } } };
    act(() => grid.edit(pasted));
    await waitFor(() => expect(edits()).toHaveLength(1), { timeout: EDIT_WAIT * 10 });
    expect((edits()[0].mutations[0].params as { cellValue: unknown }).cellValue).toEqual({ 1: { 1: { v: 9 } } });
    act(() => grid.edit({ id: "sheet.mutation.set-worksheet-col-width", params: { unitId: "book", subUnitId: "budget", ranges: [], colWidth: 160 } }));
    await waitFor(() => expect(grid.undone).toBe(1));
    await waitFor(() => expect(toasts.said).toEqual(["That change is not saved in a Google sheet yet. Make it in Google Sheets"]));
  });

  it("sends an Excel file that keeps formatting a cell's rich text and a note's new words; a removed note is stopped in a few words", async () => {
    open(sheetView({ store: "package", rev: 3, row: ROW_ALL, notes: ["edit"] }));
    await gridUp();
    const rich: SheetMutationJson = { id: "sheet.mutation.set-range-values", params: { unitId: "book", subUnitId: "budget", cellValue: { 1: { 0: { v: null, p: { body: { dataStream: "Air fare\r\n", textRuns: [{ st: 4, ed: 8, ts: { bl: 1 } }] } } } } } } };
    const worded: SheetMutationJson = { id: "sheet.mutation.update-note", params: { unitId: "book", sheetId: "budget", row: 1, col: 0, note: { id: "n1", row: 1, col: 0, note: "Booked" } } };
    act(() => {
      grid.edit(rich);
      grid.edit(worded);
    });
    await waitFor(() => expect(edits()).toHaveLength(1), { timeout: EDIT_WAIT * 10 });
    expect(edits()[0].mutations).toEqual([rich, worded]);
    act(() => grid.edit({ id: "sheet.mutation.remove-note", params: { unitId: "book", sheetId: "budget", noteId: "n1", row: 1, col: 0 } }));
    await waitFor(() => expect(grid.undone).toBe(1));
    await waitFor(() => expect(toasts.said).toEqual(["Delete this note in Excel"]));
  });

  it("a workbook Excel or Google holds stops rich text as he makes it, in that store's words", async () => {
    open(sheetView({ store: "package", rev: 3, reach: { parts: ["formatting"], to: "excel" } }));
    await gridUp();
    act(() => grid.edit({ id: "sheet.mutation.set-range-values", params: { unitId: "book", subUnitId: "budget", cellValue: { 1: { 1: { v: null, p: { body: {} } } } } } }));
    await waitFor(() => expect(grid.undone).toBe(1));
    await waitFor(() => expect(toasts.said).toEqual(["Style part of a cell's text in Excel"]));
  });

  it("offers a note's controls as the host lists them for its store, and none on a sheet he cannot edit", async () => {
    const shown = async (view: SheetView): Promise<FakeGrid["noteControls"]> => {
      const made = open(view);
      await gridUp();
      const got = grid.noteControls;
      made.unmount();
      cleanup();
      resetCanvasStore();
      resetSheetSyncs();
      return got;
    };
    expect(await shown(sheetView({ store: "package", row: ROW_ALL, notes: [...SHEET_NOTES.package] }))).toEqual(["edit"]);
    expect(await shown(sheetView({ store: "tcsheet", name: "Budget", row: ROW_ALL, notes: [...SHEET_NOTES.tcsheet] }))).toEqual(["edit", "add", "remove"]);
    // a workbook Excel or Google holds lists none; nor does a host a release behind
    expect(await shown(sheetView({ store: "package" }))).toBeUndefined();
    expect(await shown(sheetView({ store: "tcsheet", name: "Budget", row: ROW_ALL }))).toBeUndefined();
    // read only: notes are read, not changed
    expect(await shown(sheetView({ store: "package", row: ROW_ALL, notes: ["edit"], readOnly: "Open in Excel to edit." }))).toBeUndefined();
  });

  it("a press that ran several commands, or the tail of an earlier one, is undone and the book read again from the file", async () => {
    open(sheetView({ store: "package", rev: 3, row: ROW_ALL }), { commands: true });
    await gridUp();
    const loads = () => sheetHost.calls.filter((c) => c[0] === "load").length;
    const before = loads();
    const move: SheetMutationJson = { id: "sheet.mutation.move-range", params: { unitId: "book", subUnitId: "budget", from: {}, to: {} } };
    // one command, one undo, no reload
    act(() => {
      grid.edit(move);
      grid.command("sheet.command.move-range");
    });
    await waitFor(() => expect(grid.undone).toBe(1));
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 30))));
    expect(loads()).toBe(before);
    // two commands in one turn: both are taken back, and the grid is made the file again to be sure
    act(() => {
      grid.edit(set(5, 1, 7));
      grid.command("sheet.command.set-range-values");
      grid.edit(move);
      grid.command("sheet.command.move-range");
    });
    await waitFor(() => expect(grid.undone).toBe(3));
    await waitFor(() => expect(loads()).toBeGreaterThan(before));
    // the grid took no edit from the stop until the book was drawn again, and takes them again now
    expect(grid.lockedOnce).toBe(true);
    await waitFor(() => expect(grid.readOnly).toBe(false));
    expect(edits()).toEqual([]);
  });

  it("sends a style the grid names by its own id as the style itself; an id it cannot name is stopped", async () => {
    open(sheetView({ store: "package", rev: 3, row: ROW_ALL }));
    await gridUp();
    grid.styles.set("k9", { bl: 1, bg: { rgb: "#FFDD66" } });
    act(() => grid.edit({ id: "sheet.mutation.set-range-values", params: { unitId: "book", subUnitId: "budget", cellValue: { 1: { 1: { v: 4, s: "k9" } } } } }));
    await waitFor(() => expect(edits()).toHaveLength(1), { timeout: EDIT_WAIT * 10 });
    expect(edits()[0].mutations.map((m) => (m.params as { cellValue: unknown }).cellValue)).toEqual([{ 1: { 1: { v: 4, s: { bl: 1, bg: { rgb: "#FFDD66" } } } } }]);
    act(() => grid.edit({ id: "sheet.mutation.set-range-values", params: { unitId: "book", subUnitId: "budget", cellValue: { 2: { 1: { s: "gone" } } } } }));
    await waitFor(() => expect(grid.undone).toBe(1));
    // a cell with neither contents nor a style has no saved form either
    act(() => grid.edit({ id: "sheet.mutation.set-range-values", params: { unitId: "book", subUnitId: "budget", cellValue: { 2: { 1: { t: 2 } } } } }));
    await waitFor(() => expect(grid.undone).toBe(2));
    expect(edits()).toHaveLength(1);
  });

  it("a row told to fit is sent to an Excel file that keeps formatting", async () => {
    const fit: SheetMutationJson = { id: "sheet.mutation.set-worksheet-row-is-auto-height", params: { unitId: "book", subUnitId: "budget", ranges: [{ startRow: 2, endRow: 2, startColumn: 0, endColumn: 0 }], autoHeightInfo: 1 } };
    open(sheetView({ store: "package", rev: 3, row: ROW_ALL }));
    await gridUp();
    act(() => grid.edit(fit));
    await waitFor(() => expect(edits()).toHaveLength(1), { timeout: EDIT_WAIT * 10 });
    expect(edits()[0].mutations).toEqual([fit]);
  });

  it("a row told to fit on a sheet the service holds is left to the grid: nothing is sent or stopped for it", async () => {
    const fit: SheetMutationJson = { id: "sheet.mutation.set-worksheet-row-is-auto-height", params: { unitId: "book", subUnitId: "budget", ranges: [{ startRow: 2, endRow: 2, startColumn: 0, endColumn: 0 }], autoHeightInfo: 1 } };
    open(sheetView({ store: "tcsheet", rev: 3, row: ROW_ALL }));
    await gridUp();
    act(() => {
      grid.edit(fit);
      grid.edit(set(1, 1, 2));
    });
    await waitFor(() => expect(edits()).toHaveLength(1), { timeout: EDIT_WAIT * 10 });
    expect(edits()[0].mutations).toEqual([set(1, 1, 2)]);
    expect(grid.undone).toBe(0);
  });

  it("stops nothing on a sheet the service holds: every change is its op", async () => {
    open(sheetView({ store: "tcsheet", rev: 3 }));
    await gridUp();
    const move: SheetMutationJson = { id: "sheet.mutation.move-range", params: { unitId: "book", subUnitId: "budget", from: {}, to: {} } };
    act(() => grid.edit(move));
    await waitFor(() => expect(edits()).toHaveLength(1), { timeout: EDIT_WAIT * 10 });
    expect(grid.undone).toBe(0);
  });

  it("sends what waits before a reload loads the file again", async () => {
    open(sheetView({ store: "tcsheet", rev: 3 }));
    await gridUp();
    sheetHost.since = async () => ({ rev: 9, reload: true as const });
    act(() => grid.edit(set(1, 1, 15)));
    act(() => sheetHost.push({ rev: 9 }));
    await waitFor(() => expect(sheetHost.calls.some((c) => c[0] === "load" && (c[1] as { rev: number }).rev === 9)).toBe(true));
    const sent = sheetHost.calls.findIndex((c) => c[0] === "edit");
    const reload = sheetHost.calls.findIndex((c) => c[0] === "load" && (c[1] as { rev: number }).rev === 9);
    expect(sent).toBeGreaterThan(-1);
    expect(sent).toBeLessThan(reload);
    expect(edits()[0].mutations).toEqual([set(1, 1, 15)]);
  });

  it("names the grid's own workbook in an op it brings in", async () => {
    open(sheetView({ rev: 3 }));
    await gridUp();
    act(() => sheetHost.land([{ ...set(4, 3, 50), params: { ...(set(4, 3, 50).params as object), unitId: "workbook" } }]));
    await waitFor(() => expect(grid.applied.flat().some((m) => (m.params as { unitId: string }).unitId === "book")).toBe(true));
  });

  it("offers Undo on the written line only for an opened Excel file", async () => {
    open(sheetView({ store: "lifeos", mode: "writes", written: { id: "w1", text: "Changed 6 cells", at: Date.now() } }));
    await gridUp();
    expect(await screen.findByText(/Changed 6 cells/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("a format or a rule the agent wrote is said with no Undo on the line: the sheet's own Undo and History take it back", async () => {
    open(sheetView({ mode: "writes", written: { id: "w1", text: "Bold on A1:B1", at: Date.now(), undo: false } }));
    await gridUp();
    expect(await screen.findByText(/Bold on A1:B1/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("shows what the agent wrote directly, with Undo, and its mode", async () => {
    open(sheetView({ mode: "writes", written: { id: "w1", text: "Changed 6 cells", at: Date.now() } }));
    await gridUp();
    expect(await screen.findByText(/Changed 6 cells/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Agent writes/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(sheetHost.calls).toContainEqual(["undo", "w1"]));
  });

  it("makes a chart from the selection's block through More where the sheet keeps charts, and offers none where it does not", async () => {
    open(sheetView({ row: [...ROW_ALL, "chart", "picture", "objects"] }), { selection: "A1:B5" });
    await gridUp();
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Chart" }));
    await waitFor(() => expect(grid.handle!.objects.list().charts.map((c) => c.id)).toEqual(["chart-selection"]));
    cleanup();
    resetSheetSyncs();
    open(sheetView(), { selection: "A1:B5" });
    await gridUp();
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    await screen.findByRole("menuitem", { name: "Preview…" });
    expect(screen.queryByRole("menuitem", { name: "Chart" })).toBeNull();
  });

  it("offers Preview… in More for every sheet, in place of the export rows", async () => {
    for (const store of ["tcsheet", "package", "lifeos"] as const) {
      cleanup();
      resetSheetSyncs();
      open(sheetView({ store }));
      await gridUp();
      fireEvent.click(await screen.findByRole("button", { name: "More" }));
      expect(await screen.findByRole("menuitem", { name: "Preview…" })).toBeTruthy();
      for (const gone of ["Export as Excel", "Export sheet as CSV", "Save as CSV"]) expect(screen.queryByRole("menuitem", { name: gone })).toBeNull();
    }
  });

  it("keeps Save as CSV, back over the file, for a sheet read from a .csv", async () => {
    open(sheetView({ store: "csv" }));
    await gridUp();
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    expect(screen.queryByRole("menuitem", { name: "Preview…" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Save as CSV" }));
    await waitFor(() => expect(sheetHost.calls.filter((c) => c[0] === "export").at(-1)?.[1]).toMatchObject({ format: "csv" }));
  });

  it("a sheet opened as an Excel copy says so in one quiet line over the grid, and Save back asks the host and names what the format dropped", async () => {
    open(sheetView({ store: "package", name: "Ledger.xls", imported: { format: "xls", name: "Ledger.xls" } }));
    sheetHost.importDrops = ["2 tables become plain ranges"];
    await gridUp();
    const line = document.querySelector<HTMLElement>("[data-sheet-import]")!;
    expect(line.textContent).toBe("Edits save to an Excel copy. Saving back as .xls drops tables and newer functions.Save back");
    // between the format row and the grid
    expect(line.compareDocumentPosition(document.querySelector("[data-fake-grid]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(line).getByRole("button", { name: "Save back" }));
    await waitFor(() => expect(sheetHost.calls.filter((c) => c[0] === "imported").at(-1)?.[1]).toEqual({ act: "back" }));
    await waitFor(() => expect(toasts.said).toContain("Saved Ledger.xls"));
    // an ordinary Excel file has no such line
    cleanup();
    resetSheetSyncs();
    open(sheetView({ store: "package" }));
    await gridUp();
    expect(document.querySelector("[data-sheet-import]")).toBeNull();
  });

  it("More names both ways out of a copy; a file that changed under his edits loses Save back and gains Discard edits and read again", async () => {
    open(sheetView({ store: "package", name: "Ledger.ods", imported: { format: "ods", name: "Ledger.ods" } }));
    await gridUp();
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    expect(await screen.findByRole("menuitem", { name: "Save back as .ods" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Save as Excel" }));
    await waitFor(() => expect(sheetHost.calls.filter((c) => c[0] === "imported").at(-1)?.[1]).toEqual({ act: "xlsx" }));
    cleanup();
    resetSheetSyncs();
    open(sheetView({ store: "package", name: "Ledger.ods", imported: { format: "ods", name: "Ledger.ods", stale: true } }));
    sheetHost.importRefusal = "Ledger.ods is no longer where it was.";
    await gridUp();
    expect(document.querySelector("[data-sheet-import]")!.textContent).toBe("This file changed since the copy was made, so it is not saved back.Save as Excel");
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    expect(screen.queryByRole("menuitem", { name: "Save back as .ods" })).toBeNull();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Discard edits and read again" }));
    // a refusal is the host's own words, in one toast
    await waitFor(() => expect(toasts.said).toContain("Ledger.ods is no longer where it was."));
  });

  it("opens Preview over the grid, which stays mounted and out of reach, and Edit puts him back", async () => {
    open(sheetView({ store: "package" }));
    await gridUp();
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Preview…" }));
    const frame = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-sheet-preview]");
      expect(el).toBeTruthy();
      return el!;
    });
    // The grid is still there, its cells kept, under an inert and unseen wrapper.
    expect(cell("A2").textContent).toBe("Flights");
    expect(cell("A2").closest("[inert]")).toBeTruthy();
    expect(within(frame).getByRole("button", { name: /Edit/ })).toBeTruthy();
    fireEvent.click(within(frame).getByRole("button", { name: /Edit/ }));
    await waitFor(() => expect(document.querySelector("[data-sheet-preview]")).toBeNull());
    expect(cell("A2").closest("[inert]")).toBeNull();
  });

  it("answers File → Print… on Print and File → Export… on the format he last used", async () => {
    localStorage.setItem("work.preview.format.sheet", "csv");
    open(sheetView({ store: "package" }));
    await gridUp();
    window.dispatchEvent(new CustomEvent("work:command", { detail: { id: "print" } }));
    await waitFor(() => expect(document.querySelector("[data-sheet-preview]")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Print…" })).toBeTruthy();
    window.dispatchEvent(new CustomEvent("work:command", { detail: { id: "export" } }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Print…" })).toBeNull());
    expect(screen.getAllByRole("button", { name: "Export" }).length).toBeGreaterThan(0);
  });

  it("previews a sheet he can only read: the way out reads Back", async () => {
    open(sheetView({ store: "package", readOnly: "This file cannot be opened here: a password" }));
    await gridUp();
    window.dispatchEvent(new CustomEvent("work:command", { detail: { id: "export" } }));
    const frame = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-sheet-preview]");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(within(frame).getByRole("button", { name: /Back/ })).toBeTruthy();
  });

  it("offers the switch only while the file holds what the grid cannot reach", async () => {
    open(sheetView());
    await gridUp();
    expect(screen.queryByRole("tablist", { name: "Open in" })).toBeNull();
    cleanup();
    resetSheetSyncs();
    open(sheetView({ reach: { parts: ["a pivot table"], to: "excel" } }));
    const tabs = await screen.findByRole("tablist", { name: "Open in" });
    expect(within(tabs).getByRole("tab", { name: "TempCode" })).toBeTruthy();
    fireEvent.click(within(tabs).getByRole("tab", { name: "Excel" }));
    await waitFor(() => expect(sheetHost.calls).toContainEqual(["switch", null]));
  });

  it("spins the full editor's side while the host starts it, and takes one press at a time", async () => {
    let started = (): void => {};
    open(sheetView({ reach: { parts: ["pivot tables", "charts"], to: "full" } }));
    sheetHost.switchWait = new Promise<void>((resolve) => (started = resolve));
    const tabs = await screen.findByRole("tablist", { name: "Open in" });
    const full = within(tabs).getByRole("tab", { name: "Full editor" });
    fireEvent.click(full);
    await waitFor(() => expect(full.querySelector('[data-slot="busy-label"]')?.hasAttribute("data-busy")).toBe(true));
    fireEvent.click(within(tabs).getByRole("tab", { name: "TempCode" }));
    fireEvent.click(full);
    expect(sheetHost.calls.filter((c) => c[0] === "switch")).toHaveLength(1);
    started();
    await waitFor(() => expect(full.querySelector('[data-slot="busy-label"]')?.hasAttribute("data-busy")).toBe(false));
  });

  it("says what waits in Excel on the bar of an opened Excel file, beside the switch, and nothing on any other sheet", async () => {
    open(sheetView({ store: "package", reach: { parts: ["2 pivot tables", "macros"], to: "excel" } }));
    await gridUp();
    const bar = await waitFor(() => document.querySelector("[data-canvas-bar]")!);
    expect(bar.querySelector("[data-sheet-waits]")?.textContent).toBe("2 pivot tables and macros open in Excel");
    expect(screen.getByRole("tablist", { name: "Open in" })).toBeTruthy();
    cleanup();
    resetSheetSyncs();
    resetCanvasStore();
    // A workbook Google holds has the switch for what our grid does not do there: its bar says nothing of it.
    open(sheetView({ store: "package", reach: { parts: ["formatting"], to: "google" } }));
    await gridUp();
    await screen.findByRole("tablist", { name: "Open in" });
    expect(document.querySelector("[data-sheet-waits]")).toBeNull();
  });

  it("offers Save to Google Sheets in More on the host's word alone, and never for a workbook that reads only", async () => {
    open(sheetView());
    await gridUp();
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    await screen.findByRole("menuitem", { name: "Preview…" });
    expect(screen.queryByRole("menuitem", { name: "Save to Google Sheets" })).toBeNull();
    cleanup();
    resetSheetSyncs();
    resetCanvasStore();
    open(sheetView({ canUpload: true, readOnly: "This file cannot be opened here: it has a password" }));
    await gridUp();
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    await screen.findByRole("menuitem", { name: "Preview…" });
    expect(screen.queryByRole("menuitem", { name: "Save to Google Sheets" })).toBeNull();
    cleanup();
    resetSheetSyncs();
    resetCanvasStore();
    open(sheetView({ canUpload: true }));
    await gridUp();
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    const rows = (await screen.findAllByRole("menuitem")).map((row) => row.textContent);
    // After Preview…, with the other ways out.
    expect(rows.indexOf("Save to Google Sheets")).toBe(rows.indexOf("Preview…") + 1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Save to Google Sheets" }));
    expect(await screen.findByRole("dialog", { name: "Save to Google Sheets" })).toBeTruthy();
  });

  it("offers Share only on a sheet a guest link can reach, a LifeOS sheet", async () => {
    open(sheetView());
    await gridUp();
    await screen.findByRole("button", { name: /Agent suggests/ });
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    cleanup();
    resetSheetSyncs();
    resetCanvasStore();
    open(sheetView(), { item: canvasItem("s1", { kind: "sheet", title: "Travel budget", source: { at: "lifeos", table: "sheets", id: "sh1" } }) });
    const share = await screen.findByRole("button", { name: "Share" });
    // Whole or gone: under the narrow bar it hides as one piece rather than being cut mid-word.
    const whole = share.closest("[data-narrow-hide]");
    expect(whole?.className).toContain("@max-[560px]/bar:hidden");
  });

  it("offers Share in More only once the narrow bar hides it, and opens the same popover from there", async () => {
    const seen: Array<(entries: unknown[]) => void> = [];
    const kept = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(fn: (entries: unknown[]) => void) {
        seen.push(fn);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;
    try {
      open(sheetView(), { item: canvasItem("s1", { kind: "sheet", title: "Travel budget", source: { at: "lifeos", table: "sheets", id: "sh1" } }) });
      await gridUp();
      const share = await screen.findByRole("button", { name: "Share" });
      fireEvent.click(await screen.findByRole("button", { name: "More" }));
      await screen.findByRole("menuitem", { name: "Preview…" });
      expect(screen.queryByRole("menuitem", { name: "Share" })).toBeNull();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      // The bar's narrow form hides Share whole; the bar says so as it resizes.
      (share.closest("[data-narrow-hide]") as HTMLElement).style.display = "none";
      act(() => seen.forEach((fn) => fn([{ contentRect: { width: 400 } }])));
      fireEvent.click(screen.getByRole("button", { name: "More" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Share" }));
      await waitFor(() => expect(document.querySelector("[data-share-anchor] button")?.getAttribute("aria-expanded")).toBe("true"));
      expect(await screen.findByRole("button", { name: "New guest link…" })).toBeTruthy();
    } finally {
      globalThis.ResizeObserver = kept;
    }
  });

  it("says a read-only file (an .xlsb) in the needs tone, not as a failure", async () => {
    open(sheetView({ readOnly: "Saved as .xlsb, which opens read only" }));
    await gridUp();
    const line = await waitFor(() => {
      const found = document.querySelector("[data-canvas-state]");
      if (!found) throw new Error("no state line");
      return found;
    });
    expect(line.getAttribute("data-canvas-state")).toBe("needs");
    expect(line.textContent).toContain("Read only");
  });

  it("says a sheet that did not open once, in the body, with no state line over it", async () => {
    sheetHost = fakeSheetHost(sheetView({ readOnly: "The workbook is protected" }), BOOK);
    sheetHost.load = async () => {
      throw new Error("The workbook is protected");
    };
    grid = fakeGrid();
    host.current = fakeHost([ITEM], host as never);
    render(
      <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
        <div />
      </CanvasSeat>,
    );
    expect(await screen.findByText("Couldn't open this sheet")).toBeTruthy();
    expect(document.querySelector("[data-canvas-state]")).toBeNull();
    expect(screen.queryByText("Read only")).toBeNull();
  });

  it("Retry after the grid's own code failed to load fetches it again, and the grid then opens", async () => {
    sheetHost = fakeSheetHost(sheetView(), BOOK);
    grid = fakeGrid();
    let tries = 0;
    grid.prepare = async () => {
      tries += 1;
      if (tries === 1) throw new Error("The grid did not load");
    };
    host.current = fakeHost([ITEM], host as never);
    render(
      <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
        <div />
      </CanvasSeat>,
    );
    expect(await screen.findByText("Couldn't open this sheet")).toBeTruthy();
    const opens = sheetHost.calls.filter((c) => c[0] === "open").length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await gridUp();
    expect(tries).toBe(2);
    expect(cell("A2").textContent).toBe("Flights");
    // The host's open had not failed, so it is not asked again.
    expect(sheetHost.calls.filter((c) => c[0] === "open").length).toBe(opens);
  });

  it("a grid that still cannot load keeps the failure with Retry", async () => {
    sheetHost = fakeSheetHost(sheetView(), BOOK);
    grid = fakeGrid();
    let tries = 0;
    grid.prepare = async () => {
      tries += 1;
      throw new Error("The grid did not load");
    };
    host.current = fakeHost([ITEM], host as never);
    render(
      <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
        <div />
      </CanvasSeat>,
    );
    expect(await screen.findByText("Couldn't open this sheet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(tries).toBe(2));
    expect(await screen.findByText("Couldn't open this sheet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("has no History and offers no Accept or Reject until the grid has drawn the changed cells", async () => {
    sheetHost = fakeSheetHost(sheetView({ suggestions: [suggestion("a", 1, 3, { base: { v: 412 }, proposed: { v: 438 } })] }), BOOK);
    grid = fakeGrid();
    let draw!: () => void;
    grid.prepare = () => new Promise<void>((done) => (draw = done));
    host.current = fakeHost([ITEM], host as never);
    render(
      <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
        <div />
      </CanvasSeat>,
    );
    // The host's view, its suggestions with it, is in; the grid is still preparing.
    await waitFor(() => expect(sheetHost.calls.some((c) => c[0] === "load")).toBe(true));
    await waitFor(() => expect(document.querySelector("[data-canvas-bar]")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "History" })).toBeNull();
    expect(screen.queryByRole("toolbar", { name: "Review changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    act(() => draw());
    await gridUp();
    const bar = await screen.findByRole("toolbar", { name: "Review changes" });
    expect(within(bar).getByRole("button", { name: "Accept" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "History" })).toBeTruthy();
  });

  it("a sheet that did not open has no History beside its failure", async () => {
    sheetHost = fakeSheetHost(sheetView(), BOOK);
    grid = fakeGrid();
    grid.prepare = async () => {
      throw new Error("The grid did not load");
    };
    host.current = fakeHost([ITEM], host as never);
    render(
      <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
        <div />
      </CanvasSeat>,
    );
    expect(await screen.findByText("Couldn't open this sheet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "History" })).toBeNull();
  });

  it("names the range and the file in Ask's chip", async () => {
    open(sheetView(), { selection: "A1:B5" });
    await gridUp();
    const bar = await screen.findByRole("toolbar", { name: "Selection" });
    fireEvent.click(within(bar).getByRole("button", { name: /^Ask/ }));
    expect(contextChipsOf("t1")[0]?.label).toBe("A1:B5, Nationals travel budget.xlsx");
  });

});

describe("the format row", () => {
  const row = () => screen.queryByRole("toolbar", { name: "Formatting" });
  /** What a host sends for a sheet whose store keeps formatting. */
  const ROW: NonNullable<SheetView["row"]> = ["undo", "style", "font", "size", "bold", "italic", "underline", "colour", "fill", "align", "vertical", "wrap", "merge", "borders", "number"];

  it.each(["tcsheet", "lifeos"] as const)("is drawn over a %s, a sheet whose store keeps what it sets", async (store) => {
    open(sheetView({ store, name: "Budget", row: ROW }), { selection: "B2" });
    await gridUp();
    const bar = await screen.findByRole("toolbar", { name: "Formatting" });
    // jsdom measures nothing, so the row is at its narrowest: Style, Bold, Italic and what waits in More formatting
    expect(within(bar).getByRole("button", { name: "Bold" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Cell style" }).textContent).toBe("Normal");
    expect(within(bar).getByRole("button", { name: "More formatting" })).toBeTruthy();
    // the row is the body's first row, over the grid
    const body = document.querySelector("[data-sheet-item]")!;
    // First in the body (under the wrapper Preview makes inert, which takes no box of its own).
    expect(body.firstElementChild?.className).toBe("contents");
    expect(body.firstElementChild!.firstElementChild).toBe(bar);
  });

  it("is drawn over an opened Excel file, whose host keeps formatting now", async () => {
    open(sheetView({ store: "package", row: ROW }), { selection: "B2" });
    await gridUp();
    expect(await screen.findByRole("toolbar", { name: "Formatting" })).toBeTruthy();
    expect(document.querySelector("[data-sheet-item]")!.getAttribute("data-editor-keys")).toBe("sheet");
    expect(grid.styleKeys).toBe(true);
  });

  it.each(["package", "csv"] as const)("is not drawn over a %s whose host lists no control (a workbook Excel or Google holds, a .csv): it keeps cell contents only, and no key formats it", async (store) => {
    open(sheetView({ store }), { selection: "B2" });
    await gridUp();
    expect(row()).toBeNull();
    // ⌘B stays the app's, the grid's own style keys are off, and the row's keys do nothing
    const body = document.querySelector<HTMLElement>("[data-sheet-item]")!;
    expect(body.getAttribute("data-editor-keys")).toBe("read");
    expect(grid.styleKeys).toBe(false);
    const mod = navigator.platform.toLowerCase().includes("mac") ? { metaKey: true } : { ctrlKey: true };
    expect(fireEvent.keyDown(body, { key: "\\", code: "Backslash", ...mod })).toBe(true);
    expect(grid.formats).toEqual([]);
  });

  it("is not drawn on a sheet he can only read, which also leaves the app its own ⌘B", async () => {
    open(sheetView({ store: "tcsheet", row: ROW, readOnly: "Saved as .xlsb, which opens here only to read" }), { selection: "B2" });
    await gridUp();
    expect(row()).toBeNull();
    expect(document.querySelector("[data-sheet-item]")!.getAttribute("data-editor-keys")).toBe("read");
  });

  it("draws only the controls the host lists, so a host a release behind loses nothing it could not keep", async () => {
    open(sheetView({ store: "tcsheet", row: ["italic"] }), { selection: "B2" });
    await gridUp();
    const bar = await screen.findByRole("toolbar", { name: "Formatting" });
    expect(within(bar).getByRole("button", { name: "Italic" })).toBeTruthy();
    expect(within(bar).queryByRole("button", { name: "Bold" })).toBeNull();
    expect(within(bar).queryByRole("button", { name: "Cell style" })).toBeNull();
  });

  it("marks an editable sheet as an editor, so the format keys are its own", async () => {
    open(sheetView({ store: "tcsheet", row: ROW }), { selection: "B2" });
    await gridUp();
    expect(document.querySelector("[data-sheet-item]")!.getAttribute("data-editor-keys")).toBe("sheet");
    expect(grid.styleKeys).toBe(true);
  });

  it("a key acts only where the host drew its control, and a text field keeps its keys", async () => {
    open(sheetView({ store: "tcsheet", row: ["italic"] }), { selection: "B2" });
    await gridUp();
    const body = document.querySelector<HTMLElement>("[data-sheet-item]")!;
    const mod = navigator.platform.toLowerCase().includes("mac") ? { metaKey: true } : { ctrlKey: true };
    // no Cell style in this host's list: its Clear formatting key is not there either
    expect(fireEvent.keyDown(body, { key: "\\", code: "Backslash", ...mod })).toBe(true);
    expect(grid.formats).toEqual([]);
  });

  it("⌘\\ typed in the formula bar is the bar's, not the cells'", async () => {
    open(sheetView({ store: "tcsheet", row: ROW }), { selection: "B2" });
    await gridUp();
    const field = document.createElement("input");
    document.querySelector("[data-sheet-item]")!.append(field);
    const mod = navigator.platform.toLowerCase().includes("mac") ? { metaKey: true } : { ctrlKey: true };
    expect(fireEvent.keyDown(field, { key: "\\", code: "Backslash", ...mod })).toBe(true);
    expect(grid.formats).toEqual([]);
  });

  it("a custom format Excel would refuse cannot be applied, and says why", async () => {
    open(sheetView({ store: "tcsheet", row: ROW }), { selection: "B2" });
    await gridUp();
    fireEvent.click(await screen.findByRole("button", { name: "More formatting" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Number format/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Custom format…" }));
    const input = await screen.findByLabelText("Format");
    fireEvent.change(input, { target: { value: '0.0"' } });
    expect(await screen.findByText("Not a number format")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '0.0 "kg"' } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(grid.formats).toEqual([{ pattern: '0.0 "kg"' }]));
  });

  it("a press formats the selection and the change is sent to the host as the grid's own edit", async () => {
    open(sheetView({ store: "tcsheet", rev: 3, row: ROW }), { selection: "B2:C2" });
    await gridUp();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(await screen.findByRole("button", { name: "Bold" }));
    expect(grid.formats).toEqual([{ bold: true }]);
    await act(async () => void (await vi.advanceTimersByTimeAsync(EDIT_WAIT + 10)));
    await waitFor(() => expect(edits()).toHaveLength(1));
    const sent = edits()[0]!.mutations[0]!.params as { cellValue: Record<string, Record<string, { s?: { bl?: number } }>> };
    expect(sent.cellValue[1]![1]!.s).toEqual({ bl: 1 });
    expect(sent.cellValue[1]![2]!.s).toEqual({ bl: 1 });
    // and the row now says the cell is bold
    await waitFor(() => expect(screen.getByRole("button", { name: "Bold" }).getAttribute("aria-pressed")).toBe("true"));
  });

  it("⌘\\ clears the selection's formatting from the keyboard, and a key that is no format key passes", async () => {
    open(sheetView({ store: "tcsheet", row: ROW }), { selection: "B2" });
    await gridUp();
    const body = document.querySelector<HTMLElement>("[data-sheet-item]")!;
    const mod = navigator.platform.toLowerCase().includes("mac") ? { metaKey: true } : { ctrlKey: true };
    expect(fireEvent.keyDown(body, { key: "\\", code: "Backslash", ...mod })).toBe(false);
    expect(grid.formats).toEqual([{ clear: true }]);
    expect(fireEvent.keyDown(body, { key: "j", code: "KeyJ", ...mod })).toBe(true);
    expect(grid.formats).toHaveLength(1);
  });
});

describe("the sheet's rules", () => {
  const DATA: NonNullable<SheetView["row"]> = [...ROW_ALL, "sort", "filter", "validation", "conditional", "names"];
  const side = () => document.querySelector<HTMLElement>("[data-rules-sheet]");
  /** The row at jsdom's width folds Data into More formatting: open that, then Data. */
  const dataMenu = async (): Promise<void> => {
    const bar = await screen.findByRole("toolbar", { name: "Formatting" });
    const direct = within(bar).queryByRole("button", { name: "Data" });
    if (direct) return void fireEvent.click(direct);
    fireEvent.click(within(bar).getByRole("button", { name: "More formatting" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Data/ }));
  };

  it("opens the side sheet from the row's Data menu with the lists the host keeps, beside the grid, and closes it", async () => {
    open(sheetView({ store: "tcsheet", name: "Budget", row: DATA }), { selection: "B2" });
    await gridUp();
    expect(side()).toBeNull();
    await dataMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Conditional formatting" }));
    await waitFor(() => expect(side()).toBeTruthy());
    expect(side()!.dataset).toMatchObject({ view: "lists", kinds: "conditional validation names", stacked: "false" });
    // docked at the grid's right: the grid first, the sheet after it, in one row under the format row
    const dock = side()!.parentElement!;
    expect(dock.className).toContain("w-80");
    expect(dock.previousElementSibling?.querySelector("[data-cell]") ?? dock.previousElementSibling).toBeTruthy();
    // a rule opened in it stays the body's state
    fireEvent.click(within(side()!).getByText("open a rule"));
    await waitFor(() => expect(side()!.dataset.view).toBe("rule"));
    fireEvent.click(within(side()!).getByText("close rules"));
    await waitFor(() => expect(side()).toBeNull());
  });

  it("shuts the side sheet when the sheet turns read-only, and leaves it shut when he can edit again", async () => {
    open(sheetView({ store: "tcsheet", name: "Budget", row: DATA }), { selection: "B2" });
    await gridUp();
    await dataMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Conditional formatting" }));
    await waitFor(() => expect(side()).toBeTruthy());
    act(() => sheetHost.push({ rev: sheetHost.rev, view: { ...sheetHost.view, readOnly: "Open in Excel to edit." } }));
    await waitFor(() => expect(side()).toBeNull());
    act(() => sheetHost.push({ rev: sheetHost.rev, view: { ...sheetHost.view, readOnly: undefined } }));
    await screen.findByRole("toolbar", { name: "Formatting" });
    expect(side()).toBeNull();
  });

  it("tells the grid to offer the filter's own buttons and menu only where the host keeps a filter", async () => {
    const first = open(sheetView({ store: "tcsheet", name: "Budget", row: DATA }), { selection: "B2" });
    await gridUp();
    expect(grid.filter).toBe(true);
    // the sort dialog, the filter's menu and a list's drop-down are the kit's own
    expect(grid.dataChrome).toBe(true);
    first.unmount();
    cleanup();
    resetCanvasStore();
    resetSheetSyncs();
    // a workbook Excel or Google holds lists no control: no filter menu to change what its host would drop
    open(sheetView({ store: "package" }), { selection: "B2" });
    await gridUp();
    expect(grid.filter).toBe(false);
  });

  it("lists only the rules a store keeps, and offers no Data menu where it keeps none", async () => {
    const first = open(sheetView({ store: "tcsheet", name: "Budget", row: [...ROW_ALL, "sort", "filter", "names"] }), { selection: "B2" });
    await gridUp();
    await dataMenu();
    expect(await screen.findByRole("menuitem", { name: "Named ranges" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Conditional formatting" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Validation" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Named ranges" }));
    await waitFor(() => expect(side()!.dataset.kinds).toBe("names"));
    first.unmount();
    cleanup();
    resetCanvasStore();
    resetSheetSyncs();

    open(sheetView({ store: "tcsheet", name: "Budget", row: ROW_ALL }), { selection: "B2" });
    await gridUp();
    const bar = await screen.findByRole("toolbar", { name: "Formatting" });
    expect(within(bar).queryByRole("button", { name: "Data" })).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: "More formatting" }));
    await screen.findAllByRole("menuitem");
    expect(screen.queryByRole("menuitem", { name: /^Data/ })).toBeNull();
  });

  it("a rule made in an opened Excel file is saved as the whole list it leaves, once a turn", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      open(sheetView({ store: "package", row: DATA }), { selection: "B2" });
      await gridUp();
      await act(async () => {
        const rules = grid.handle!.rules;
        rules.conditional.add({ ranges: [], stopIfTrue: false, rule: { type: "highlightCell" } } as never);
        rules.conditional.add({ ranges: [], stopIfTrue: false, rule: { type: "colorScale" } } as never);
        rules.filter.set();
      });
      await act(async () => void (await vi.advanceTimersByTimeAsync(EDIT_WAIT + 20)));
      await waitFor(() => expect(edits()).toHaveLength(1));
      const sent = edits()[0]!.mutations;
      // the two adds are one list, the newest first as the grid holds it; the filter is its range; nothing of the filter's own noise
      expect(sent.map((m) => [m.id, (m.params as { kind: string }).kind, (m.params as { subUnitId?: string }).subUnitId])).toEqual([
        ["tempcode.sheet.rules", "conditional", "budget"],
        ["tempcode.sheet.rules", "filter", "budget"],
      ]);
      expect(((sent[0]!.params as { list: { cfId: string }[] }).list).map((r) => r.cfId)).toEqual(["cf2", "cf1"]);
      expect(toasts.said).toEqual([]);
      expect(grid.undone).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a sheet the service holds is sent the rule's own mutation; an Excel file whose host lists no such rule has it stopped at the press", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const first = open(sheetView({ store: "tcsheet", name: "Budget", row: DATA }), { selection: "B2" });
      await gridUp();
      await act(async () => void grid.handle!.rules.validation.add({ type: "list", formula1: "Open,Done", ranges: [] } as never));
      await act(async () => void (await vi.advanceTimersByTimeAsync(EDIT_WAIT + 20)));
      await waitFor(() => expect(edits()).toHaveLength(1));
      expect(edits()[0]!.mutations.map((m) => m.id)).toEqual(["data-validation.mutation.addRule"]);
      first.unmount();
      cleanup();
      resetCanvasStore();
      resetSheetSyncs();
      toasts.said.length = 0;

      // a host that keeps formatting but lists no rule (a release behind): the rule is taken back as he makes it
      open(sheetView({ store: "package", row: ROW_ALL }), { selection: "B2" });
      await gridUp();
      await act(async () => void grid.handle!.rules.validation.add({ type: "list", formula1: "Open,Done", ranges: [] } as never));
      await act(async () => void (await vi.advanceTimersByTimeAsync(EDIT_WAIT + 20)));
      await waitFor(() => expect(toasts.said).toEqual(["That change is not saved in an Excel file yet. Make it in Excel"]));
      expect(grid.undone).toBe(1);
      expect(edits()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a format or a rule an agent proposed", () => {
  const said = (id: string, over: Partial<NonNullable<SheetView["changes"]>[number]> = {}): NonNullable<SheetView["changes"]>[number] => ({
    id,
    changeSet: `set-${id}`,
    by: "agent:local:t1",
    kind: "format",
    sheet: "budget",
    range: { startRow: 1, endRow: 2, startColumn: 1, endColumn: 2 },
    words: "Bold, yellow fill on B2:C3",
    state: "pending",
    ...over,
  });

  it("is stepped after the cells, marks its range, is said in words in the formula bar, and is taken by its id", async () => {
    open(
      sheetView({
        suggestions: [suggestion("a", 1, 3, { base: { v: 412 }, proposed: { v: 438 } })],
        changes: [said("f1", { reason: "the totals" }), said("r1", { kind: "rule", range: null, words: "The name Budgeted for E2:E5" })],
      }),
    );
    await gridUp();
    const bar = await screen.findByRole("toolbar", { name: "Review changes" });
    expect(within(bar).getByText("1/3")).toBeTruthy();
    // waiting: its cells are marked as a cell's change marks its own
    await waitFor(() => expect(cell("B2").dataset.mark).toBe("pending"));
    expect(cell("C3").dataset.mark).toBe("pending");
    // a cell with no value of the change keeps what it held
    expect(cell("B2").textContent).toBe("14");

    fireEvent.click(within(bar).getByRole("button", { name: "Next change" }));
    await waitFor(() => expect(cell("B2").dataset.mark).toBe("current"));
    expect(document.querySelector("[data-sheet-was]")?.textContent).toBe("Suggested: Bold, yellow fill on B2:C3 (the totals)");

    // a name sits in no cell: the bar still says it
    fireEvent.click(within(bar).getByRole("button", { name: "Next change" }));
    await waitFor(() => expect(document.querySelector("[data-sheet-was]")?.textContent).toBe("Suggested: The name Budgeted for E2:E5"));
    expect(cell("B2").dataset.mark).toBe("pending");

    fireEvent.click(within(bar).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(sheetHost.calls).toContainEqual(["review", { which: { ids: ["r1"] }, verdict: "accept" }]));
  });

  it("one whose rows moved since says so and can be rejected", async () => {
    open(sheetView({ changes: [said("f1", { state: "orphaned" })] }));
    await gridUp();
    const bar = await screen.findByRole("toolbar", { name: "Review changes" });
    await waitFor(() => expect(document.querySelector("[data-sheet-was]")?.textContent).toBe("Bold, yellow fill on B2:C3. Rows or columns changed since: reject it"));
    fireEvent.click(within(bar).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(sheetHost.calls).toContainEqual(["review", { which: { ids: ["f1"] }, verdict: "reject" }]));
  });
});

describe("charts and pictures", () => {
  const OBJECTS_ROW: NonNullable<SheetView["row"]> = [...ROW_ALL, "chart", "picture", "objects"];
  const anchor = { kind: "oneCell" as const, from: { column: 6, row: 1, columnOffset: 0, rowOffset: 0 }, width: 4572000, height: 2743200 };
  const CHART = { id: "xl/charts/chart1.xml", sheet: "Budget", anchor, kind: "column" as const, grouping: "clustered" as const, groups: [{ kind: "column" as const, grouping: "clustered" as const }], legend: null, axes: {}, series: [{ kind: "column" as const, group: 0, values: { ref: "Budget!$E$2:$E$5" } }], flags: {} };
  const PICTURE = { id: "xl/drawings/drawing1.xml#1", sheet: "Budget", anchor, part: "xl/media/image1.png", contentType: "image/png", name: "Logo" };
  const OBJECTS = { charts: [CHART], pictures: [PICTURE], warnings: [] };

  function openWith(view: SheetView) {
    sheetHost = fakeSheetHost(view, { workbook: BOOK, objects: OBJECTS });
    grid = fakeGrid();
    host.current = fakeHost([ITEM], host as never);
    return render(
      <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
        <div data-testid="thread" />
      </CanvasSeat>,
    );
  }
  const lists = () => edits().flatMap((e) => e.mutations.filter((m) => m.id === "tempcode.sheet.rules"));

  it("hands the grid the file's charts and pictures, and sends a change as the tab's whole list", async () => {
    openWith(sheetView({ row: OBJECTS_ROW }));
    await gridUp();
    expect(grid.objectsGiven?.objects).toEqual(OBJECTS);
    const moved = { ...anchor, from: { ...anchor.from, row: 9 } };
    // Two changes in one wait go as one list: the last.
    act(() => void grid.handle!.objects.move(CHART.id, anchor));
    act(() => void grid.handle!.objects.move(CHART.id, moved));
    await waitFor(() => expect(lists()).toHaveLength(1));
    expect(lists()[0]).toEqual({ id: "tempcode.sheet.rules", params: { kind: "charts", subUnitId: "budget", list: [{ ...CHART, anchor: moved }] } });
  });

  it("takes the ids a save answers, so the next save names the file's parts", async () => {
    openWith(sheetView({ row: OBJECTS_ROW }));
    await gridUp();
    const made = { ...CHART, id: "chart-ab12cd34" };
    sheetHost.nextEdit = { ids: { "chart-ab12cd34": { id: "xl/charts/chart2.xml" } } };
    act(() => void grid.handle!.objects.add({ chart: made }));
    await waitFor(() => expect(grid.handle!.objects.list().charts.map((c) => c.id)).toEqual([CHART.id, "xl/charts/chart2.xml"]));
    // Taken as the file's, not told back as his change: nothing more is sent.
    await new Promise((done) => setTimeout(done, EDIT_WAIT + 50));
    expect(lists()).toHaveLength(1);
  });

  it("says a list the file refused once and reads the file again, so the object is as it was", async () => {
    openWith(sheetView({ row: OBJECTS_ROW }));
    await gridUp();
    const loads = () => sheetHost.calls.filter((c) => c[0] === "load").length;
    const before = loads();
    sheetHost.nextEdit = { refuse: "“Budget” is protected. Unprotect the sheet in Excel before changing its charts and pictures." };
    act(() => void grid.handle!.objects.remove(CHART.id));
    await waitFor(() => expect(toasts.said).toEqual(["“Budget” is protected. Unprotect the sheet in Excel before changing its charts and pictures."]));
    await waitFor(() => expect(loads()).toBeGreaterThan(before));
    await gridUp();
    expect(grid.handle!.objects.list().charts.map((c) => c.id)).toEqual([CHART.id]);
    // Said once, as a stopped change: no "Couldn't save" line waits on a Reload press.
    expect(screen.queryByText("Couldn't save")).toBeNull();
  });

  it("sends nothing where the host keeps no objects", async () => {
    openWith(sheetView({ row: ROW_ALL }));
    await gridUp();
    act(() => void grid.handle!.objects.remove(CHART.id));
    await new Promise((done) => setTimeout(done, EDIT_WAIT + 50));
    expect(lists()).toEqual([]);
  });

  it("puts a picture he picks on the grid and sends it with its bytes", async () => {
    openWith(sheetView({ row: OBJECTS_ROW }));
    await gridUp();
    const input = await waitFor(() => document.querySelector<HTMLInputElement>("[data-sheet-picture-input]")!);
    expect(input.accept).toBe("image/png,image/jpeg,image/gif,image/bmp");
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const file = new File([bytes], "Team photo.png", { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(lists().some((m) => (m.params as { kind: string }).kind === "pictures")).toBe(true));
    const sent = lists().find((m) => (m.params as { kind: string }).kind === "pictures")!.params as { list: { id: string; name?: string; data?: string }[] };
    expect(sent.list.map((p) => [p.name, p.data])).toEqual([["Logo", undefined], ["Team photo", btoa(String.fromCharCode(...bytes))]]);
    // The grid draws a made picture from the bytes the canvas keeps.
    const made = grid.handle!.objects.list().pictures[1]!;
    const blob = await grid.objectsGiven!.media!(made.part);
    expect(blob instanceof Blob && blob.type).toBe("image/png");
  });

  it("offers no picture picker where the host keeps no pictures", async () => {
    openWith(sheetView({ row: ROW_ALL }));
    await gridUp();
    expect(document.querySelector("[data-sheet-picture-input]")).toBeNull();
  });

  it("draws an old chart row as the chart it becomes, and sends nothing until he changes that tab's charts", async () => {
    const legacy = { ...CHART, id: "legacy:c1", kind: "bar" as const, title: { text: "Totals" } };
    openWith(sheetView({ row: OBJECTS_ROW, legacyCharts: [legacy] }));
    await gridUp();
    await waitFor(() => expect(grid.handle!.objects.list().charts.map((c) => c.id)).toEqual([CHART.id, "legacy:c1"]));
    expect(document.querySelector("[data-sheet-chart]")).toBeNull();
    await new Promise((done) => setTimeout(done, EDIT_WAIT + 50));
    expect(lists()).toEqual([]);
    act(() => void grid.handle!.objects.move(CHART.id, anchor));
    await waitFor(() => expect(lists()).toHaveLength(1));
    expect((lists()[0]!.params as { list: { id: string }[] }).list.map((c) => c.id)).toEqual([CHART.id, "legacy:c1"]);
  });

  it("⌃⌥5 takes the first object in hand, and Tab and ⇧Tab walk them while one is", async () => {
    openWith(sheetView({ row: OBJECTS_ROW }));
    await gridUp();
    const frame = document.querySelector<HTMLElement>("[data-sheet-item]")!;
    frame.tabIndex = -1;
    frame.focus();
    fireEvent.keyDown(window, { key: "5", code: "Digit5", ctrlKey: true, altKey: true });
    expect(grid.handle!.objects.state().selected).toBe(CHART.id);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(grid.handle!.objects.state().selected).toBe(PICTURE.id);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(grid.handle!.objects.state().selected).toBe(CHART.id);
  });
});

describe("charts and pictures on a sheet the service holds", () => {
  const ROW: NonNullable<SheetView["row"]> = [...ROW_ALL, "chart", "picture", "objects"];
  const at = (row: number) => ({ kind: "oneCell" as const, from: { column: 6, row, columnOffset: 0, rowOffset: 0 }, width: 4572000, height: 2743200 });
  const CHART = { id: "chart-ab12cd34", sheet: "Budget", anchor: at(1), kind: "column" as const, grouping: "clustered" as const, groups: [{ kind: "column" as const, grouping: "clustered" as const }], legend: null, axes: {}, series: [{ kind: "column" as const, group: 0, values: { ref: "Budget!$E$2:$E$5" } }], flags: {} };
  const INSERT: SheetMutationJson = { id: "sheet.mutation.insert-row", params: { unitId: "book", subUnitId: "budget", range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 25 } } };
  const SERVICE = sheetView({ store: "tcsheet", name: "Plan.tcsheet", row: ROW });

  function openHeld(objects?: { charts: (typeof CHART)[]; pictures: never[]; warnings: never[] }) {
    sheetHost = fakeSheetHost(SERVICE, objects ? { workbook: BOOK, objects } : BOOK);
    grid = fakeGrid();
    host.current = fakeHost([ITEM], host as never);
    return render(
      <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
        <div data-testid="thread" />
      </CanvasSeat>,
    );
  }
  const sentIds = () => edits().map((e) => e.mutations.map((m) => (m.id === "tempcode.sheet.rules" ? `list:${(m.params as { kind: string }).kind}` : m.id)));

  it("draws the layer on a sheet with none yet, so a chart made there is drawn and sent", async () => {
    openHeld();
    await gridUp();
    expect(grid.objectsGiven?.objects).toEqual({ charts: [], pictures: [], warnings: [] });
    act(() => void grid.handle!.objects.add({ chart: CHART }));
    await waitFor(() => expect(sentIds()).toEqual([["list:charts"]]));
  });

  it("sends the grid's own list after the rows he put in, in one edit: the host moves, then takes his grid's list", async () => {
    openHeld({ charts: [CHART], pictures: [], warnings: [] });
    await gridUp();
    act(() => {
      grid.edit(INSERT);
      // the kit follows the rows with the chart, as its own change caused by the cells
      grid.objectsGiven!.onObjects!({ kind: "set", object: { chart: { ...CHART, anchor: at(3) } }, cause: "cells" });
    });
    await waitFor(() => expect(sentIds()).toEqual([["sheet.mutation.insert-row", "list:charts"]]));
  });

  it("lays a list from elsewhere on the grid, and sends nothing back for what the grid moved under ops from elsewhere", async () => {
    openHeld({ charts: [CHART], pictures: [], warnings: [] });
    await gridUp();
    grid.onApply = () => grid.objectsGiven!.onObjects!({ kind: "set", object: { chart: { ...CHART, anchor: at(3) } }, cause: "cells" });
    act(() => sheetHost.land([INSERT]));
    await waitFor(() => expect(grid.applied.length).toBeGreaterThan(0));
    const moved = { ...CHART, anchor: at(7), title: { text: "Moved by Dana" } };
    act(() => sheetHost.land([{ id: "tempcode.sheet.rules", params: { unitId: "book", kind: "charts", subUnitId: "budget", list: [moved] } }]));
    await waitFor(() => expect(grid.handle!.objects.list().charts).toEqual([moved]));
    // the list was not laid on the cells, and nothing went back
    expect(grid.applied.flat().some((m) => m.id === "tempcode.sheet.rules")).toBe(false);
    await new Promise((done) => setTimeout(done, EDIT_WAIT + 50));
    expect(edits()).toEqual([]);
  });

  it("sends a made picture's bytes once: a later change to its tab names its part alone", async () => {
    openHeld();
    await gridUp();
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    let id = "";
    act(() => void (id = grid.handle!.objects.add({ picture: { bytes, type: "image/png", name: "Logo" } })!));
    await waitFor(() => expect(edits()).toHaveLength(1));
    act(() => void grid.handle!.objects.move(id, at(5)));
    await waitFor(() => expect(edits()).toHaveLength(2));
    const data = edits().map((e) => ((e.mutations[0]!.params as { list: { data?: string }[] }).list[0]!.data ?? null));
    expect(data).toEqual([btoa(String.fromCharCode(...bytes)), null]);
  });

  it("an Excel file still sends nothing for what only follows its rows: its own writer moves its drawings", async () => {
    sheetHost = fakeSheetHost(sheetView({ row: ROW }), { workbook: BOOK, objects: { charts: [CHART], pictures: [], warnings: [] } });
    grid = fakeGrid();
    host.current = fakeHost([ITEM], host as never);
    render(
      <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
        <div />
      </CanvasSeat>,
    );
    await gridUp();
    act(() => grid.objectsGiven!.onObjects!({ kind: "set", object: { chart: { ...CHART, anchor: at(3) } }, cause: "cells" }));
    await new Promise((done) => setTimeout(done, EDIT_WAIT + 50));
    expect(edits()).toEqual([]);
  });

  it("the grid opens a held sheet's snapshot with its charts and the bytes of its made pictures", async () => {
    const { univerGrid } = await import("./grid");
    const snapshot = {
      ...BOOK,
      resources: [
        { name: "TEMPCODE_SHEET_OBJECTS", data: JSON.stringify({ v: 1, charts: [CHART], pictures: [{ id: "picture-1", sheet: "Budget", anchor: at(2), part: "media:p1", contentType: "image/png" }] }) },
        { name: "TEMPCODE_SHEET_MEDIA", data: JSON.stringify({ "media:p1": { type: "image/png", data: btoa("\x89PNG") } }) },
      ],
    };
    const book = await univerGrid.decode(new TextEncoder().encode(JSON.stringify(snapshot)), "snapshot");
    expect(book.objects?.charts).toEqual([CHART]);
    expect(book.objects?.pictures.map((p) => p.part)).toEqual(["media:p1"]);
    expect([...book.media!.get("media:p1")!.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // a snapshot with none opens with none
    expect((await univerGrid.decode(new TextEncoder().encode(JSON.stringify(BOOK)), "snapshot")).objects).toBeUndefined();
  });
});

describe("old charts on a workbook desktop Excel or Google holds", () => {
  const anchor = { kind: "oneCell" as const, from: { column: 4, row: 2, columnOffset: 0, rowOffset: 0 }, width: 3619500, height: 1905000 };
  const OLD = { id: "legacy:c1", sheet: "Budget", anchor, kind: "bar" as const, grouping: "clustered" as const, groups: [{ kind: "bar" as const, grouping: "clustered" as const }], legend: null, axes: {}, series: [{ kind: "bar" as const, group: 0, values: { ref: "'Budget'!$B$1:$B$5" } }], flags: {}, title: { text: "Totals" } };
  // a row whose tab the workbook no longer has
  const GONE = { ...OLD, id: "legacy:c2", sheet: "Old tab" };

  for (const to of ["excel", "google"] as const)
    it(`are drawn on the grid to see and nothing about them is sent (${to})`, async () => {
      // As the host answers such a workbook: a package with no row, the switch to its app, the old rows as charts.
      open(sheetView({ reach: { parts: ["formatting", "inserting rows and columns"], to }, legacyCharts: [OLD, GONE] }), { selection: "A1:B5" });
      await gridUp();
      expect(grid.objectsGiven?.objects).toEqual({ charts: [], pictures: [], warnings: [] });
      await waitFor(() => expect(grid.handle!.objects.list().charts.map((c) => c.id)).toEqual(["legacy:c1"]));
      // No row, so nothing to select or change them with, and More offers no Chart.
      expect(screen.queryByRole("toolbar", { name: "Formatting" })).toBeNull();
      fireEvent.click(await screen.findByRole("button", { name: "More" }));
      await screen.findByRole("menuitem", { name: "Preview…" });
      expect(screen.queryByRole("menuitem", { name: "Chart" })).toBeNull();
      // Whatever the grid tells of them goes nowhere.
      act(() => grid.objectsGiven!.onObjects!({ kind: "set", object: { chart: { ...OLD, anchor: { ...anchor, from: { ...anchor.from, row: 9 } } } } }));
      await new Promise((done) => setTimeout(done, EDIT_WAIT + 50));
      expect(edits()).toEqual([]);
    });
});
