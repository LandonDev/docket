import { useMemo } from "react";
import type { ContextChip, SectorKey } from "@shared/work";
import { endOf, groupByDay, leaveAt, type LeaveSource } from "work-kit/views/lib/agenda";
import { clockTime } from "../../lib/duration";
import { knownAttendees, type DirectoryPerson } from "../people/model";
import { useLifeosQuery, type LifeosSession } from "../shell/lifeos";
import { startThreadAbout } from "../shell/WorkColumn";
import { useMinute } from "../tasks/minute";
import { answerOf, useLifeosRows } from "./lifeos";
import { dayAfter } from "./model";
import { goTo } from "./open";
import { useStableRows } from "./stable";
import type { TodayAnswer, TodayEnv, TodayRow, TodaySection, TodaySource, TodayWorkspace } from "./types";

/**
 * Meetings: today's events of every job, from LifeOS's `events:range` over
 * two local days on the all-sector session. Today's make the rows (all-day
 * first, then by start); tomorrow's first feeds one line once the day's
 * meetings are over. The row's press opens the event in its job's Agenda;
 * Prepare starts a thread about it there, as Agenda's Prepare does.
 */

const SECTION: TodaySection = { id: "meetings", title: "Meetings", order: 20, empty: "No meetings today", lifeos: true, bones: "lines" };

export type MeetingEvent = {
  _id: string;
  title: string;
  sector: SectorKey;
  startsAt: number;
  endsAt?: number;
  allDay: boolean;
  hidden?: boolean;
  location?: string;
  leaveAt?: number;
  travel?: { departedAt?: number };
  attendees?: { address: string }[];
};

export const eventKey = (id: string): string => `event:${id}`;
const HOUR = 3_600_000;

/**
 * The one live line under a meeting's time: "Leave 5:10 PM" while that is
 * ahead, then "in 25 min" within the hour before it starts, then "Now"
 * while it runs. Nothing for an all-day event or one that is over.
 */
export function liveLine(event: MeetingEvent, now: number): string | undefined {
  const leave = leaveAt(event as LeaveSource, now);
  if (leave !== undefined && leave > now) return `Leave ${clockTime(leave)}`;
  if (event.allDay) return undefined;
  if (event.startsAt > now) return event.startsAt - now <= HOUR ? `in ${Math.max(1, Math.ceil((event.startsAt - now) / 60_000))} min` : undefined;
  return endOf(event) > now ? "Now" : undefined;
}

/** Where it is and who of the job's people is there, as Agenda's row words them: "CoRec 2212, with Dana Reyes". */
export function placeAndPeople(event: MeetingEvent, people: readonly DirectoryPerson[]): string | undefined {
  const met = knownAttendees(event.attendees, people);
  const names = met.length ? `${met.slice(0, 3).map((p) => p.name).join(", ")}${met.length > 3 ? `, and ${met.length - 3} more` : ""}` : null;
  if (event.location && names) return `${event.location}, with ${names}`;
  return event.location ?? (names ? `With ${names}` : undefined);
}

const chipOf = (event: MeetingEvent): ContextChip => ({ kind: "event", label: event.title, ref: { at: "lifeos", table: "events", id: event._id } });

type Ways = {
  workspaceOf(sector: SectorKey): TodayWorkspace | null;
  peopleOf(sector: SectorKey): readonly DirectoryPerson[];
  open(workspace: TodayWorkspace, event: MeetingEvent): void;
  prepare(workspace: TodayWorkspace, event: MeetingEvent): void;
};

