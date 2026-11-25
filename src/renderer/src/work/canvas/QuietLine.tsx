import { useState, type ReactNode } from "react";
import { useTruncated } from "../../components/tip";
import { BusyLabel, Button } from "../../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";

/** A state line's detail: cut, it is a Tab stop with its whole words in a tooltip, on hover and on focus alike. */
export function CutDetail({ text, className = "" }: { text: string; className?: string }) {
  const { ref, cut } = useTruncated(text);
  const span = (
    <span ref={ref} tabIndex={cut ? 0 : undefined} className={`focus-ring block min-w-0 truncate rounded-sm ${className}`}>
      {text}
    </span>
  );
  if (!cut) return span;
  return (
    <Tooltip>
      <TooltipTrigger render={span} />
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

/**
 * One muted line across an item that says how it is, not that he is needed (docs/DESIGN.md "The canvas pane"):
 * "Read only" with its reason and its one press, on a sheet as on a deck. Amber is kept for a line that needs him.
 * `data-quiet-line` names it to the tests; a caller may add its own mark.
 */
export function QuietLine({
  word,
  detail,
  press,
  end,
  ...marks
}: {
  word: string | null;
  detail?: string | null | undefined;
  press?: { label: string; run(): void | Promise<void> } | null | undefined;
  /** what the line holds at its far end: a read-only deck's Present, so the item has one row above it, not two */
  end?: ReactNode;
} & Record<`data-${string}`, true | string | undefined>) {
  const [busy, setBusy] = useState(false);
  const run = () => {
    if (!press || busy) return;
    setBusy(true);
    void Promise.resolve(press.run()).finally(() => setBusy(false));
  };
  return (
    <div data-quiet-line role="status" {...marks} className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-xs text-muted-foreground">
      {word || detail ? (
        <span className="flex min-w-0 items-baseline gap-1">
          {word ? <span className="shrink-0 font-medium">{word}</span> : null}
          {detail ? <CutDetail text={detail} /> : null}
        </span>
      ) : null}
      {press ? (
        <Button variant="link" size="xs" className="h-auto shrink-0 px-0 text-xs" disabled={busy} onClick={run}>
          <BusyLabel busy={busy} label={press.label} />
        </Button>
      ) : null}
      {end ? <span className="ms-auto flex shrink-0 items-center">{end}</span> : null}
    </div>
  );
}
