import {
  LIFEOS_TRIGGER_KINDS,
  parseSchedule,
  scheduleRrule,
  type LifeosTriggerKind,
  type RoutineEnds,
  type RoutineRow,
  type RoutineRun,
} from "@shared/contract-work-routines";
import type { Trigger } from "@shared/work";
import type { ThreadState } from "../../components/ui/status";
import { dayTime } from "../../lib/duration";

/**
 * The Routines view's words and its form, kept apart from React so they
 * are tested on their own: what a row says under its name, which mark its
 * status slot shows, and the form's fields both ways (prototype
 * routines.html, "List and detail" and "A form").
 */

export type StartsOn = "sched" | "event" | "read" | "file";
export type EndsOn = "never" | "day" | "once";

/** The schedule's Days choices: a set of weekdays, or a repeat. */
export const DAY_CHOICES = [
  { value: "weekdays", label: "Weekdays" },
  { value: "daily", label: "Every day" },
  { value: "weekends", label: "Weekends" },
  { value: "1", label: "Mondays" },
  { value: "2", label: "Tuesdays" },
  { value: "3", label: "Wednesdays" },
  { value: "4", label: "Thursdays" },
  { value: "5", label: "Fridays" },
  { value: "6", label: "Saturdays" },
  { value: "0", label: "Sundays" },
  { value: "m15", label: "Every 15 minutes" },
  { value: "m30", label: "Every 30 minutes" },
  { value: "m60", label: "Every hour" },
] as const;
export type DaysChoice = (typeof DAY_CHOICES)[number]["value"];

export const EVERY_CHOICES = [
  { value: "5", label: "5 minutes" },
  { value: "10", label: "10 minutes" },
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "Hour" },
] as const;

export const EVENT_CHOICES = Object.entries(LIFEOS_TRIGGER_KINDS).map(([value, label]) => ({ value: value as LifeosTriggerKind, label }));

export interface RoutineForm {
  name: string;
  prompt: string;
  /** the play each run starts, "" for none (docs/agents/work-plays.md) */
  play: string;
  starts: StartsOn;
  days: DaysChoice;
  /** "07:00" */
  at: string;
  event: LifeosTriggerKind;
  /** a tool set to Runs, as "<addonId>\n<tool>" */
  tool: string;
  every: string;
  /** the read's fixed arguments, as JSON */
  args: string;
  path: string;
  ends: EndsOn;
  /** "2026-11-24" */
  until: string;
}

const pad = (n: number): string => String(n).padStart(2, "0");
const dateOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function blankForm(now = Date.now()): RoutineForm {
  return { name: "", prompt: "", play: "", starts: "sched", days: "weekdays", at: "07:00", event: "mail.received", tool: "", every: "15", args: "{}", path: "", ends: "never", until: dateOf(now + 7 * 86_400_000) };
}

const daysOf = (days: readonly number[]): DaysChoice => {
  const key = [...days].sort().join();
  if (key === "1,2,3,4,5") return "weekdays";
  if (key === "0,1,2,3,4,5,6") return "daily";
  if (key === "0,6") return "weekends";
  return days.length === 1 ? (String(days[0]) as DaysChoice) : "weekdays";
};

/** A saved routine (or an agent's proposal) as the form shows it. */
export function formOf(row: RoutineRow, now = Date.now()): RoutineForm {
  const f: RoutineForm = { ...blankForm(now), name: row.name, prompt: row.prompt, play: row.playId ?? "" };
  const t = row.trigger;
  if (t.on === "schedule") {
    const s = parseSchedule(t.rrule);
    if (s?.every === "minutes") f.days = s.interval >= 60 ? "m60" : s.interval >= 30 ? "m30" : "m15";
    else if (s) {
      f.days = daysOf(s.days);
      f.at = `${pad(s.hour)}:${pad(s.minute)}`;
    }
  } else if (t.on === "lifeos") {
    f.starts = "event";
    f.event = (t.kinds[0] as LifeosTriggerKind) ?? "mail.received";
  } else if (t.on === "read") {
    f.starts = "read";
    f.tool = `${t.addon}\n${t.tool}`;
    f.every = String(Math.round(t.everySec / 60));
    f.args = JSON.stringify(t.args ?? {});
  } else {
    f.starts = "file";
    f.path = t.source.at === "file" ? t.source.path : "";
  }
  f.ends = row.ends.kind;
  if (row.ends.kind === "day") f.until = dateOf(row.ends.at);
  return f;
}

