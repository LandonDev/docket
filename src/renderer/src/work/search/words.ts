import type { SearchHit } from "@shared/work/search";
import { matchRanges } from "../../chrome/MatchText";

/**
 * A row's muted words (docs/DESIGN.md "Work search"): its one fact, and its
 * time. What has passed says how long ago, shortly ("2d"); an event says
 * when it is; a task says when it is due, as its fact.
 */

const TASK_KEY = /^[A-Za-z]{2,6}-\d+$/;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** How long ago, in one short word: "now", "12m", "5h", "2d", "3w", "4mo", "2y". */
export function ageWords(at: number, now = Date.now()): string {
  const gone = Math.max(0, now - at);
  if (gone < MIN) return "now";
  if (gone < HOUR) return `${Math.floor(gone / MIN)}m`;
  if (gone < DAY) return `${Math.floor(gone / HOUR)}h`;
  if (gone < 7 * DAY) return `${Math.floor(gone / DAY)}d`;
  if (gone < 35 * DAY) return `${Math.floor(gone / (7 * DAY))}w`;
  if (gone < 365 * DAY) return `${Math.floor(gone / (30 * DAY))}mo`;
  return `${Math.floor(gone / (365 * DAY))}y`;
}

/** A found line keeps this many characters before the first word that found it; past that the line begins a word before it. */
const LEAD = 12;

/**
 * A found line as a row shows it. The row cuts a long line at its end, so a line whose matched word lies
 * past its start would show none of why it was found: it begins a word before that word instead, marked as cut.
 */
export function lineAt(line: string, query: string): string {
  const first = matchRanges(line, { query })[0];
  if (!first || first[0] <= LEAD) return line;
  const from = line.slice(0, first[0]).trimEnd().lastIndexOf(" ") + 1;
  return from <= 1 ? line : `…${line.slice(from)}`;
}

/** The fact a row shows after its title: the line the words were found in, else its own fact; a task's due day. */
export function factOf(hit: SearchHit, now = Date.now(), query = ""): string | undefined {
  if (hit.snippet) return lineAt(hit.snippet, query);
  // A task that is done, dropped or waiting says so; an open one says when it is due, else its key.
  if (hit.kind === "task" && hit.at !== undefined && (!hit.detail || TASK_KEY.test(hit.detail))) return `Due ${eventWords(hit.at, now)}`;
  return hit.detail;
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const monthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** When an event is: today's as a time, any other as its day. Never a year: an event is found only within months of today. */
export function eventWords(at: number, now = Date.now()): string {
  const date = new Date(at);
  return date.toDateString() === new Date(now).toDateString() ? clock.format(date) : monthDay.format(date);
}

/** The time at a row's end; none for a task (its due day is its fact). */
export function timeOf(hit: SearchHit, now = Date.now()): string | undefined {
  if (hit.at === undefined || hit.kind === "task") return undefined;
  return hit.kind === "event" || hit.at > now ? eventWords(hit.at, now) : ageWords(hit.at, now);
}
