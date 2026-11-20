import { ConvexProvider } from "convex/react";
import { memo, useEffect, useMemo, useRef } from "react";
import type { ContextChip } from "@shared/work";
import { AgendaMonth, AgendaWeek, type ViewsKit, ViewsKitProvider } from "work-kit/views";
import { addDays, endOf, formatPeriod, groupByDay, leaveAt, localeWeekStart, shiftPeriod, startOfDay, viewRange } from "work-kit/views/lib/agenda";
import { formatDayHeading, formatLeave, formatTime } from "work-kit/views/lib/format";
import { ChevronLeft, ChevronRight, Plus } from "../../chrome/icons";
import { ChoiceToggle } from "../../components/choice-toggle";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../../components/ui/context-menu";
import { Button } from "../../components/ui/button";
import { reveal } from "../../components/ui/reveal";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { type AgendaClient, type AgendaEvent, viewsClients } from "../tasks/client";
import { useMinute } from "../tasks/minute";
import { shared, useShared } from "../tasks/store";
import { NewEventDialog } from "./NewEventDialog";
import { playRunner } from "../routines/plays/runOn";
import { openWorkView, useWorkView } from "../../lib/workSwitch";
import { sessionWaits, useLifeosQuery } from "../shell/lifeos";
import { knownAttendees, type DirectoryPerson } from "../people/model";
import "./agenda.css";
import type { WorkViewProps } from "../views/registry";

/**
 * A Work workspace's Agenda (prototype workspace.html, "Four rows"): its
 * sector's calendar from LifeOS as a List (two weeks by day, each event at
 * its time with where it is and when to leave), a Week or a Month, the
 * latter two LifeOS's own (work-kit's views). Prepare starts a thread about
 * an event, with the event in the composer as a chip; nothing runs until he
 * sends. New event is a calendar act LifeOS holds until he presses Add.
 */

