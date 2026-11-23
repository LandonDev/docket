import { useMemo, useState, type ReactNode } from "react";
import type { MoreEntry } from "../canvas/kind";
import { UploadGoogleDialog } from "../google/UploadGoogleDialog";
import { Export } from "../icons";

/**
 * Save to Google Sheets (docs/agents/work-sheets.md "Save to Google Sheets"): the sheet's row of the pane's
 * More and the dialog it opens, the google pillar's own (an account of his that allows Drive files, then Save:
 * `work.google.upload`). `offered` is the host's word (`SheetView.canUpload`): a workbook of his own that this
 * host holds, never one others can open and never one Google already has.
 */
export function useSaveToGoogle({ env, itemId, offered }: { env: string; itemId: string; offered: boolean }): { row: MoreEntry | null; dialog: ReactNode } {
  const [open, setOpen] = useState(false);
  const row = useMemo<MoreEntry | null>(() => (offered ? { id: "google-upload", label: "Save to Google Sheets", icon: Export, run: () => setOpen(true) } : null), [offered]);
  // An offer the host takes back (the file moved into a library) takes the dialog with it.
  return { row, dialog: open && offered ? <UploadGoogleDialog env={env} itemId={itemId} kind="Sheets" onClose={() => setOpen(false)} /> : null };
}
