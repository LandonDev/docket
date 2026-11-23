import { useState } from "react";
import type { SheetImportAct, SheetImported } from "@shared/work/sheetFormats";
import { BusyLabel, Button } from "../../components/ui/button";
import { importNotice } from "./imported";

/**
 * The one quiet line over the grid of a sheet that is an Excel copy (docs/DESIGN.md "A sheet opened
 * as a copy"): the deck's read-only line again. 12px muted words, a hairline under them, and one
 * press 8px after: a link button that says it is busy while it runs and takes no second press
 * meanwhile. The words wrap rather than cut, since they say what a save would lose. `run` never rejects (imported.ts `runImport` says a failure in a toast).
 */
export function ImportLine({ imported, shared, run }: { imported: SheetImported; shared: boolean; run(act: SheetImportAct): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const { words, press } = importNotice(imported, shared);
  const go = () => {
    if (busy) return;
    setBusy(true);
    void run(press.act).finally(() => setBusy(false));
  };
  return (
    <div data-sheet-import={imported.format} className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-xs text-muted-foreground">
      {/* What the format drops is never cut: in a narrow pane the words take a second line. */}
      <span className="min-w-0">{words}</span>
      {/* The press is as tall as its line to a pointer: the words beside it are 16px. */}
      <Button variant="link" size="xs" className="relative h-auto shrink-0 px-0 text-xs after:absolute after:-inset-x-1 after:-inset-y-1" disabled={busy} onClick={go}>
        <BusyLabel busy={busy} label={press.label} />
      </Button>
    </div>
  );
}