const DAYS = 14;
type AgendaView = "list" | "week" | "month";
const VIEWS = [
  { value: "list", label: "List" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
] as const;
const weekStart = localeWeekStart();

/** What the header and the body share: the view, the day it is on, and the New event dialog (null: closed; a slot's start or `now`). */
const state = shared<{ view: AgendaView; day: number; adding: number | "now" | null }>({ view: "list", day: startOfDay(Date.now()), adding: null });
const go = (patch: Partial<ReturnType<typeof state.get>>) => state.set({ ...state.get(), ...patch });

/** "Nov 2026": the month a narrow Month view is on. */
export function shortMonth(day: number): string {
  return new Date(day).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/** "Nov 17 – 23", or "Nov 30 – Dec 6" across months: the week a narrow Week view is on. */
export function shortWeek(day: number, start = weekStart): string {
  const { from, to } = viewRange("week", day, start);
  const first = new Date(from);
  const last = new Date(addDays(to, -1));
  const monthDay = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return first.getMonth() === last.getMonth() ? `${monthDay(first)} – ${last.getDate()}` : `${monthDay(first)} – ${monthDay(last)}`;
}

export function Head(_props: WorkViewProps) {
  const { view, day } = useShared(state);
  return (
    <>
      {view !== "list" ? (
        <>
          <span className="hidden truncate text-[13px] text-muted-foreground tabular-nums @min-[40rem]/viewhead:inline">{formatPeriod(view, day, weekStart)}</span>
          {/* Narrow, the grids show weekdays and dates alone: the period stays here, short, so Previous and Next never lose the date. */}
          <span data-agenda-short-period className="truncate text-[13px] text-muted-foreground tabular-nums @min-[40rem]/viewhead:hidden">
            {view === "month" ? shortMonth(day) : shortWeek(day)}
          </span>
          <Button variant="ghost" size="sm" onClick={() => go({ day: startOfDay(Date.now()) })}>
            Today
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Previous ${view}`} onClick={() => go({ day: shiftPeriod(view, day, -1) })}>
            <ChevronLeft />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Next ${view}`} onClick={() => go({ day: shiftPeriod(view, day, 1) })}>
            <ChevronRight />
          </Button>
        </>
      ) : null}
      <ChoiceToggle label="Show as" value={view} options={VIEWS} onChange={(next) => go({ view: next })} />
      <Button variant="ghost" size="sm" aria-label="New event" className="@max-[40rem]/viewhead:px-1.5" onClick={() => go({ adding: "now" })}>
        <Plus />
        <span className="@max-[40rem]/viewhead:hidden">New event</span>
      </Button>
    </>
  );
}

/**
 * The event an invitation named: once LifeOS answers with it, the Week it falls in, whatever month that is. A read that
 * fails, or an event gone, leaves the view as it is. Either way the ask is cleared, so the view's own presses lead after.
 */
function OpenEvent({ workspaceId, id, lifeos }: { workspaceId: string; id: string; lifeos: WorkViewProps["lifeos"] }) {
  const read = useLifeosQuery<{ startsAt: number } | null>(lifeos, "events:get", { id });
  useEffect(() => {
    if (read.status === "loading") return;
    if (read.status === "ready" && read.value) go({ view: "week", day: startOfDay(read.value.startsAt), adding: null });
    openWorkView({ workspaceId, view: "agenda" });
  }, [read, workspaceId]);
  return null;
}

export function View({ env, workspace, sector, lifeos, startThread }: WorkViewProps) {
  const clients = useMemo(() => viewsClients(env, workspace.id, sector), [env, workspace.id, sector]);
  const { adding } = useShared(state);
  // An invitation's Open in Agenda names its event (`openWorkView {event}`): taken once, then cleared.
  const wanted = useWorkView();
  const event = wanted?.workspaceId === workspace.id && wanted.view === "agenda" ? wanted.event : undefined;
  // The sector's people, so an attendee who is one is named on the row and opens their page.
  const directory = useLifeosQuery<DirectoryPerson[]>(lifeos, "people:directory", { sector });
  const people = directory.status === "ready" ? directory.value : NO_PEOPLE;
  // Each visit opens on today's list.
  useEffect(() => () => state.set({ view: "list", day: startOfDay(Date.now()), adding: null }), []);
  // Bones only while the session is on its way; a failed one is the frame's line, with nothing pulsing under it.
  if (!lifeos.client) return sessionWaits(lifeos) ? <AgendaSkeleton /> : null;
  return (
    <ConvexProvider client={lifeos.client}>
      {event ? <OpenEvent workspaceId={workspace.id} id={event} lifeos={lifeos} /> : null}
      {/* While the event is read, its bones: today's list never paints before the event's week. */}
      {event ? <AgendaSkeleton /> : <Agenda client={clients.agenda} startThread={startThread} people={people} workspaceId={workspace.id} />}
      {adding !== null ? <NewEventDialog sector={sector} startsAt={adding === "now" ? null : adding} onClose={() => go({ adding: null })} /> : null}
    </ConvexProvider>
  );
}

/** What the shared week and month draw with in TempCode: no sector dot (a workspace's view is one sector, and a dot means sectors mix), no faces, no copy reference. */
const kit: ViewsKit = {
  SectorMark: () => null,
  Face: () => null,
  openTask: () => {},
};

const NO_PEOPLE: DirectoryPerson[] = [];

function Agenda({ client, startThread, people = NO_PEOPLE, workspaceId }: { client: AgendaClient; startThread: (about: ContextChip) => void; people?: readonly DirectoryPerson[]; workspaceId?: string }) {
  const { view, day } = useShared(state);
  const now = useMinute();
  const range = view === "list" ? { from: day, to: addDays(day, DAYS) } : viewRange(view, day, weekStart);
  const { from, to } = range;
  const events = client.useEvents(from, to);
  const latest = useRef(startThread);
  latest.current = startThread;
  const prepare = useMemo(() => (event: AgendaEvent) => latest.current(eventChip(event)), []);
  const days = useMemo(() => (events && view === "list" ? groupByDay(events, from, to) : null), [events, view, from, to]);
  if (!events) return <AgendaSkeleton />;
  // An event or a day picked in the week or month opens that day's list, where Prepare is.
  const toDay = (ms: number) => go({ view: "list", day: startOfDay(ms) });
  if (view !== "list")
    return (
      <ViewsKitProvider kit={kit}>
        <div className="wk-calendar h-full px-6 pt-2 pb-6">
          {view === "week" ? (
            <AgendaWeek events={events} day={day} weekStart={weekStart} onOpen={(e) => toDay(e.startsAt)} onCreate={(at) => go({ adding: at ?? "now" })} />
          ) : (
            <AgendaMonth events={events} day={day} weekStart={weekStart} onOpen={(e) => toDay(e.startsAt)} onPickDay={toDay} />
          )}
        </div>
      </ViewsKitProvider>
    );
  if (!days?.length) return <EmptyState title="Nothing scheduled" />;
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-6 py-6">
      {days.map(({ day, events: rows }) => (
        <section key={day} aria-label={formatDayHeading(day, now)} className="flex flex-col">
          <h2 className="mb-1 px-3 text-xs font-medium text-muted-foreground">{formatDayHeading(day, now)}</h2>
          {rows.map((event) => (
            <EventRow key={event._id} event={event} past={endOf(event) < now} leave={leaveAt(event, now)} onPrepare={prepare} people={people} workspaceId={workspaceId} />
          ))}
        </section>
      ))}
    </div>
  );
}

