import { SHEET_IMPORT_DROPS, type SheetImportAct, type SheetImportDone, type SheetImported } from "@shared/work/sheetFormats";
import { RefreshCw } from "../../chrome/icons";
import { loadToast } from "../../components/ui/toaster";
import { sayError } from "../canvas/frame";
import type { MoreEntry } from "../canvas/kind";
import { Export } from "../icons";

/**
 * A sheet that is the Excel copy of an .xls, .ods or .tsv (docs/agents/work-sheets.md "Other
 * formats in"): what its one quiet line says, its rows of the pane's More, and what a press
 * answers. The words are here, in one place, so the line, the menu and the toasts agree.
 */

export interface ImportNotice {
  words: string;
  press: { act: SheetImportAct; label: string };
}

const SAVE_AS_EXCEL = "Save as Excel";

/**
 * The line over the grid. It says where his edits go and what the first format drops, with Save back;
 * when the copy cannot go back (the file holds macros, or changed under his edits) it says why, and the
 * press is the way that keeps his edits. `shared`: others can open the file, so the copy lasts only as
 * long as its tab.
 */
export function importNotice(imported: SheetImported, shared: boolean): ImportNotice {
  const out = { act: "xlsx" as const, label: SAVE_AS_EXCEL };
  if (imported.noBack) return { words: `${imported.noBack}, so it is not saved back.`, press: out };
  if (imported.stale) return { words: "This file changed since the copy was made, so it is not saved back.", press: out };
  const where = shared ? "Edits stay in this tab's Excel copy until you save back" : "Edits save to an Excel copy";
  return { words: `${where}. Saving back as .${imported.format} drops ${SHEET_IMPORT_DROPS[imported.format]}.`, press: { act: "back", label: "Save back" } };
}

/** The copy's rows of the pane's More: each way out by name, and the one that drops his edits only when the file moved on. */
export function importRows(imported: SheetImported | undefined, run: (act: SheetImportAct) => Promise<void>): MoreEntry[] {
  if (!imported) return [];
  return [
    ...(imported.noBack || imported.stale ? [] : [{ id: "import-back", label: `Save back as .${imported.format}`, icon: Export, run: () => run("back") }]),
    { id: "import-xlsx", label: SAVE_AS_EXCEL, icon: Export, run: () => run("xlsx") },
    ...(imported.stale ? [{ id: "import-again", label: "Discard edits and read again", icon: RefreshCw, run: () => run("again") }] : []),
  ];
}

const nameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** What a press that went through says: the file by its name, and under it what the format left behind of this workbook. */
export function importDone(imported: SheetImported, act: SheetImportAct, done: SheetImportDone): { title: string; description?: string } {
  if (act === "again") return { title: `Read ${imported.name} again` };
  const title = `Saved ${done.path ? nameOf(done.path) : imported.name}`;
  return done.drops?.length ? { title, description: `${done.drops.join(". ")}.` } : { title };
}

const FAILED: Record<SheetImportAct, string> = { back: "Couldn't save back", xlsx: "Couldn't save as Excel", again: "Couldn't read the file again" };

/** One press: asked of the host, then said in one toast, whichever way it went. It never rejects. */
export async function runImport(ask: (act: SheetImportAct) => Promise<SheetImportDone>, imported: SheetImported, act: SheetImportAct): Promise<void> {
  try {
    const { title, description } = importDone(imported, act, await ask(act));
    const toast = await loadToast();
    toast.success(title, description ? { description } : undefined);
  } catch (error) {
    sayError(error, FAILED[act]);
  }
}
