import { ConvexProvider } from "convex/react";
import { memo, useEffect, useLayoutEffect, useMemo, type KeyboardEvent } from "react";
import { useKeptRows, WindowedRows, type RowPlace } from "../windowed";
import type { ContextChip } from "@shared/work";
import { AgendaMonth, AgendaWeek, type ViewsKit, ViewsKitProvider } from "work-kit/views";
import { addDays, endOf, formatPeriod, groupByDay, leaveAt, localeWeekStart, shiftPeriod, startOfDay, viewRange } from "work-kit/views/lib/agenda";
import { formatDayHeading, formatTime } from "work-kit/views/lib/format";
import { ChevronLeft, ChevronRight, Plus } from "../../chrome/icons";
import { ChoiceSelect } from "../../components/choice-select";
import { ChoiceToggle } from "../../components/choice-toggle";
import { Tip, useTruncated } from "../../components/tip";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { Calendar } from "../icons";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../../components/ui/context-menu";
import { Button } from "../../components/ui/button";
import { ItemButton } from "../../components/ui/item";
import { ROW_HOLDS, ROW_OPEN, ROW_SHOWS } from "../../components/ui/press";
import { reveal } from "../../components/ui/reveal";
import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { moveBetweenRows } from "../rowKeys";
import { clockTime } from "../../lib/duration";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { type AgendaClient, type AgendaEvent, viewsClients } from "../tasks/client";
import { useMinute } from "../tasks/minute";
import { useShared } from "../tasks/store";
import { agendaPlace, keepAgendaPlace, resetAgendaPlace, restoreAgendaPlace, type AgendaShow } from "./place";
import { rowOfView } from "../views/registry";
import { prepEndOf } from "@shared/contract-work-prep";
import { NewEventDialog } from "./NewEventDialog";
import { playRunner } from "../routines/plays/runOn";
import { openWorkView, useWorkView, workViewNow } from "../../lib/workSwitch";
import { sessionWaits, useLifeosQuery } from "../shell/lifeos";
import { downOf, useKeptOpen } from "../shell/lifeosDown";
import { knownAttendees, type DirectoryPerson } from "../people/model";
import { clashTime, type Clash } from "@shared/work/clashes";
import { ClashLines, useClashes } from "../clashes/mark";
import { openClash } from "../clashes/open";
import { liveClashes } from "../clashes/model";
import { useJobName } from "../jobName";
import "./agenda.css";
import type { WorkViewProps } from "../views/registry";

/**
 * A Work workspace's Agenda (prototype workspace.html, "Four rows"): its
 * sector's calendar from LifeOS as a List (two weeks by day, each event at
 * its time with where it is and when to leave), a Week or a Month, the
 * latter two LifeOS's own (work-kit's views). Prepare opens the meeting's
 * page (work/prep), which reads its facts and starts nothing; once the event
 * is over the same verb reads Follow up. New event is a calendar act LifeOS holds until he presses Add. An
 * event that clashes with another, in any job, says so on its own row
 * (work/clashes), and its Leave is from where he will be.
 */

