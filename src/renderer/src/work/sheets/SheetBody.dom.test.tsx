// @vitest-environment jsdom
/**
 * The sheet kind in the real canvas pane, with a host that keeps one item's
 * view and op log and a table in place of Univer's grid: suggestions laid
 * into their cells and stepped from the bar, edits sent in batches from the
 * revision the grid stands at, a conflict caught up and sent again, another
 * person's op brought in, the written line, a chart, and the switch.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SheetMutationJson, SheetView } from "@shared/contract-work-sheets";
import { SHEET_EDIT_MAX, SHEET_LOAD_MAX } from "@shared/contract-work-sheets";
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

function open(view: SheetView, options: { selection?: string } = {}) {
  sheetHost = fakeSheetHost(view, BOOK);
  grid = fakeGrid(options);
  host.current = fakeHost([ITEM], host as never);
  return render(
    <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
      <div data-testid="thread" />
    </CanvasSeat>,
  );
}

const cell = (a1: string): HTMLElement => document.querySelector<HTMLElement>(`[data-cell="${a1}"]`)!;
const gridUp = () => waitFor(() => expect(grid.listening()).toBe(true));
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
  await new Promise<void>((done) => openMenus(done));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
    await waitFor(() => expect(within(screen.getByRole("toolbar", { name: "Review changes" })).getByText("1/1")).toBeTruthy());
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

  it("sends an opened Excel file cell contents only, says once that the rest stays out, and never resends a refused batch", async () => {
    open(sheetView({ store: "package", rev: 3 }));
    await gridUp();
    const bold: SheetMutationJson = { id: "sheet.mutation.set-range-values", params: { unitId: "book", subUnitId: "budget", cellValue: { 1: { 1: { s: { bl: 1 } } } } } };
    const fill: SheetMutationJson = { id: "sheet.mutation.set-range-values", params: { unitId: "book", subUnitId: "budget", cellValue: { 2: { 4: { si: "f1" } } } } };
    const row: SheetMutationJson = { id: "sheet.mutation.insert-row", params: { unitId: "book", subUnitId: "budget" } };
    const autoHeight: SheetMutationJson = { id: "sheet.mutation.set-worksheet-row-auto-height", params: {} };
    act(() => {
      grid.edit(bold);
      grid.edit(row);
      grid.edit(fill);
      grid.edit(autoHeight);
      grid.edit(set(1, 1, 15));
    });
    await waitFor(() => expect(edits()).toHaveLength(1), { timeout: EDIT_WAIT * 10 });
    expect(edits()[0]).toEqual({ baseRev: 3, mutations: [set(1, 1, 15)] });
    expect(await screen.findByText("Not saved")).toBeTruthy();
    expect(screen.getAllByText("Not saved")).toHaveLength(1);

    // A refused batch is said with Reload and dropped: the next edit goes alone.
    const edit = sheetHost.edit;
    sheetHost.edit = async () => {
      throw new Error("That edit is not cell contents");
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

  it("shows what the agent wrote directly, with Undo, and its mode", async () => {
    open(sheetView({ mode: "writes", written: { id: "w1", text: "Changed 6 cells", at: Date.now() } }));
    await gridUp();
    expect(await screen.findByText(/Changed 6 cells/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Agent writes/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(sheetHost.calls).toContainEqual(["undo", "w1"]));
  });

  it("draws a chart's bars from the cells of its range", async () => {
    open(sheetView({ charts: [{ id: "c1", sheet: "budget", range: "A1:E5", title: "Spend", row: 7, col: 1 }] }));
    await gridUp();
    const chart = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-sheet-chart="c1"]');
      expect(el).not.toBeNull();
      return el!;
    });
    // A1:E5's first column names the bars and its second sizes them; the header and Ground (no quantity) have no number.
    expect(chart.querySelectorAll("[data-sheet-bar]")).toHaveLength(3);
    expect(within(chart).getByText("Flights")).toBeTruthy();
  });

  it("makes a chart from a selection two columns wide through More", async () => {
    open(sheetView(), { selection: "A1:B5" });
    await gridUp();
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Chart" }));
    await waitFor(() => expect(sheetHost.calls.some((c) => c[0] === "chart")).toBe(true));
    const made = sheetHost.calls.find((c) => c[0] === "chart")![1] as { chart: { range: string; title: string; col: number } };
    expect(made.chart).toMatchObject({ range: "A1:B5", title: "Qty", col: 3 });
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
});
