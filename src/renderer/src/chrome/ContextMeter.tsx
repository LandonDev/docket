import { useState } from "react";
import { COMPACTING_WORDS } from "@shared/statusWords";
import { BusyLabel, Button } from "../components/ui/button";
import { cn } from "../lib/cn";
import { useContextReading } from "../lib/contextCache";
import { contextPercent, contextRatio, contextTone, formatTokens, type ContextUsage } from "../lib/contextUsage";
import { SwapIcon } from "../motion/IconSwap";
import { menuChunk } from "../surfaces/chunks";
import { ROW_CONTROL } from "./composerRow";
import type { ContextBreakdown } from "./ContextBreakdown";
import { LazyPopover, type FocusTarget } from "./menuRows";

const SIZE = 14;
const STROKE = 2;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Rows a memory or MCP list shows before "+N more". */
/**
 * The composer's context meter (docs/LAYOUT.md "Composer"): how full the
 * thread's context window is, as a 14px ring and the percent, muted until
 * 85% and amber from there (`contextTone`), a spinner while the harness
 * compacts. Drawn only once the harness has reported both halves: Cursor's
 * stream carries no usage, and a ring guessing at a number is worse than
 * none. A click opens the harness's breakdown (categories, memory files, MCP
 * tools) through the shared `session.context` cache, polled only while the
 * popover is open and the turn has settled, and Compact when the thread can.
 */
export function ContextMeter({
  sessionId,
  usage,
  busy = false,
  compacting = false,
  compactable = false,
  onCompact,
  finalFocus,
}: {
  sessionId: string;
  usage?: ContextUsage;
  busy?: boolean;
  compacting?: boolean;
  /** `canCompact` (lib/threadMenu.ts): no turn in flight. */
  compactable?: boolean;
  onCompact?: () => void;
  /** Where the focus goes when the popover closes: the composer's field. */
  finalFocus?: FocusTarget;
}) {
  const [open, setOpen] = useState(false);
  const reading = useContextReading(sessionId, open && !busy);
  const ratio = contextRatio(usage);
  if (!usage?.window || ratio === null) return null;
  const percent = contextPercent(usage);
  const tone = contextTone(ratio);
  const warn = tone === "text-warning";
  const trigger = (
    <Button
      variant="ghost"
      size="xs"
      aria-label={`Context ${percent}% full`}
      data-context-meter
      data-tone={warn ? "warning" : "muted"}
      className={cn(
        ROW_CONTROL,
        "shrink-0 gap-1",
        tone,
        warn && "hover:text-warning aria-expanded:text-warning",
      )}
    >
      {/* Ring and spinner cross over in one 14px box, as every glyph that changes state does. */}
      <span className="grid size-3.5 shrink-0 place-items-center">
        <SwapIcon state={compacting ? "compacting" : "ring"}>
          {compacting ? <span role="status" aria-label={COMPACTING_WORDS}><BusyLabel busy label="" /></span> : <ContextRing ratio={ratio} />}
        </SwapIcon>
      </span>
      <span className="tabular-nums @max-[25rem]/composer-bar:hidden">{percent}%</span>
    </Button>
  );
  const compact =
    compactable && onCompact
      ? () => {
          setOpen(false);
          onCompact();
        }
      : undefined;
  return (
    <LazyPopover
      trigger={trigger}
      open={open}
      onOpenChange={setOpen}
      tip={{ label: compacting ? COMPACTING_WORDS : `${formatTokens(usage.used)} of ${formatTokens(usage.window)} tokens` }}
      side="top"
      align="end"
      label="Context"
      finalFocus={finalFocus}
      className="w-80 gap-0 p-3"
    >
      <Breakdown reading={reading} usage={usage} busy={busy} compacting={compacting} onCompact={compact} />
    </LazyPopover>
  );
}

/** The 14px ring: a 25% track and the filled arc, both in the current colour. */
export function ContextRing({ ratio, className }: { ratio: number; className?: string }) {
  const fill = Math.max(0, Math.min(1, ratio));
  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      aria-hidden
      data-context-ring
      className={cn("shrink-0", className)}
    >
      <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="currentColor" strokeWidth={STROKE} opacity={0.25} />
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - fill)}
        transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
      />
    </svg>
  );
}

/** The popover's body (chrome/ContextBreakdown.tsx) rides the menu chunk with the popover that draws it: it is
 *  rendered only while that popover is open, so the chunk is in by then and the first paint carries neither. */
function Breakdown(props: Parameters<typeof ContextBreakdown>[0]) {
  const Body = menuChunk.loaded();
  return Body ? <Body.ContextBreakdown {...props} /> : null;
}
