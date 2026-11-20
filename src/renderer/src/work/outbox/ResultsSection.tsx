import { useState } from "react";
import { BusyLabel, Button } from "../../components/ui/button";
import { loadToast } from "../../components/ui/toaster";
import { LoadingLine } from "../../surfaces/SurfaceSkeleton";
import { timeOf } from "./model";
import { loadResults, undoResult, useResults, type HostResult } from "./results";

/**
 * A Work thread's Results (docs/DESIGN.md "Around the canvas"): what it and
 * its subagents sent and wrote that lasts, split by whether it can still be
 * taken back. Each row is the act in his words, then where and when, with
 * its way back. Listed only while there is one (lib/rightPanel.ts). A read
 * that failed is its red line with Retry, over the rows already read, never
 * an empty list.
 */
export function ResultsSection({ environmentId, sessionId }: { environmentId: string; sessionId: string }) {
  const { rows, loaded, error, reading } = useResults(environmentId, sessionId, true);
  if (!loaded && rows.length === 0) return <LoadingLine label="Loading the results" />;
  const can = rows.filter((r) => r.undo && !r.undoneAt);
  const cannot = rows.filter((r) => !r.undo || r.undoneAt);
  return (
    <div data-slot="results" className="flex min-h-0 flex-col gap-4 overflow-x-hidden overflow-y-auto px-3 pb-3">
      {error ? (
        <div role="alert" className="flex min-h-7 items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 text-destructive">{error}</span>
          <Button variant="ghost" size="xs" disabled={reading} onClick={() => loadResults(environmentId, sessionId)}>
            <BusyLabel busy={reading} label="Retry" />
          </Button>
        </div>
      ) : null}
      {can.length ? <Group title="Can undo" rows={can} /> : null}
      {cannot.length ? <Group title="Can't undo" rows={cannot} /> : null}
    </div>
  );
}

function Group({ title, rows }: { title: string; rows: HostResult[] }) {
  return (
    <section aria-label={title} className="flex flex-col">
      <div className="flex h-7 items-center text-xs font-medium text-muted-foreground">{title}</div>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <ResultRow key={row.id} row={row} />
        ))}
      </ul>
    </section>
  );
}

function ResultRow({ row }: { row: HostResult }) {
  const [busy, setBusy] = useState(false);
  const undo = async () => {
    setBusy(true);
    try {
      await undoResult(row);
      void loadToast().then((t) => t(`Undone: ${row.summary}`));
    } catch (err) {
      void loadToast().then((t) => t.error(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };
  const where = [row.account, timeOf(row.createdAt)].filter(Boolean).join(", ");
  return (
    <li className="flex min-w-0 items-start gap-2 border-t border-border py-1.5 first:border-t-0">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px] leading-5">{row.summary}</span>
        <span className="truncate text-xs leading-4 text-muted-foreground">{where}</span>
      </span>
      {row.undoneAt ? (
        <span className="shrink-0 text-xs leading-6 text-muted-foreground">Undone</span>
      ) : row.undo ? (
        <Button variant="ghost" size="xs" className="-mt-0.5 shrink-0" disabled={busy} onClick={() => void undo()}>
          <BusyLabel busy={busy} label={row.undo.label ?? "Undo"} />
        </Button>
      ) : null}
    </li>
  );
}
