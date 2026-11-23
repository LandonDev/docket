// A preview frame for `bun run ui:preview src/renderer/src/work/sheets/SheetBody.preview.tsx#SheetPreview --width 864`:
// the sheet kind in the canvas pane beside a thread, as the approved page draws it
// (.temp-code/prototypes/work-workspaces-2/sheet.html, "In the cells"), on a table in place
// of Univer's grid, which paints on a canvas the static render does not have.
import { SHEET_ROW, type SheetView } from "@shared/contract-work-sheets";
import type { CanvasItem, CanvasKind } from "@shared/work";
import { Composer } from "../../chrome/Composer";
import { composerFixtureBase } from "../../chrome/Composer.fixtures";
import { defineChunk } from "../../lib/lazyChunk";
import { workCanvasChunk } from "../../surfaces/chunks";
import { ChatFooter } from "../../surfaces/threads/chatSlots";
import { CanvasSeat } from "../canvas/CanvasSeat";
import type { CanvasBodyProps, CanvasKindDef } from "../canvas/kind";
import { CANVAS } from "../canvas/registry";
import { applyCanvasPush, resetCanvasStore } from "../canvas/store";
import * as SheetBody from "./SheetBody";
import { BUDGET, BUDGET_CHANGES, INVOICES } from "./SheetBody.preview.fixtures";
import { resetSheetSyncs, SheetSync, syncOf, type Workbook } from "./sync";
import { fakeGrid, fakeSheetHost, sheetView, type FakeGrid } from "./testkit";

export type SheetMoment = "suggestions" | "stepped" | "own" | "format" | "proposed" | "loading" | "readonly" | "waits";

void workCanvasChunk.load();

const AT = Date.UTC(2026, 10, 18, 20, 4);

function setUp(moment: SheetMoment): { view: SheetView; book: Workbook; title: string; grid: FakeGrid; hold?: boolean } {
  const budget = { title: "Nationals travel budget.xlsx", book: BUDGET };
  if (moment === "own")
    return {
      title: "Invoices 2026",
      book: INVOICES,
      grid: fakeGrid({ selection: "F4", columns: 7 }),
      view: sheetView({ name: "Invoices 2026", store: "package", mode: "writes", written: { id: "w1", text: "Changed 6 cells", at: AT } }),
    };
  // A sheet TempCode keeps: every control of the format row, the selection on a bold heading.
  if (moment === "format")
    return {
      title: "Invoices 2026",
      book: INVOICES,
      grid: fakeGrid({ selection: "E1", columns: 7 }),
      view: sheetView({ name: "Invoices 2026", store: "tcsheet", mode: "writes", row: [...SHEET_ROW.tcsheet] }),
    };
  // An opened Excel file others can open: the agent's format waits in words, stepped from the bar.
  if (moment === "proposed")
    return {
      ...budget,
      grid: fakeGrid({ selection: "E4" }),
      view: sheetView({
        shared: true,
        row: [...SHEET_ROW.package],
        changes: [{ id: "f1", changeSet: "turn2", by: "agent:local:t1", kind: "format", sheet: "budget", range: { startRow: 3, endRow: 7, startColumn: 4, endColumn: 4 }, words: "Bold, yellow fill on E4:E8", state: "pending", reason: "the line totals" }],
      }),
    };
  // An opened Excel file that holds what only Excel does: the bar says what waits there, beside the switch.
  if (moment === "waits")
    return {
      title: "Season stats.xlsx",
      book: INVOICES,
      grid: fakeGrid({ selection: "F4", columns: 7 }),
      view: sheetView({ name: "Season stats.xlsx", store: "package", mode: "writes", canUpload: true, reach: { parts: ["2 pivot tables", "12 charts", "macros"], to: "excel" } }),
    };
  if (moment === "loading") return { ...budget, grid: fakeGrid(), view: sheetView(), hold: true };
  if (moment === "readonly") return { ...budget, grid: fakeGrid({ selection: "E5" }), view: sheetView({ readOnly: "Saved as .xlsb, which opens here only to read" }) };
  return { ...budget, grid: fakeGrid(), view: sheetView({ shared: true, suggestions: BUDGET_CHANGES, reach: { parts: ["a pivot table"], to: "excel" } }) };
}

export function SheetPreview({ moment = "suggestions" }: { moment?: SheetMoment }) {
  resetCanvasStore();
  resetSheetSyncs();
  const sessionId = `preview-sheet-${moment}`;
  const itemId = `${sessionId}-item`;
  const { view, book, title, grid, hold } = setUp(moment);
  const item: CanvasItem = { id: itemId, sessionId, workspaceId: "ws", kind: "sheet" as CanvasKind, title, source: { at: "file", host: "local", path: `/work/${title}` }, state: "open", position: 0, rev: 0, createdAt: 0, updatedAt: 0 };
  const host = fakeSheetHost({ ...view, itemId }, book);
  host.hold = !!hold;
  // Stepped to the third change, as a person pressing Next twice leaves it; the grid opens on it.
  if (moment === "stepped") syncOf(`local\n${itemId}`, () => new SheetSync(host, grid.decode)).step(2);
  const deps = { host, grid };
  const module = {
    Body: (props: CanvasBodyProps) => <SheetBody.Body {...(props as CanvasBodyProps<undefined>)} {...deps} />,
    Bar: (props: CanvasBodyProps) => <SheetBody.Bar {...(props as CanvasBodyProps<undefined>)} {...deps} />,
    TabEnd: (props: CanvasBodyProps) => <SheetBody.TabEnd {...(props as CanvasBodyProps<undefined>)} {...deps} />,
  };
  const chunk = defineChunk(`preview-sheet-${moment}`, () => Promise.resolve(module));
  void chunk.load();
  const kinds: Record<CanvasKind, CanvasKindDef> = { ...CANVAS, sheet: { ...CANVAS.sheet, chunk: chunk as never } };
  applyCanvasPush({ sessionId, items: [item], opened: itemId });
  return (
    <div className="flex h-[560px] w-full overflow-hidden rounded-xl border border-border">
      <CanvasSeat session={{ id: sessionId, environmentId: "local" }} kinds={kinds}>
        <div className="flex min-h-0 flex-1 flex-col justify-end">
          <ChatFooter slots={{ transcript: null, strip: null, composer: <Composer {...composerFixtureBase} sessionId={sessionId} /> }} />
        </div>
      </CanvasSeat>
    </div>
  );
}
