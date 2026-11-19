import type { ActViewProps } from "../acts/registry";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { cn } from "../../lib/cn";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { type LifeosSession, useLifeosQuery, useLifeosSession } from "../shell/lifeos";
import { dayLines, opFields, opStart, type CalendarOp, type DayEvent } from "./calendarAct";

/**
 * A held calendar act in the Outbox (prototype outbox.html, a held invite):
 * what it does as he reads it, then that day's calendar, every sector's, with
 * the act's own slot set apart, so a clash shows before he presses Send. The
 * day is read as him (the Outbox is his), not through a sector's session.
 */
export function View({ item, env }: ActViewProps) {
  const op = item.payload as CalendarOp;
  const session = useLifeosSession(env, null);
  return op.eventId ? <WithEvent op={op} id={op.eventId} session={session} sector={item.sector ?? null} /> : <Body op={op} event={null} session={session} sector={item.sector ?? null} />;
}

type Props = { op: CalendarOp; session: LifeosSession; sector: string | null };

/** A reply or a change names its event: its title, time and place fill what the act leaves out. */
function WithEvent({ id, ...props }: Props & { id: string }) {
  const read = useLifeosQuery<DayEvent | null>(props.session, "events:get", { id });
  return <Body {...props} event={read.status === "ready" ? read.value : null} />;
}

function Body({ op, event, session, sector }: Props & { event: DayEvent | null }) {
  const start = opStart(op, event);
  const from = start === null ? null : new Date(start).setHours(0, 0, 0, 0);
  return (
    <div data-slot="act-payload" className="flex min-w-0 flex-col gap-5">
      <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] leading-5">
        {opFields(op, event).map((field) => (
          <div key={field.label} className="contents">
            <dt className="truncate text-muted-foreground">{field.label}</dt>
            <dd className="min-w-0 break-words text-foreground">{field.value}</dd>
          </div>
        ))}
      </dl>
      {from !== null ? <DayRead op={op} event={event} session={session} sector={sector} from={from} /> : null}
    </div>
  );
}

/** The day's read, asked again from scratch by its Retry. */
function DayRead(props: Props & { event: DayEvent | null; from: number }) {
  const [attempt, setAttempt] = useState(0);
  return <Day key={attempt} {...props} onRetry={() => setAttempt((n) => n + 1)} />;
}

/**
 * That day, every sector's, in time order; nothing until it has loaded, so the
 * act above never moves. A read that failed is one muted line in the day's
 * place with Retry, so a clash check that did not run never reads as a clear day.
 */
function Day({ op, event, session, sector, from, onRetry }: Props & { event: DayEvent | null; from: number; onRetry: () => void }) {
  const day = useLifeosQuery<DayEvent[]>(session, "events:range", { from, to: from + 86_400_000 });
  if (day.status === "failed")
    return (
      <p data-day-failed="" className="flex min-h-7 items-center gap-2 text-[13px] text-muted-foreground">
        Couldn't read that day
        <Button variant="ghost" size="xs" onClick={onRetry}>
          Retry
        </Button>
      </p>
    );
  const lines = day.status === "ready" ? dayLines(op, day.value, event, sector) : null;
  if (!lines?.length) return null;
  return (
    <section aria-label="That day" className="flex max-w-[440px] flex-col">
      <h3 className="mb-1 text-xs font-medium text-muted-foreground">{new Date(from).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</h3>
      {lines.map((line) => (
        <div key={line.key} className="grid h-8 grid-cols-[64px_16px_minmax(0,1fr)] items-center gap-x-2 border-border text-[13px] not-first-of-type:border-t">
          <time className="text-xs text-muted-foreground tabular-nums">{line.at}</time>
          <SectorDot sector={line.sector} />
          <span className={cn("truncate", line.own ? "font-medium text-foreground" : "text-muted-foreground")}>{line.title}</span>
        </div>
      ))}
    </section>
  );
}
