import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { FormResponses } from "@shared/contract-work-forms";
import type { CanvasSource } from "@shared/work";
import { Checkbox } from "../../components/ui/checkbox";
import { Bone, Bones, useInBones } from "../../components/bones";
import { Tabs, TabsIndicator, TabsList, TabsTrigger, TABS_PILL_TRIGGER } from "../../components/ui/tabs";
import { Table as DataTable, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useOverflowEdges } from "../../hooks/useOverflowEdges";
import { dayTime } from "../../lib/duration";
import type { CanvasShell } from "../canvas/kind";
import { plural, submittedTime } from "./model";

/**
 * A form bar's Questions (or Form) and Responses tabs: the 24px track insets its pill 2px, so each tab's press reaches
 * 2px over and under it to take the track's whole 24px.
 */
export const HALF_TAB = "px-2 text-xs after:absolute after:inset-x-0 after:-inset-y-0.5 after:content-['']";

/**
 * The answers' table scrolls sideways inside its own box (the table's container): while more of it lies past an edge,
 * that edge fades over 24px, so a pane narrower than the table says it goes on. The flags sit on the container
 * (`useOverflowEdges`); the mask is the wrapper's, the same ramp as `OVERFLOW_FADE`.
 */
const TABLE_FADE =
  "[&:has(>[data-overflow-start])]:[--fade-start:24px] [&:has(>[data-overflow-end])]:[--fade-end:24px] [mask-image:linear-gradient(90deg,transparent_var(--fade-clear-start,0px),var(--foreground)_calc(var(--fade-clear-start,0px)_+_var(--fade-start,0px)),var(--foreground)_calc(100%_-_var(--fade-clear-end,0px)_-_var(--fade-end,0px)),transparent_calc(100%_-_var(--fade-clear-end,0px)))]";

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

/** What a response's tick names it by: its first answer that is not the time ("Marcus Lee"), else its place ("response 3"). */
export const responseName = (row: readonly string[], timeColumn: number | null, index: number): string =>
  row.find((v, j) => j !== timeColumn && v.trim() !== "")?.trim() ?? `response ${index + 1}`;

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
  const edges = useOverflowEdges<HTMLElement>();
  useEffect(() => {
    const box = table.current?.parentElement ?? null;
    edges(box);
    if (!box) return () => edges(null);
    // While the answers run past the pane, their box is a stop of its own (the ticks are the table's only other
    // stops), so the keyboard can scroll it sideways; it says so with the house ring.
    box.classList.add("focus-ring");
    box.setAttribute("role", "region");
    box.setAttribute("aria-label", "Responses");
    const stop = () => {
      if (box.scrollWidth > box.clientWidth) box.tabIndex = 0;
      else box.removeAttribute("tabindex");
    };
    stop();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(stop);
    ro?.observe(box);
    if (table.current) ro?.observe(table.current);
    return () => {
      ro?.disconnect();
      edges(null);
    };
  }, [edges]);
  // The bones' table publishes no selection: the drawing is unseen, and the pane's real selection is not its to clear.
  const inBones = useInBones();
  useEffect(() => {
    if (inBones) return;
    const el = table.current;
    if (!picked.size || !el) return shell.selection(null);
    const rows = got.rows.filter((_, i) => picked.has(keys[i]!));
    const head = got.columns.map((c) => c.label).join("\t");
    shell.selection({
      chip: { kind: "selection", label: `${plural(rows.length, "response")}, ${title}`, ref: chipRef, quote: [head, ...rows.map((r) => r.join("\t"))].join("\n") },
      rect: (el.querySelector("tr[data-picked]") ?? el).getBoundingClientRect(),
    });
    return () => shell.selection(null);
  }, [inBones, shell, picked, got, keys, chipRef, title]);
  const toggle = (key: string): void =>
    setPicked(() => {
      const next = new Set(picked);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const all = got.rows.length > 0 && picked.size === keys.length;
  return (
    <div data-form-responses={inBones ? undefined : ""} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
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
      <div data-responses-table className={`border-t border-border ${TABLE_FADE}`}>
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
                  <Checkbox aria-label={`Select ${responseName(r, timeColumn, i)}`} checked={picked.has(keys[i]!)} onCheckedChange={() => toggle(keys[i]!)} />
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

// ── loading ──────────────────────────────────────────────────────────

/** Four answers to three questions and the time: the Responses half's bones. */
const SAMPLE_RESPONSES: FormResponses = {
  rev: 0,
  columns: [
    { id: "sample:name", label: "Name" },
    { id: "sample:sport", label: "Sport" },
    { id: "sample:nights", label: "Nights" },
    { id: "submitted", label: "Submitted" },
  ],
  rows: [
    ["Marcus Lee", "Volleyball", "Tuesday, Thursday", "Mon 2:14 PM"],
    ["Priya Raman", "Basketball", "Wednesday", "Mon 1:52 PM"],
    ["Jordan Ellis", "Soccer", "Monday, Friday", "Mon 11:08 AM"],
    ["Ana Ortiz", "Volleyball", "Thursday", "Sun 9:30 PM"],
  ],
  count: 4,
  cut: false,
};

/** The Responses half while its read is out: the table itself, drawn from a sample at rest. */
export function ResponsesBones({ chipRef, shell }: Pick<ResponseTableProps, "chipRef" | "shell">) {
  return <ResponseTable title="" got={SAMPLE_RESPONSES} chart={null} chipRef={chipRef} shell={shell} timeColumn={3} whole="" />;
}

/** A form's first page, its title, its line and its first questions, while the form is read: both form kinds' bones. */
export function FormPageBones({ questions, mark }: { questions: number; mark: "data-form-loading" | "data-msform-loading" }) {
  return (
    <Bones label="Loading the form">
      <div {...{ [mark]: "" }} className="mx-auto w-full max-w-[560px] px-6 pt-6">
        <p className="px-3 text-lg leading-[26px] font-semibold tracking-[-0.01em]">Spring intramurals sign-up</p>
        <p className="mt-1 px-3 text-sm leading-[22px] text-muted-foreground">Pick your sport and the nights you can play.</p>
        <div className="mt-5 flex flex-col gap-5">
          {SAMPLE_QUESTIONS.slice(0, questions).map((label) => (
            <div key={label} className="flex flex-col gap-1.5 px-3">
              <span className="text-[13px] leading-5 font-medium">{label}</span>
              <Bone className="h-8 max-w-[360px] rounded-md" />
            </div>
          ))}
        </div>
      </div>
    </Bones>
  );
}

const SAMPLE_QUESTIONS = ["Your name", "Which sport?", "Nights you can play"];

/** A form bar's switch while the form is read, so the body never moves under it when the bar fills. */
export function HalfBones({ first, mark }: { first: "Questions" | "Form"; mark: "data-form-bar-bone" | "data-msform-bar-bone" }) {
  return (
    <Bones label="" className="mx-1 shrink-0">
      <Tabs value="first" {...{ [mark]: "" }} className="gap-0">
        <TabsList aria-label="Form view" className="relative p-0.5 group-data-[orientation=horizontal]/tabs:h-6">
          <TabsIndicator />
          <TabsTrigger value="first" className={`${TABS_PILL_TRIGGER} ${HALF_TAB}`}>
            {first}
          </TabsTrigger>
          <TabsTrigger value="responses" className={`${TABS_PILL_TRIGGER} ${HALF_TAB}`}>
            Responses
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </Bones>
  );
}
