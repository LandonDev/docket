import type { SheetMutationJson, SheetView } from "@shared/contract-work-sheets";
import type { SheetImportAct, SheetImportDone } from "@shared/work/sheetFormats";
import type { ObjectIds } from "@shared/work/sheets";
import { isLightScheme } from "../../lib/appearance";
import { registry } from "../../lib/connection";
import { openUrl } from "../../lib/native";

/**
 * The host's side of a sheet item, as its canvas uses it
 * (src/shared/contract-work-sheets.ts). The canvas takes no value from the
 * contract, which holds zod schemas (firstPaint.test.ts), so its two limits
 * are written again here; a test holds them equal.
 */

/** `SHEET_LOAD_MAX`: the most bytes one load answers. */
export const LOAD_MAX = 4 * 1024 * 1024;
/** `SHEET_EDIT_MAX`: the most mutations one edit carries. */
export const EDIT_MAX = 500;

export interface SheetOp {
  rev: number;
  /** who made it: a principal, or the file */
  by: string;
  mutations: SheetMutationJson[];
}
export type SinceAnswer = { rev: number; ops: SheetOp[] } | { rev: number; reload: true };
export interface LoadAnswer {
  data: string;
  size: number;
  rev: number;
  format: "xlsx" | "snapshot";
}
export type ReviewWhich = { ids: string[] } | { changeSet: string } | "all";
export interface SheetPushed {
  rev: number;
  view?: SheetView;
  /** The view changed and was not sent (a sheet others can open): read it again. */
  stale?: true;
}

export interface SheetHost {
  open(): Promise<SheetView>;
  load(rev: number, offset: number, length: number): Promise<LoadAnswer>;
  since(rev: number): Promise<SinceAnswer>;
  /** `ids`: the charts and pictures the save wrote that the file now names otherwise */
  edit(baseRev: number, mutations: SheetMutationJson[]): Promise<{ rev: number; conflict?: boolean; ids?: ObjectIds }>;
  review(which: ReviewWhich, verdict: "accept" | "reject"): Promise<SheetView>;
  mode(mode: "suggests" | "writes"): Promise<SheetView>;
  undo(writeId: string): Promise<SheetView>;
  /** Writes the sheet out on the host (`work.sheets.export`); answers where it went, and what the file could not hold. */
  exportAs(format: "xlsx" | "csv", sheet?: string): Promise<{ path: string; left?: string[] }>;
  /** What he does with the Excel copy of an .xls, .ods or .tsv (`work.sheets.imported`): save it back, save it out as .xlsx, or read the file again. */
  imported(act: SheetImportAct): Promise<SheetImportDone>;
  /** Opens the file in the app `view.reach.to` names; refused where it is not on the host. The full editor answers its page, opened in the browser. */
  switchApp(): Promise<void>;
  /** Something landed on this item. */
  onPush(listener: (push: SheetPushed) => void): () => void;
}

/** A sheet item's host through the link to the host the thread lives on. */
export function linkSheetHost(environmentId: string, itemId: string): SheetHost {
  const link = (): ReturnType<typeof registry.linkOf> => registry.linkOf(environmentId);
  const call = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => link().request<T>(method, { itemId, ...params });
  return {
    open: () => call("work.sheets.open"),
    load: (rev, offset, length) => call("work.sheets.load", { rev, offset, length }),
    since: (rev) => call("work.sheets.since", { rev }),
    edit: (baseRev, mutations) => call("work.sheets.edit", { baseRev, mutations }),
    review: (which, verdict) => call("work.sheets.review", { which, verdict }),
    mode: (mode) => call("work.sheets.mode", { mode }),
    undo: (writeId) => call("work.sheets.undo", { writeId }),
    exportAs: (format, sheet) => call("work.sheets.export", { format, ...(sheet ? { sheet } : {}) }),
    imported: (act) => call("work.sheets.imported", { act }),
    switchApp: async () => {
      // The full editor is a page of its own. From a light window it opens light; from a dark one it
      // follows the browser's system, as it did (dark is held: docs/agents/appearance.md).
      const { url } = await call<{ opened: true; url?: string }>("work.sheets.switch", isLightScheme() ? { scheme: "light" } : {});
      if (url) await openUrl(url);
    },
    onPush: (listener) =>
      link().onPush((push) => {
        if (push.push === "work.sheets" && push.itemId === itemId) listener({ rev: push.rev, ...(push.view ? { view: push.view } : {}), ...(push.stale ? { stale: true as const } : {}) });
      }),
  };
}

export function fromBase64(data: string): Uint8Array {
  const text = atob(data);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}