const DAYS = 14;
const VIEWS = [
  { value: "list", label: "List" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
] as const;
const weekStart = localeWeekStart();

/** What the header and the body share: the view, the day it is on, and the New event dialog (null: closed; a slot's start or `now`). */
const state = agendaPlace;
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

/** Whether `day`'s period (its week or month) holds today: off it, the compact header keeps a press back. */
export function holdsToday(view: "week" | "month", day: number, now = Date.now(), start = weekStart): boolean {
  const { from, to } = viewRange(view, day, start);
  return now >= from && now < to;
}

/**
 * The view's name in the header. Narrow, a Week or a Month needs every pixel for its period and its presses: under 26rem
 * the name gives way whole (still read aloud, still the heading's focus), never cut to "Age…", since the column names it.
 */
export function Title(_props: WorkViewProps) {
  const { view } = useShared(state);
  return <span className={cn("truncate font-medium text-foreground", view !== "list" && "@max-[26rem]/viewhead:sr-only")}>Agenda</span>;
}

export function Head({ workspace, lifeos }: WorkViewProps) {
  // The header mounts before the view's chunk lands: the visit's place is the workspace's from its first frame.
  useLayoutEffect(() => restoreAgendaPlace(workspace.id), [workspace.id]);
  const { view, day } = useShared(state);
  // The body's minute tick: a header left open across its period's end offers the way back within the minute.
  const now = useMinute();
  return (
    <>
      {view !== "list" ? (
        <>
          <span className="hidden truncate text-[13px] text-muted-foreground tabular-nums @min-[40rem]/viewhead:inline">{formatPeriod(view, day, weekStart)}</span>
          {/* Narrow, the grids show weekdays and dates alone: the period stays here, short and whole (the view's name gives way
              before it, since the column already names the view), so Previous and Next never lose the date. */}
          <span data-agenda-short-period className="shrink-0 text-[13px] whitespace-nowrap text-muted-foreground tabular-nums @min-[40rem]/viewhead:hidden">
            {view === "month" ? shortMonth(day) : shortWeek(day)}
          </span>
          {/* Today only off today's period: on it the press would do nothing. Under 26rem of header the word gives way to an
              icon press with its tip, so the short period keeps its room and the way back is still one press. The presses
              after it hold their place, since the header's controls sit at its end. */}
          {holdsToday(view, day, now) ? null : (
            <>
              <Button variant="ghost" size="sm" data-agenda-today="word" className="@max-[26rem]/viewhead:hidden" onClick={() => go({ day: startOfDay(Date.now()) })}>
                Today
              </Button>
              <Tip label="Today">
                <Button variant="ghost" size="icon-sm" aria-label="Today" data-agenda-today="icon" className="@min-[26rem]/viewhead:hidden" onClick={() => go({ day: startOfDay(Date.now()) })}>
                  <Calendar />
                </Button>
              </Tip>
            </>
          )}
          <Tip label={`Previous ${view}`}>
            <Button variant="ghost" size="icon-sm" aria-label={`Previous ${view}`} onClick={() => go({ day: shiftPeriod(view, day, -1) })}>
              <ChevronLeft />
            </Button>
          </Tip>
          <Tip label={`Next ${view}`}>
            <Button variant="ghost" size="icon-sm" aria-label={`Next ${view}`} onClick={() => go({ day: shiftPeriod(view, day, 1) })}>
              <ChevronRight />
            </Button>
          </Tip>
        </>
      ) : null}
      {/* The three views side by side where they fit; under 40rem, the same choice as one select. */}
      <span data-agenda-views="toggle" className="hidden @min-[40rem]/viewhead:flex">
        <ChoiceToggle label="Show as" value={view} options={VIEWS} onChange={(next) => go({ view: next })} />
      </span>
      <span data-agenda-views="select" className="flex @min-[40rem]/viewhead:hidden">
        <ChoiceSelect label="Show as" size="sm" value={view} options={VIEWS} onChange={(next) => go({ view: next })} />
      </span>
      {/* The dialog is the body's, which reads LifeOS: while the session is down there is none to open. Under 40rem of
          header the words give way to an icon press with its tip, as Today's do. */}
      {downOf(lifeos) ? null : (
        <>
          <Button variant="ghost" size="sm" data-agenda-new="word" className="@max-[40rem]/viewhead:hidden" onClick={() => go({ adding: "now" })}>
            <Plus />
            New event
          </Button>
          <Tip label="New event">
            <Button variant="ghost" size="icon-sm" aria-label="New event" data-agenda-new="icon" className="@min-[40rem]/viewhead:hidden" onClick={() => go({ adding: "now" })}>
              <Plus />
            </Button>
          </Tip>
        </>
      )}
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

const closeNewEvent = (): void => go({ adding: null });

/** Agenda's place is kept while the frame stays on Agenda or a view inside it (a meeting's page); else it starts over. */
const leaveAgenda = (workspaceId: string): void => {
  const next = workViewNow();
  if (next?.workspaceId === workspaceId && rowOfView(next.view) === "agenda") return;
  resetAgendaPlace();
};

/**
 * New event's dialog, the frame's (`Kept`), not the body's: a session that drops while it is open takes the week away,
 * never what he typed. The dialog says the session's line and holds Add until it is back; a press made while the session
 * was on its way, which then went down, is dropped (`useKeptOpen`).
 */
export function Kept({ workspace, sector, lifeos }: WorkViewProps) {
  const { adding } = useShared(state);
  useEffect(() => () => leaveAgenda(workspace.id), [workspace.id]);
  return useKeptOpen(adding !== null, lifeos, closeNewEvent) ? <NewEventDialog sector={sector} startsAt={adding === "now" ? null : adding} session={lifeos} onClose={closeNewEvent} /> : null;
}

export function View({ env, workspace, sector, lifeos }: WorkViewProps) {
  const clients = useMemo(() => viewsClients(env, workspace.id, sector), [env, workspace.id, sector]);
  const { view } = useShared(state);
  // An invitation's Open in Agenda names its event (`openWorkView {event}`): taken once, then cleared.
  const wanted = useWorkView();
  const event = wanted?.workspaceId === workspace.id && wanted.view === "agenda" ? wanted.event : undefined;
  // The sector's people, so an attendee who is one is named on the row and opens their page.
  const directory = useLifeosQuery<DirectoryPerson[]>(lifeos, "people:directory", { sector });
  const people = directory.status === "ready" ? directory.value : NO_PEOPLE;
  // Each visit opens where this workspace's last one stood, and keeps where it stands as he moves.
  useLayoutEffect(() => restoreAgendaPlace(workspace.id), [workspace.id]);
  useEffect(
    () =>
      state.subscribe(() => {
        const at = workViewNow();
        if (at?.workspaceId === workspace.id && at.view === "agenda") keepAgendaPlace(workspace.id);
      }),
    [workspace.id],
  );
  // A meeting's page stands inside Agenda: going there and back keeps the day and the view he was on. A body that goes
  // while the frame stays on Agenda (the session dropped) keeps them too, and New event's dialog with them (`Kept`).
  useEffect(() => () => leaveAgenda(workspace.id), [workspace.id]);
  // Bones only while the session is on its way; a failed one is the frame's line, with nothing pulsing under it.
  if (!lifeos.client) return sessionWaits(lifeos) ? <AgendaSkeleton view={view} /> : null;
  return (
    <ConvexProvider client={lifeos.client}>
      {event ? <OpenEvent workspaceId={workspace.id} id={event} lifeos={lifeos} /> : null}
      {/* While the event is read, its bones: today's list never paints before the event's week. */}
      {event ? <AgendaSkeleton view="week" /> : <Agenda client={clients.agenda} people={people} workspaceId={workspace.id} environmentId={env} />}
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
const idOfEvent = (event: AgendaEvent): string => event._id;
const NO_CLASHES: readonly Clash[] = [];

function Agenda({ client, people = NO_PEOPLE, workspaceId, environmentId }: { client: AgendaClient; people?: readonly DirectoryPerson[]; workspaceId?: string; environmentId: string }) {
  const { view, day } = useShared(state);
  const now = useMinute();
  const range = view === "list" ? { from: day, to: addDays(day, DAYS) } : viewRange(view, day, weekStart);
  const { from, to } = range;
  // A push answers every event again: each that holds what it held stays the same object, so its memoised row does not
  // draw (the perf pass's M12).
  // (The week and month of work-kit take a plain array; nothing here changes it.)
  const events = useKeptRows(client.useEvents(from, to) ?? null, idOfEvent) as AgendaEvent[] | null;
  // Every job's clashes over the same span, read as him: this view's own session reads one job.
  const marks = useClashes(environmentId, from, to);
  // When to leave is the rule's once it has answered (from the event before, when that is where he will be); LifeOS's own until then.
  // The dot in the Week and the Month is for what is still his to settle, as the list's line is: an event that is over wears none.
  // A clash is his to settle until its later event is over (clashes/model.ts `liveClashes`, which Today reads too). Over is by the end LifeOS gave the clash's side, which runs an event with no end for an hour, as the rule that found the clash does.
  const clashesOf = useMemo(() => liveClashes(marks.clashes, now), [marks.clashes, now]);
  const marked = useMemo(() => new Set((events ?? []).filter((e) => clashesOf.has(e._id)).map((e) => e._id)), [events, clashesOf]);
  const leaveOf = (event: AgendaEvent) => {
    if (!marks.ready) return leaveAt(event, now);
    return !event.allDay && event.startsAt > now ? marks.leaves.get(event._id)?.leaveAt : undefined;
  };
  // The meeting's page (work/prep): before the event it prepares, after it follows up. Opening it starts nothing.
  const prepare = useMemo(() => (event: AgendaEvent) => void (workspaceId && openWorkView({ workspaceId, view: "prep", event: event._id })), [workspaceId]);
  const days = useMemo(() => (events && view === "list" ? groupByDay(events, from, to) : null), [events, view, from, to]);
  if (!events) return <AgendaSkeleton view={view} />;
  // An event or a day picked in the week or month opens that day's list, where Prepare is.
  const toDay = (ms: number) => go({ view: "list", day: startOfDay(ms) });
  if (view !== "list")
    return (
      <ViewsKitProvider kit={kit}>
        <div className="wk-calendar h-full px-6 pt-2 pb-6">
          {view === "week" ? (
            <AgendaWeek events={events} day={day} weekStart={weekStart} onOpen={(e) => toDay(e.startsAt)} onCreate={(at) => go({ adding: at ?? "now" })} marked={marked} />
          ) : (
            <AgendaMonth events={events} day={day} weekStart={weekStart} onOpen={(e) => toDay(e.startsAt)} onPickDay={toDay} marked={marked} />
          )}
        </div>
      </ViewsKitProvider>
    );
  if (!days?.length) return <EmptyState title="Nothing scheduled" />;
  return (
    // ↑ and ↓ move between the events across the days, as Tasks' and People's rows do.
    <div onKeyDown={rowKeys} className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-6 py-6">
      {days.map(({ day, events: rows }) => (
        <section key={day} aria-label={formatDayHeading(day, now)} className="flex flex-col">
          <h2 className="mb-1 px-3 text-xs font-medium text-muted-foreground">{formatDayHeading(day, now)}</h2>
          {/* A day past 80 events mounts only the rows near the screen, each with its place in the day (work/windowed.tsx). */}
          <WindowedRows
            count={rows.length}
            rowHeight={36}
            getKey={(index) => `${day}:${rows[index]!._id}`}
            sizeKey="work-agenda-list"
            render={(index, place) => {
              const event = rows[index]!;
              return (
                <EventRow
                  key={event._id}
                  event={event}
                  past={endOf(event) < now}
                  over={prepEndOf(event) <= now}
                  leave={leaveOf(event)}
                  clashes={clashesOf.get(event._id)}
                  day={day}
                  onPrepare={prepare}
                  people={people}
                  workspaceId={workspaceId}
                  environmentId={environmentId}
                  place={place}
                />
              );
            }}
          />
        </section>
      ))}
    </div>
  );
}

/** The list's arrow keys: from anywhere in a row (a name, a clash line) to the open control of the event before or after. */
const rowKeys = (e: KeyboardEvent<HTMLElement>): void => void moveBetweenRows(e, '[role="listitem"]', "[data-row-open]");

const eventChip = (event: AgendaEvent): ContextChip => ({ kind: "event", label: event.title, ref: { at: "lifeos", table: "events", id: event._id } });

/**
 * One event: its time (with when to leave under it while that is ahead), its title over where it is and what it clashes
 * with. A press anywhere on the row opens the meeting's page (an `ItemButton` laid over it, as a Tasks row); the hover
 * verb (Prepare, or Follow up once it is over) says what the press does and is its pointer's shortcut, drawn over the
 * title's end, whose last 12px fade under it. The clash lines and the names keep their own presses, above the row's.
 * Its right-click: the same verb, Show clash and Run a play…. Exported for the clash line's preview.
 */
export const EventRow = memo(function EventRow({
  event,
  past,
  over,
  leave,
  clashes,
  day,
  onPrepare,
  people,
  workspaceId,
  environmentId,
  place,
}: {
  event: AgendaEvent;
  past: boolean;
  /** the meeting is over by its page's own rule (`prepEndOf`): the verb reads Follow up, as the page's header does; absent: as `past` */
  over?: boolean;
  leave: number | undefined;
  clashes: readonly Clash[] | undefined;
  /** the day this row sits under: an event that runs past midnight is listed under the next day too */
  day: number;
  onPrepare: (event: AgendaEvent) => void;
  people: readonly DirectoryPerson[];
  workspaceId: string | undefined;
  environmentId: string;
  /** Its place in a windowed day, for a screen reader. */
  place?: RowPlace;
}) {
  const done = over ?? past;
  // The list hands a row only the clashes still his to settle: both sides' ends are the clash's own.
  const clash = clashes;
  // LifeOS's event carries its attendees; the shared type does not name them.
  const met = knownAttendees((event as AgendaEvent & { attendees?: { address: string }[] }).attendees, people);
  const verb = done ? "Follow up" : "Prepare";
  // A title or place the column cuts is said whole on the row's hover and focus, only while one is cut (Today's rule).
  const words = useTruncated(`${event.title}\n${event.location ?? ""}`);
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div role="listitem" {...place} className={cn("group/row grid min-h-9 grid-cols-[88px_minmax(0,1fr)] items-baseline gap-x-2 rounded-md px-3 py-1.5", ROW_HOLDS)} />}>
        {/* The row's one press, under what it shows: keyboard focus rings the whole row, and ↑ ↓ move between these. */}
        <Tooltip disabled={!words.cut}>
          <TooltipTrigger render={<ItemButton data-row-open aria-label={`${verb} ${event.title}`} onClick={() => onPrepare(event)} className={ROW_OPEN} />} />
          <TooltipContent side="top" align="start">
            {event.title}
            {event.location ? <span className="block">{event.location}</span> : null}
          </TooltipContent>
        </Tooltip>
        <span className={cn("flex flex-col text-xs leading-5 text-muted-foreground tabular-nums", ROW_SHOWS)}>
          <span>{event.allDay ? "All day" : formatTime(event.startsAt)}</span>
          {/* A time keeps its AM or PM on its own line: the column is as wide as "Leave 12:45 PM". */}
          {leave !== undefined && !past ? <span className="font-medium whitespace-nowrap text-foreground">Leave {clockTime(leave)}</span> : null}
        </span>
        {/* What the row shows takes no pointer, so a press on it is the row's; its buttons (a clash line, a name) take their own. */}
        <span ref={words.ref} className={cn("flex min-w-0 flex-col [&_button]:pointer-events-auto", ROW_SHOWS)}>
          {/* The title runs the row's width at rest: no room is kept for a verb that shows only on hover. */}
          <span data-event-title className={cn("truncate text-[13px] leading-5", past ? "text-muted-foreground" : "text-foreground")}>{event.title}</span>
          {event.location ? <span className="truncate text-xs text-muted-foreground">{event.location}</span> : null}
          {clash?.length ? <ClashLines clashes={clash} eventId={event._id} environmentId={environmentId} day={day} /> : null}
          {met.length && workspaceId ? <With people={met} workspaceId={workspaceId} /> : null}
        </span>
        {/* Over the title's end on the row's own fill (the page under the row's hover tint), its first 12px fading the title out,
            as a rail row's actions do; its 24px press centred on the title's 20px line. Out of the Tab order: the row's own
            press, which holds focus, is the same act. */}
        <span
          data-event-verb
          className={cn(
            "absolute top-1 right-2 rounded-e-md bg-background [mask-image:linear-gradient(to_right,transparent,var(--foreground)_12px)]",
            reveal("row", { row: true, overlay: true }),
          )}
        >
          {/* The fade's 12px are the tinted span's own, so the title fades into the row's hover fill, never page white. */}
          <span className="flex rounded-e-md ps-3 group-hover/row:bg-foreground/5">
            <Button size="xs" variant="ghost" tabIndex={-1} aria-hidden onClick={() => onPrepare(event)}>
              {verb}
            </Button>
          </span>
        </span>
      </ContextMenuTrigger>
      <EventMenu event={event} over={done} onPrepare={onPrepare} clashes={clash} environmentId={environmentId} day={day} />
    </ContextMenu>
  );
});

function EventMenu({ event, over, onPrepare, clashes = NO_CLASHES, environmentId, day }: { event: AgendaEvent; over: boolean; onPrepare: (event: AgendaEvent) => void; clashes: readonly Clash[] | undefined; environmentId: string; /** the day the row sits under in its list */ day?: number | undefined }) {
  const runPlay = playRunner();
  const jobName = useJobName(environmentId);
  const other = (clash: Clash) => (clash.a.eventId === event._id ? clash.b : clash.a);
  // Two events of one name are told apart by job and time, the time as the row's line says it (with its weekday on another day).
  const named = (clash: Clash) => {
    const { title, sector } = other(clash);
    return clashes.some((c) => c !== clash && other(c).title === title) ? `${title} (${jobName(sector)}, ${clashTime(clash, event._id, day === undefined ? {} : { on: day })})` : title;
  };
  return (
    <ContextMenuContent>
      <ContextMenuItem onClick={() => onPrepare(event)}>{over ? "Follow up" : "Prepare"}</ContextMenuItem>
      {/* One clash is "Show clash"; several are each named by the other event, so every one can be opened from here. */}
      {clashes.map((clash) => (
        <ContextMenuItem key={clash.id} onClick={() => openClash({ id: clash.id, environmentId, clash })}>
          {clashes.length === 1 ? "Show clash" : `Show clash with ${named(clash)}`}
        </ContextMenuItem>
      ))}
      {runPlay ? <ContextMenuItem onClick={() => runPlay(eventChip(event))}>Run a play…</ContextMenuItem> : null}
    </ContextMenuContent>
  );
}

/** Who of the sector's people is at an event, as one comma sentence of names; a name opens their page. */
function With({ people, workspaceId }: { people: readonly DirectoryPerson[]; workspaceId: string }) {
  const shown = people.slice(0, 3);
  const more = people.length - shown.length;
  return (
    // 4px of padding each side, taken back by the margin, so the line keeps its 16px and a name's hit area reaches 24px
    // inside the box that cuts a long line.
    <span className="-my-1 truncate py-1 text-xs text-muted-foreground">
      With{" "}
      {shown.map((p, i) => (
        <span key={p._id}>
          <button
            type="button"
            className="relative cursor-pointer rounded-sm after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-[''] hover:text-foreground hover:underline hover:underline-offset-2"
            onClick={() => openWorkView({ workspaceId, view: "people", person: p._id })}
          >
            {p.name}
          </button>
          {i < shown.length - 1 ? ", " : more ? `, and ${more} more` : null}
        </span>
      ))}
    </span>
  );
}

/** The view's shape while its events are on their way: the list's rows, or the Week's or the Month's grid, by the view he kept. */
function AgendaSkeleton({ view = "list" }: { view?: AgendaShow }) {
  if (view !== "list") return <CalendarBones view={view} />;
  // On the list's own grid: a day's heading over rows of the rows' height (a time; a title over a shorter place line), so
  // nothing moves when the events land.
  return (
    <div aria-hidden data-agenda-bones="list" className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-6 py-6">
      {[3, 2].map((n, i) => (
        <div key={i} className="flex flex-col">
          <div className="mb-1 flex h-4 items-center px-3">
            <Skeleton className="h-3 w-20" />
          </div>
          {Array.from({ length: n }, (_, j) => (
            <div key={j} data-bone-row className="grid min-h-9 grid-cols-[88px_minmax(0,1fr)] gap-x-2 px-3 py-1.5">
              <div className="flex h-5 items-center">
                <Skeleton className="h-3 w-12" />
              </div>
              <div className="flex flex-col">
                <div className="flex h-5 items-center">
                  <Skeleton className={cn("h-3.5", j % 2 ? "w-1/3" : "w-1/2")} />
                </div>
                <div className="flex h-4 items-center">
                  <Skeleton className="h-3 w-1/4" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The Week's or the Month's bones: the weekdays over the grid's cells, on the grid's own inset. */
function CalendarBones({ view }: { view: "week" | "month" }) {
  const cells = view === "month" ? 42 : 7;
  return (
    <div aria-hidden data-agenda-bones={view} className="flex h-full min-h-[480px] flex-col px-6 pt-2 pb-6">
      <div className={cn("grid grid-cols-7 pb-3", view === "week" && "ps-14")}>
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="px-2">
            <Skeleton className="h-3 w-8" />
          </div>
        ))}
      </div>
      <div className={cn("grid min-h-0 flex-1 grid-cols-7 border-s border-t border-border", view === "month" ? "grid-rows-6" : "ms-14")}>
        {Array.from({ length: cells }, (_, i) => (
          <div key={i} className="border-e border-b border-border p-2">
            {view === "month" ? <Skeleton className="h-3 w-4" /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