const eventChip = (event: AgendaEvent): ContextChip => ({ kind: "event", label: event.title, ref: { at: "lifeos", table: "events", id: event._id } });

/** One event: its time (with when to leave under it while that is ahead), its title over where it is, Prepare on hover; its right-click, Prepare and Run a play…. */
const EventRow = memo(function EventRow({ event, past, leave, onPrepare, people, workspaceId }: { event: AgendaEvent; past: boolean; leave: number | undefined; onPrepare: (event: AgendaEvent) => void; people: readonly DirectoryPerson[]; workspaceId: string | undefined }) {
  // LifeOS's event carries its attendees; the shared type does not name them.
  const met = knownAttendees((event as AgendaEvent & { attendees?: { address: string }[] }).attendees, people);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div role="listitem" className="group/row relative grid min-h-9 grid-cols-[72px_minmax(0,1fr)] items-baseline gap-x-2 rounded-md px-3 py-1.5 transition-colors duration-(--dur-hover) hover:bg-foreground/5" />}
      >
        <span className="flex flex-col text-xs leading-5 text-muted-foreground tabular-nums">
          <span>{event.allDay ? "All day" : formatTime(event.startsAt)}</span>
          {leave !== undefined && !past ? <span className="font-medium text-foreground">Leave {formatLeave(leave, event.startsAt)}</span> : null}
        </span>
        <span className="flex min-w-0 flex-col pr-20">
          <span className={cn("truncate text-[13px] leading-5", past ? "text-muted-foreground" : "text-foreground")}>{event.title}</span>
          {event.location ? <span className="truncate text-xs text-muted-foreground">{event.location}</span> : null}
          {met.length && workspaceId ? <With people={met} workspaceId={workspaceId} /> : null}
        </span>
        {past ? null : (
          <span className={cn("absolute top-1.5 right-2", reveal("row", { row: true }))}>
            <Button size="xs" variant="ghost" onClick={() => onPrepare(event)}>
              Prepare
            </Button>
          </span>
        )}
      </ContextMenuTrigger>
      <EventMenu event={event} onPrepare={onPrepare} />
    </ContextMenu>
  );
});

function EventMenu({ event, onPrepare }: { event: AgendaEvent; onPrepare: (event: AgendaEvent) => void }) {
  const runPlay = playRunner();
  return (
    <ContextMenuContent>
      <ContextMenuItem onClick={() => onPrepare(event)}>Prepare</ContextMenuItem>
      {runPlay ? <ContextMenuItem onClick={() => runPlay(eventChip(event))}>Run a play…</ContextMenuItem> : null}
    </ContextMenuContent>
  );
}

/** Who of the sector's people is at an event, as one comma sentence of names; a name opens their page. */
function With({ people, workspaceId }: { people: readonly DirectoryPerson[]; workspaceId: string }) {
  const shown = people.slice(0, 3);
  const more = people.length - shown.length;
  return (
    <span className="truncate text-xs text-muted-foreground">
      With{" "}
      {shown.map((p, i) => (
        <span key={p._id}>
          <button type="button" className="relative cursor-pointer rounded-sm hover:text-foreground hover:underline hover:underline-offset-2" onClick={() => openWorkView({ workspaceId, view: "people", person: p._id })}>
            {p.name}
          </button>
          {i < shown.length - 1 ? ", " : more ? `, and ${more} more` : null}
        </span>
      ))}
    </span>
  );
}

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
