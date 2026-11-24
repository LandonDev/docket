import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { FormResponses } from "@shared/contract-work-forms";
import type { CanvasSource } from "@shared/work";
import { Checkbox } from "../../components/ui/checkbox";
import { Skeleton } from "../../components/ui/skeleton";
import { Table as DataTable, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { dayTime } from "../../lib/duration";
import type { CanvasShell } from "../canvas/kind";
import { plural, submittedTime } from "./model";

/**
 * A form's Responses, as both form kinds draw them (docs/agents/work-forms.md
 * "Responses"; our forms and Microsoft's, docs/agents/work-msforms.md): one
 * summary line, the bars of one choice question, a flat table. Ticked rows are
 * the selection, which Ask puts in the thread as text.
 */

/**
 * Each response's own key: a row is known by what it holds, its answers and the moment it was submitted. A newer
 * answer arriving above it moves its row, never its key, so what he ticked stays ticked.
 */
export function responseKeys(rows: readonly (readonly string[])[]): string[] {
  // Two rows the same in every answer and to the second are told apart by which of them comes first.
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = row.join("\u001f");
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n ? `${key}\u001e${n}` : key;
  });
}

export interface ResponseTableProps {
  title: string;
  got: FormResponses;
  /** the one choice question drawn as bars, with its counts */
  chart: { label: string; bars: { label: string; count: number }[] } | null;
  /** what a chip of ticked rows points at */
  chipRef: CanvasSource;
  shell: CanvasShell;
  /** the column that holds the submitted time: drawn last, muted, as a time */
  timeColumn: number | null;
  /** what the summary line says when not every response is shown ("the sheet has them all") */
  whole: string;
  /** one muted clause after the count ("as of 2:14 PM"), when the read is old */
  asOf?: string | null;
  /** a quiet verb at the summary line's end (a Microsoft form's Who hasn't answered) */
  aside?: ReactNode;
}

export function ResponseTable({ title, got, chart, chipRef, shell, timeColumn, whole, asOf, aside }: ResponseTableProps) {
  const lastAt = timeColumn === null ? null : submittedTime(got.rows[0]?.[timeColumn] ?? "");
  const bars = chart?.bars ?? [];
  const max = Math.max(1, ...bars.map((b) => b.count));
  // What he ticked, by each response's key, never its row: a new revision keeps the ones still there and drops the rest.
  const keys = useMemo(() => responseKeys(got.rows), [got.rows]);
  const [ticked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const picked = useMemo(() => {
    const here = new Set(keys);
    return new Set([...ticked].filter((k) => here.has(k)));
  }, [ticked, keys]);
  const table = useRef<HTMLTableElement>(null);
  useEffect(() => {
    const el = table.current;
    if (!picked.size || !el) return shell.selection(null);
    const rows = got.rows.filter((_, i) => picked.has(keys[i]!));
    const head = got.columns.map((c) => c.label).join("\t");
    shell.selection({
      chip: { kind: "selection", label: `${plural(rows.length, "response")}, ${title}`, ref: chipRef, quote: [head, ...rows.map((r) => r.join("\t"))].join("\n") },
      rect: (el.querySelector("tr[data-picked]") ?? el).getBoundingClientRect(),
    });
    return () => shell.selection(null);
  }, [shell, picked, got, keys, chipRef, title]);
  const toggle = (key: string): void =>
    setPicked(() => {
      const next = new Set(picked);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const all = got.rows.length > 0 && picked.size === keys.length;
  return (
    <div data-form-responses className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
      <div className="flex items-center gap-2 px-4 pt-3">
        <p className="min-w-0 flex-1 text-[13px] leading-5 text-muted-foreground">
          {plural(got.count, "response")}
          {got.cut ? ` shown, the newest; ${whole}` : ""}
          {lastAt ? `, the last ${dayTime(lastAt)}` : ""}
          {asOf ? `, ${asOf}` : ""}
        </p>
        {aside}
      </div>
      {chart && bars.length ? (
        <div role="img" aria-label={`${chart.label}: ${bars.map((b) => `${b.label} ${b.count}`).join(", ")}`} className="grid max-w-[560px] grid-cols-[minmax(0,max-content)_minmax(40px,1fr)_24px] items-center gap-x-3 gap-y-1.5 px-4 pt-3 pb-4 text-[13px] leading-5">
          <span className="col-span-full mb-0.5 font-medium">{chart.label}</span>
          {bars.map((b) => (
            <BarRow key={b.label} label={b.label} count={b.count} max={max} />
          ))}
        </div>
      ) : null}
      <div className="border-t border-border">
        <DataTable ref={table} className="min-w-max leading-5">
          <TableHeader>
            <TableRow>
              <TableHead className="w-4 pe-0 first:pl-4">
                <Checkbox aria-label="Select all" checked={all} onCheckedChange={() => setPicked(all ? new Set() : new Set(keys))} />
              </TableHead>
              {got.columns.map((c, i) => (
                <TableHead key={c.id} className={`last:pr-4 ${i === timeColumn ? "text-end" : ""}`}>
                  {c.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {got.rows.map((r, i) => (
              <TableRow key={keys[i]} data-picked={picked.has(keys[i]!) || undefined} className={picked.has(keys[i]!) ? "bg-(--sel-bg)" : ""}>
                <TableCell className="w-4 pe-0 first:pl-4">
                  <Checkbox aria-label="Select" checked={picked.has(keys[i]!)} onCheckedChange={() => toggle(keys[i]!)} />
                </TableCell>
                {r.map((v, j) => (
                  <Cell key={j} time={j === timeColumn}>
                    {j === timeColumn ? when(v) : v}
                  </Cell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </DataTable>
      </div>
    </div>
  );
}

const when = (v: string): string => {
  const t = submittedTime(v);
  return t === null ? v : dayTime(t);
};

function Cell({ time, children }: { time: boolean; children: ReactNode }) {
  return <TableCell className={`h-8 max-w-[320px] truncate last:pr-4 ${time ? "text-end text-muted-foreground" : ""}`}>{children}</TableCell>;
}

function BarRow({ label, count, max }: { label: string; count: number; max: number }) {
  return (
    <>
      <span className="min-w-0 truncate">{label}</span>
      <span className="h-2 origin-left rounded-e bg-(--chart-neutral)" style={{ width: `${(count / max) * 100}%` }} />
      <span className="text-end text-xs text-muted-foreground tabular-nums">{count}</span>
    </>
  );
}

export function ResponsesSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-3 p-4">
      <Skeleton className="h-3 w-[40%]" />
      <Skeleton className="h-3 w-[90%]" />
      <Skeleton className="h-3 w-[90%]" />
      <Skeleton className="h-3 w-[90%]" />
    </div>
  );
}
