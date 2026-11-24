import { useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { DISCLOSURE_CHEVRON } from "../../components/ui/disclosure";
import { StatusMark } from "../../components/ui/status";
import { Check, ChevronRight } from "../../chrome/icons";
import { cn } from "../../lib/cn";
import { ItemInPlace } from "./HeldDetail";
import { KindGlyph, rowWords } from "./parts";
import type { HostItem } from "./store";
import { itemKey, type RowResult } from "./waiting";

/**
 * The summary list (docs/DESIGN.md "The Outbox", "Ticks and the summary"):
 * one head sentence of everything a press does, then a row per item with its
 * tick, its kind's glyph, the act and what it is about, a side word, and a
 * chevron that opens the item in place (its sentence, its notes and the
 * thing itself, with no border around it). After the press each row shows
 * its own result as it lands, and the head says the sum.
 *
 * One part, drawn by the Outbox for his own ticks and by a thread's request
 * (its card and its detail): the caller owns the head's words, the ticks and
 * the verbs under it.
 */

export type SummaryRow = {
  item: HostItem;
  /** ticked: it is part of the press */
  on: boolean;
  /** a word at the row's end: "Open to send", "Changed since asked" */
  side?: string | null;
  /** its press's result, once pressed: the tick gives way to it */
  result?: RowResult;
  /** no tick of its own (it cannot be part of the press) */
  locked?: boolean;
};

export function SummaryList({
  head,
  facts,
  lead,
  rows,
  onToggle,
  host,
}: {
  /** One sentence of what the press does, or what it did. */
  head: string;
  /** A facts line over the head (a request's job, thread and time). */
  facts?: ReactNode;
  /** One line under the head (a request's "You asked: …"). */
  lead?: ReactNode;
  rows: readonly SummaryRow[];
  onToggle?: (item: HostItem, on: boolean) => void;
  /** The host's name, for an item's notes ("Takes the box's screen"). */
  host?: (item: HostItem) => string;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const flip = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <div data-outbox-summary className="flex flex-col">
      {facts}
      <h1 aria-live="polite" className={cn("text-base font-semibold leading-6 tracking-[-0.01em] text-balance", facts && "mt-1")}>
        {head}
      </h1>
      {lead ? <div className="mt-2 text-[13px] leading-5 text-muted-foreground">{lead}</div> : null}
      <ul className="mt-3 flex flex-col">
        {rows.map((row) => {
          const key = itemKey(row.item);
          const { act, about } = rowWords(row.item);
          const opened = open.has(key);
          const dim = !row.on && !row.result;
          return (
            <li key={key} data-summary-row={key} className="flex flex-col border-t border-border first:border-t-0">
              <div className="flex min-h-9 min-w-0 items-center gap-2 ps-0.5 text-[13px] leading-5">
                <span className="grid size-4 shrink-0 place-items-center">
                  <RowLead row={row} act={act} onToggle={onToggle} />
                </span>
                <span className="grid size-4 shrink-0 place-items-center">
                  <KindGlyph kind={row.item.kind} />
                </span>
                <span data-summary-act className={cn("min-w-0 shrink truncate", dim && "text-muted-foreground")}>{act}</span>
                {about ? <span data-summary-about className="min-w-0 flex-1 shrink-[100] truncate text-muted-foreground @max-[40rem]/outbox:hidden">{about}</span> : <span className="flex-1" />}
                <Side row={row} />
                <Button variant="ghost" size="icon-xs" aria-label={opened ? `Close ${act}` : `Open ${act}`} aria-expanded={opened} className="shrink-0 text-muted-foreground" onClick={() => flip(key)}>
                  <ChevronRight className={cn(DISCLOSURE_CHEVRON, opened && "rotate-90")} />
                </Button>
              </div>
              {opened ? (
                <div data-summary-open className="border-t border-border pt-2 pb-4 ps-12 @max-[40rem]/outbox:ps-6">
                  <ItemInPlace item={row.item} host={host?.(row.item)} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The row's first column: its tick, or once pressed the working mark, a check, or the red mark. */
function RowLead({ row, act, onToggle }: { row: SummaryRow; act: string; onToggle?: (item: HostItem, on: boolean) => void }) {
  if (row.result?.state === "working") return <StatusMark state="working" word={false} />;
  if (row.result?.state === "done") return <Check aria-label="Done" className="size-3.5 text-muted-foreground" />;
  if (row.result?.state === "failed") return <StatusMark state="failed" word={false} />;
  if (row.locked || !onToggle) return null;
  return <Checkbox aria-label={`Include ${act}`} checked={row.on} onCheckedChange={(on) => onToggle(row.item, on)} />;
}

/** The row's end: its result's words ("Queued in LifeOS", the reason it did not go in red), else its own side word. */
function Side({ row }: { row: SummaryRow }) {
  const result = row.result;
  const words = result && result.state !== "working" ? result.words : (row.side ?? null);
  if (!words) return null;
  return <span data-summary-side className={cn("max-w-[50%] shrink-0 truncate text-xs tabular-nums", result?.state === "failed" ? "text-destructive" : "text-muted-foreground")}>{words}</span>;
}
