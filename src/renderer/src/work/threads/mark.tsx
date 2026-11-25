import type { OutcomeTone } from "@shared/work/threadRecord";
import { Outbox } from "../../chrome/icons";
import { StatusMark, type ThreadState } from "../../components/ui/status";

/**
 * A Work thread's mark by what it left him (`SessionMeta.workOutcome`, docs/DESIGN.md "Held is not Needs you"): amber
 * when it asks him, red when it failed, the Outbox's glyph muted for something held, the spinner while it works. A
 * file made or an act done draws none: its words say it. The tracker's Threads cell, a job's Projects list and a
 * project's Log draw this one mark.
 */
const STATE_OF: Partial<Record<OutcomeTone, ThreadState>> = { asks: "waiting", failed: "failed", working: "working" };

export function OutcomeMark({ tone }: { tone: OutcomeTone | null | undefined }) {
  if (tone === "held") return <Outbox aria-hidden data-outcome="held" className="size-3.5 text-muted-foreground" />;
  const state = tone ? STATE_OF[tone] : undefined;
  return state ? <StatusMark state={state} word={false} /> : null;
}

/** Whether a tone draws a mark at all. */
export const hasOutcomeMark = (tone: OutcomeTone | null | undefined): boolean => tone === "held" || (!!tone && !!STATE_OF[tone]);
