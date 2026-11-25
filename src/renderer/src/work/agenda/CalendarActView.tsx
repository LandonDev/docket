import type { ActViewProps } from "../acts/registry";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { cn } from "../../lib/cn";
import { useEffect } from "react";
import { BusyLabel, Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { addDays, startOfDay } from "work-kit/views/lib/agenda";
import { type LifeosSession, useLifeosQuery, useLifeosSession } from "../shell/lifeos";
import { downOf } from "../shell/lifeosDown";
import { DownLine, HostLine } from "../shell/DownLine";
import { useHostLive } from "../shell/lifeosLive";
import { useAgainKept, type AgainKept } from "../shell/againKept";
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

/** Where the read of the act's event stands: none for an act that names no event. */
type EventRead = "none" | "loading" | "failed" | "gone" | "ready";

/**
 * A reply or a change names its event: its title, time and place fill what the act leaves out. Retry reads it again,
 * its failed line kept with Retry spinning until the new read answers.
 */
function WithEvent({ id, ...props }: Props & { id: string }) {
  const again = useAgainKept();
  return <EventOf key={again.attempt} id={id} {...props} again={again} />;
}

function EventOf({ id, again, ...props }: Props & { id: string; again: AgainKept }) {
  const read = useLifeosQuery<DayEvent | null>(props.session, "events:get", { id });
  const { settle } = again;
  const loading = read.status === "loading";
  useEffect(() => void (loading || settle()), [loading, settle]);
  const value = read.status === "ready" ? read.value : null;
  // A Retry he pressed keeps the failed line, its Retry spinning, while the new read is out.
  const retrying = loading && again.retrying;
  const state: EventRead = read.status === "ready" ? (value ? "ready" : "gone") : retrying ? "failed" : read.status;
  return <Body {...props} event={value} read={state} onRetry={again.retry} retrying={retrying} />;
}

function Body({ op, event, session, sector, read = "none", onRetry, retrying = false }: Props & { event: DayEvent | null; read?: EventRead; onRetry?: () => void; retrying?: boolean }) {
  const start = opStart(op, event);
  const from = start === null ? null : startOfDay(start);
  const fields = opFields(op, event);
  // The facts only the event can give: while it is read, their bones; once the read failed or found nothing, a line says so.
  const missing = (["Event", "When"] as const).filter((label) => !fields.some((f) => f.label === label));
  // A session that cannot read fails every query at once, and a query's Retry asks the same session again: the
  // session's own line and press take both reads' places, once. The hold is untouched: this is what he reads.
  const down = downOf(session);
  // While the host says its LifeOS is still connecting, both reads wait on it: one named line in their place, no press.
  const live = useHostLive(session.environmentId);
  const waits = !down && !session.client && live.waits;
  const reads = (read !== "none" && missing.length > 0) || from !== null;
  return (
    <div data-slot="act-payload" className="flex min-w-0 flex-col gap-5">
      <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] leading-5">
        {read === "loading" && !waits
          ? missing.map((label) => (
              <div key={label} data-field-bones="" className="contents">
                <dt className="truncate text-muted-foreground">{label}</dt>
                <dd className="flex h-5 items-center">
                  <Skeleton className={cn("h-3", label === "Event" ? "w-40" : "w-32")} />
                </dd>
              </div>
            ))
          : null}
        {fields.map((field) => (
          <div key={field.label} className="contents">
            <dt className="truncate text-muted-foreground">{field.label}</dt>
            <dd className="min-w-0 break-words text-foreground">{field.people ? <People people={field.people} /> : field.value}</dd>
          </div>
        ))}
      </dl>
      {read === "loading" && missing.length && !waits ? <span role="status" className="sr-only">Reading the event</span> : null}
      {down && reads ? <DownLine session={session} /> : null}
      {waits && reads ? <HostLine live={live} /> : null}
      {!down && (read === "failed" || read === "gone") && missing.length ? (
        <p data-event-read={read} className="flex min-h-7 items-center gap-2 text-[13px] text-muted-foreground">
          {read === "failed" ? "Couldn't read the event" : "The event is no longer in LifeOS"}
          {read === "failed" && onRetry ? (
            <Button variant="ghost" size="xs" disabled={retrying} onClick={onRetry}>
              <BusyLabel busy={retrying} label="Retry" />
            </Button>
          ) : null}
        </p>
      ) : null}
      {from !== null && !down && !waits ? <DayRead op={op} event={event} session={session} sector={sector} from={from} /> : null}
    </div>
  );
}