/** Today's meetings as rows, and the line for when they are all over. A sector with no job is left out. */
export function meetingRows(events: readonly MeetingEvent[], day: { from: number; to: number }, now: number, ways: Ways): { rows: TodayRow[]; note?: string } {
  const mine = events.filter((event) => !event.hidden && ways.workspaceOf(event.sector));
  const days = groupByDay(mine, day.from, dayAfter(day.from, 2));
  const today = days.find((d) => d.day === day.from)?.events ?? [];
  const rows = today.map((event, at): TodayRow => {
    const workspace = ways.workspaceOf(event.sector)!;
    const past = endOf(event) < now;
    const detail = placeAndPeople(event, ways.peopleOf(event.sector));
    const line = past ? undefined : liveLine(event, now);
    return {
      key: eventKey(event._id),
      section: SECTION.id,
      sector: event.sector,
      title: event.title,
      ...(detail ? { detail } : {}),
      at,
      when: event.allDay ? "All day" : clockTime(event.startsAt),
      ...(line ? { whenLine: line } : {}),
      ...(past ? { past: true } : {}),
      open: () => ways.open(workspace, event),
      ...(past ? {} : { acts: [{ label: "Prepare", run: () => ways.prepare(workspace, event) }] }),
    };
  });
  if (rows.length === 0 || rows.some((row) => !row.past)) return { rows };
  const next = days.find((d) => d.day === dayAfter(day.from, 1))?.events.find((event) => !event.allDay);
  // The fold above already says today's are over ("2 earlier"); the line says only what comes next.
  return next ? { rows, note: `Tomorrow starts at ${clockTime(next.startsAt)} with ${next.title}.` } : { rows };
}

/** A slot with nothing to read. */
const IDLE: LifeosSession = { environmentId: "", sector: null, client: null, state: "off" };
const NO_PEOPLE: readonly DirectoryPerson[] = [];

/** One sector's people, read only while a job holds the sector. Always the same hooks. */
function usePeopleOf(env: TodayEnv, sector: SectorKey): readonly DirectoryPerson[] {
  const held = env.workspaces.some((w) => w.sector === sector);
  const read = useLifeosQuery<DirectoryPerson[]>(held ? env.lifeos : IDLE, "people:directory", { sector });
  return held && read.status === "ready" ? read.value : NO_PEOPLE;
}

const pick = (value: MeetingEvent[]): MeetingEvent[] => value;
const idOf = (event: MeetingEvent): string => event._id;

function useMeetings(env: TodayEnv): TodayAnswer {
  const now = useMinute();
  const { from, to } = env.day;
  const read = useLifeosRows<MeetingEvent[], MeetingEvent>(env, "events:range", useMemo(() => ({ from, to: dayAfter(from, 2) }), [from]), pick, idOf);
  const cosmic = usePeopleOf(env, "cosmic");
  const hypixel = usePeopleOf(env, "hypixel");
  const purdue = usePeopleOf(env, "purdue");
  const ref = usePeopleOf(env, "ref");
  const unify = usePeopleOf(env, "unify");
  const life = usePeopleOf(env, "life");
  const built = useMemo(() => {
    if (!read.rows) return null;
    const people: Record<SectorKey, readonly DirectoryPerson[]> = { cosmic, hypixel, purdue, ref, unify, life };
    return meetingRows(read.rows, { from, to }, now, {
      workspaceOf: env.workspaceOf,
      peopleOf: (sector) => people[sector] ?? NO_PEOPLE,
      open: (workspace, event) => goTo(workspace, { view: "agenda", event: event._id }),
      // A new thread's composer in that job with the event in it; nothing runs until he sends.
      prepare: (workspace, event) => startThreadAbout(chipOf(event), null, workspace.path),
    });
  }, [read.rows, from, to, now, env.workspaceOf, cosmic, hypixel, purdue, ref, unify, life]);
  const rows = useStableRows(built?.rows ?? NONE, env.workspaceOf);
  const note = built?.note;
  const lifeos = env.lifeos;
  // Still to answer: the rows it had stay on the page until it does (store.ts `putAnswer`).
  return useMemo<TodayAnswer>(() => answerOf(read, built && rows, lifeos, "meetings", note), [read, built, rows, lifeos, note]);
}

const NONE: readonly TodayRow[] = [];

export const source: TodaySource = { id: "meetings", section: SECTION, use: useMeetings };
