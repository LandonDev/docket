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

/** The last name in a path, a file's or a folder's, on any host. */
export const nameOf = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const folderOf = (path: string): string => path.replace(/[\\/][^\\/]*$/, "");

/** What a file he wrote out says in its toast: "Saved Budget.csv to Spring LAN" with the folder to Show, or only its name where it landed in no folder of his. */
export function savedTo(path: string, folder?: string): { title: string; folder?: string } {
  const name = nameOf(path);
  const where = folder ? nameOf(folder) : "";
  return folder && where ? { title: `Saved ${name} to ${where}`, folder } : { title: `Saved ${name}` };
}

/** What a press that went through says: the file by its name and folder, and under it what the format left behind of this workbook. */
export function importDone(imported: SheetImported, act: SheetImportAct, done: SheetImportDone): { title: string; description?: string; folder?: string } {
  if (act === "again") return { title: `Read ${imported.name} again` };
  // Saved back over his file, or as Excel beside it or in his workspace's folder: always a folder of his.
  const saved = done.path ? savedTo(done.path, folderOf(done.path)) : { title: `Saved ${imported.name}` };
  return done.drops?.length ? { ...saved, description: `${done.drops.join(". ")}.` } : saved;
}

const FAILED: Record<SheetImportAct, string> = { back: "Couldn't save back", xlsx: "Couldn't save as Excel", again: "Couldn't read the file again" };

/** One press: asked of the host, then said in one toast, whichever way it went, with Show on the folder it saved to where `show` is given. It never rejects. */
export async function runImport(ask: (act: SheetImportAct) => Promise<SheetImportDone>, imported: SheetImported, act: SheetImportAct, show?: (folder: string) => void): Promise<void> {
  try {
    const { title, description, folder } = importDone(imported, act, await ask(act));
    const toast = await loadToast();
    const options = { ...(description ? { description } : {}), ...(folder && show ? { action: { label: "Show", onClick: () => show(folder) } } : {}) };
    toast.success(title, Object.keys(options).length ? options : undefined);
  } catch (error) {
    sayError(error, FAILED[act]);
  }
}