/**
 * Guests as Mail's cards name a recipient: the name he knows, then the address it goes to, muted 4px after it. A guest
 * longer than the column wraps inside it, between name and address first and within the address if it must: he reads
 * every address before he sends.
 */
function People({ people }: { people: { address: string; name?: string }[] }) {
  return (
    <>
      {people.map((who, i) => {
        const name = who.name?.trim();
        const named = !!name && name !== who.address;
        return (
          <span key={who.address}>
            {i ? ", " : null}
            {named ? (
              <>
                <span className="me-1">{name}</span>
                <wbr />
              </>
            ) : null}
            <span className={cn("wrap-anywhere", named && "text-muted-foreground")}>{who.address}</span>
          </span>
        );
      })}
    </>
  );
}

/** The day's read, asked again from scratch by its Retry, its failed line kept with Retry spinning until it answers. */
function DayRead(props: Props & { event: DayEvent | null; from: number }) {
  const again = useAgainKept();
  return <Day key={again.attempt} {...props} again={again} />;
}

/**
 * That day, every sector's, in time order, under the act so the act never moves; while it loads, its bones, so the
 * clash check is seen to be on its way. A read that failed is one muted line in the day's place with Retry, so a
 * clash check that did not run never reads as a clear day. The day runs to the next local midnight, as Agenda's do
 * (`addDays`): 23 hours on the day the clocks go forward, 25 on the day they go back.
 */
function Day({ op, event, session, sector, from, again }: Props & { event: DayEvent | null; from: number; again: AgainKept }) {
  const day = useLifeosQuery<DayEvent[]>(session, "events:range", { from, to: addDays(from, 1) });
  const { settle } = again;
  const loading = day.status === "loading";
  useEffect(() => void (loading || settle()), [loading, settle]);
  const retrying = loading && again.retrying;
  if (day.status === "failed" || retrying)
    return (
      <p data-day-failed="" className="flex min-h-7 items-center gap-2 text-[13px] text-muted-foreground">
        Couldn't read that day
        <Button variant="ghost" size="xs" disabled={retrying} onClick={again.retry}>
          <BusyLabel busy={retrying} label="Retry" />
        </Button>
      </p>
    );
  if (day.status === "loading") return <DayBones />;
  const lines = dayLines(op, day.value, event, sector);
  // A day of this event alone says nothing the fields above do not: drawn only when something else is on it.
  if (!lines.some((line) => !line.own && line.key !== op.eventId)) return null;
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

/** The day's shape while LifeOS reads it: its heading and three rows on the rows' own grid. */
function DayBones() {
  return (
    <div role="status" aria-label="Reading that day" data-day-bones="" className="flex max-w-[440px] flex-col">
      <div className="mb-1 flex h-4 items-center">
        <Skeleton className="h-3 w-24" />
      </div>
      {["w-1/2", "w-2/3", "w-2/5"].map((w) => (
        <div key={w} className="grid h-8 grid-cols-[64px_16px_minmax(0,1fr)] items-center gap-x-2">
          <Skeleton className="h-3 w-12" />
          <span className="grid size-4 place-items-center">
            <Skeleton className="size-2 rounded-full" />
          </span>
          <Skeleton className={cn("h-3", w)} />
        </div>
      ))}
    </div>
  );
}