/** What a form saves, or the one thing wrong with it. `host` is the workspace's host, for a file there. */
export function triggerOf(f: RoutineForm, host: string, tz: string): Trigger | string {
  if (f.starts === "sched") {
    if (f.days.startsWith("m")) return { on: "schedule", rrule: scheduleRrule({ every: "minutes", interval: Number(f.days.slice(1)) }), tz };
    const m = /^(\d{1,2}):(\d{2})$/.exec(f.at);
    if (!m) return "Pick a time";
    const days = f.days === "weekdays" ? [1, 2, 3, 4, 5] : f.days === "daily" ? [0, 1, 2, 3, 4, 5, 6] : f.days === "weekends" ? [0, 6] : [Number(f.days)];
    return { on: "schedule", rrule: scheduleRrule({ every: "week", days, hour: Number(m[1]), minute: Number(m[2]) }), tz };
  }
  if (f.starts === "event") return { on: "lifeos", kinds: [f.event] };
  if (f.starts === "read") {
    const [addon, tool] = f.tool.split("\n");
    if (!addon || !tool) return "Pick a tool to read";
    let args: unknown;
    try {
      args = JSON.parse(f.args.trim() || "{}");
    } catch {
      return "With is not JSON";
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) return "With is an object of the tool's arguments";
    return { on: "read", addon, tool, args, fire: "changed", everySec: Number(f.every) * 60 };
  }
  if (!f.path.trim()) return "Name the file";
  return { on: "file", source: { at: "file", host, path: f.path.trim() }, by: "someone-else" };
}

export function endsOf(f: RoutineForm): RoutineEnds | string {
  if (f.ends === "never") return { kind: "never" };
  if (f.ends === "once") return { kind: "once" };
  const at = Date.parse(`${f.until}T23:59:59`);
  return Number.isFinite(at) ? { kind: "day", at } : "Pick the day it ends";
}

/** What Save sends to `work.routines.save`. */
export interface SaveParams {
  id?: string;
  workspaceId: string;
  projectId: string | null;
  name: string;
  prompt: string;
  playId: string | null;
  job?: string;
  trigger: Trigger;
  ends: RoutineEnds;
  model: string | null;
  reasoning: string | null;
}

/**
 * The form as Save sends it, or the one thing wrong with it. A routine that
 * runs a job needs no words and keeps its job; a trigger he did not touch is
 * sent as it was, whatever the form can show of it.
 */
export function saveParamsOf(f: RoutineForm, row: RoutineRow | null, o: { workspaceId: string; host: string; tz: string; touched: boolean }): SaveParams | string {
  const name = f.name.trim();
  if (!name) return "Give it a name";
  if (!row?.job && !f.play && !f.prompt.trim()) return "Say what it does";
  const trigger = row && !o.touched ? row.trigger : triggerOf(f, o.host, o.tz);
  if (typeof trigger === "string") return trigger;
  const ends = endsOf(f);
  if (typeof ends === "string") return ends;
  return {
    ...(row ? { id: row.id } : {}),
    workspaceId: o.workspaceId,
    projectId: row?.projectId ?? null,
    name,
    prompt: f.prompt.trim(),
    playId: f.play || null,
    ...(row?.job ? { job: row.job } : {}),
    trigger,
    ends,
    model: row?.model ?? null,
    reasoning: row?.reasoning ?? null,
  };
}

const shortDay = (ms: number, now: number): string => {
  const days = Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return new Intl.DateTimeFormat(undefined, days > 0 && days < 7 ? { weekday: "short" } : { month: "short", day: "numeric" }).format(ms);
};

/** A row's line under its name: the trigger, then when ("next Thu", "until Tue", "once", "paused"). */
export function rowLine(r: RoutineRow, now = Date.now()): string {
  if (r.proposed) return `${r.words}, proposed`;
  if (r.ended) return `${r.words}, ended`;
  if (!r.enabled) return `${r.words}, paused`;
  if (r.waiting) return `${r.words}, ${r.waiting.charAt(0).toLowerCase()}${r.waiting.slice(1)}`;
  if (r.ends.kind === "day") return `${r.words}, until ${shortDay(r.ends.at, now)}`;
  if (r.ends.kind === "once") return `${r.words}, once`;
  if (r.nextAt) return `${r.words}, next ${shortDay(r.nextAt, now)}`;
  return r.words;
}

/** The status slot: a mark only when there is a state to show. */
export function rowMark(r: RoutineRow): ThreadState | null {
  if (r.running) return "working";
  if (r.proposed || r.ended) return null;
  if (!r.enabled) return "paused";
  if (r.lastState === "failed") return "failed";
  if (r.ends.kind !== "never") return "watching";
  return null;
}

/** A run's mark: Failed in red, Needs you for a question, Working while it runs, else done. */
export function runMark(run: RoutineRun): ThreadState {
  if (run.state === "failed") return "failed";
  if (run.state === "asked") return "waiting";
  if (run.state === "running" || run.state === "starting") return "working";
  return "done";
}

/** A run's outcome in words. */
export function runWords(run: RoutineRun): string {
  if (run.state === "running" || run.state === "starting") return "Running";
  const folded = run.folded ? `, covers ${run.folded + 1}` : "";
  return `${run.summary || "Done"}${folded}`;
}

/** What a routine with no runs yet says in place of them. */
export function noRunsLine(r: RoutineRow, now = Date.now()): string {
  if (r.trigger.on === "read" && r.checkedAt) return `Read at ${dayTime(r.checkedAt, now)}, nothing new`;
  return r.lastWords ?? "None yet";
}
