import { ConvexProvider } from "convex/react";
import { memo, useMemo, useRef } from "react";
import type { ContextChip } from "@shared/work";
import type { AgendaClient, AgendaEvent } from "work-kit/views";
import { addDays, endOf, groupByDay, leaveAt, startOfDay } from "work-kit/views/lib/agenda";
import { formatDayHeading, formatLeave, formatTime } from "work-kit/views/lib/format";
import { Button } from "../../components/ui/button";
import { reveal } from "../../components/ui/reveal";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { viewsClients } from "../tasks/client";
import { useMinute } from "../tasks/minute";
import type { WorkViewProps } from "../views/registry";

/**
 * A Work workspace's Agenda (prototype workspace.html, "Four rows"): its
 * sector's next two weeks from LifeOS, by day, each event at its time with
 * where it is and when to leave. Prepare starts a thread about the event,
 * with the event in the composer as a chip; nothing runs until he sends.
 */

const DAYS = 14;

export function View({ env, sector, lifeos, startThread }: WorkViewProps) {
  const clients = useMemo(() => viewsClients(env, sector), [env, sector]);
  if (!lifeos.client) return <AgendaSkeleton />;
  return (
    <ConvexProvider client={lifeos.client}>
      <Agenda client={clients.agenda} startThread={startThread} />
    </ConvexProvider>
  );
}

function Agenda({ client, startThread }: { client: AgendaClient; startThread: (about: ContextChip) => void }) {
  const now = useMinute();
  const from = startOfDay(now);
  const to = addDays(from, DAYS);
  const events = client.useEvents(from, to);
  const latest = useRef(startThread);
  latest.current = startThread;
  const prepare = useMemo(() => (event: AgendaEvent) => latest.current({ kind: "event", label: event.title, ref: { at: "lifeos", table: "events", id: event._id } }), []);
  const days = useMemo(() => (events ? groupByDay(events, from, to) : null), [events, from, to]);
  if (!days) return <AgendaSkeleton />;
  if (!days.length) return <EmptyState title="Nothing scheduled" />;
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-6 py-6">
      {days.map(({ day, events: rows }) => (
        <section key={day} aria-label={formatDayHeading(day, now)} className="flex flex-col">
          <h2 className="mb-1 px-3 text-xs font-medium text-muted-foreground">{formatDayHeading(day, now)}</h2>
          {rows.map((event) => (
            <EventRow key={event._id} event={event} past={endOf(event) < now} leave={leaveAt(event, now)} onPrepare={prepare} />
          ))}
        </section>
      ))}
    </div>
  );
}

/** One event: its time (with when to leave under it while that is ahead), its title over where it is, Prepare on hover. */
const EventRow = memo(function EventRow({ event, past, leave, onPrepare }: { event: AgendaEvent; past: boolean; leave: number | undefined; onPrepare: (event: AgendaEvent) => void }) {
  return (
    <div role="listitem" className="group/row relative grid min-h-9 grid-cols-[72px_minmax(0,1fr)] items-baseline gap-x-2 rounded-md px-3 py-1.5 transition-colors duration-(--dur-hover) hover:bg-muted">
      <span className="flex flex-col text-xs leading-5 text-muted-foreground tabular-nums">
        <span>{event.allDay ? "All day" : formatTime(event.startsAt)}</span>
        {leave !== undefined && !past ? <span className="font-medium text-foreground">Leave {formatLeave(leave, event.startsAt)}</span> : null}
      </span>
      <span className="flex min-w-0 flex-col pr-20">
        <span className={cn("truncate text-[13px] leading-5", past ? "text-muted-foreground" : "text-foreground")}>{event.title}</span>
        {event.location ? <span className="truncate text-xs text-muted-foreground">{event.location}</span> : null}
      </span>
      {past ? null : (
        <span className={cn("absolute top-1.5 right-2", reveal("row", { row: true }))}>
          <Button size="xs" variant="ghost" onClick={() => onPrepare(event)}>
            Prepare
          </Button>
        </span>
      )}
    </div>
  );
});

function AgendaSkeleton() {
  return (
    <div aria-hidden className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-9 py-6">
      {[3, 2].map((n, i) => (
        <div key={i} className="flex flex-col gap-3">
          <Skeleton className="h-3 w-20" />
          {Array.from({ length: n }, (_, j) => (
            <div key={j} className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-2">
              <Skeleton className="h-3 w-12" />
              <Skeleton className={cn("h-3.5", j % 2 ? "w-1/3" : "w-1/2")} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
