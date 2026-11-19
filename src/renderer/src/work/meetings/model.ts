import { meetingTime, type Meeting, type MeetingAction, type MeetingSegment, type MeetingSpeaker } from "@shared/contract-work-meetings";

/**
 * What the meeting canvas works out from a meeting, with no React in it
 * (docs/agents/work-meetings.md "The canvas"): the wave's bars, the turn a
 * moment falls in, where each task sits, the find hits and a stretch's label.
 */

/** How many bars the wave draws: the prototype's 100, from the host's 400 peaks. */
export const WAVE_BARS = 100;

/** The bars' heights, 0 to 1: the loudest peak of each bar's share. A meeting with no peaks draws a flat, quiet wave. */
export function waveBars(peaks: readonly number[], bars = WAVE_BARS): number[] {
  if (peaks.length === 0) return Array.from({ length: bars }, () => 0);
  return Array.from({ length: bars }, (_, i) => {
    const from = Math.floor((i * peaks.length) / bars);
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / bars));
    let top = 0;
    for (let j = from; j < to && j < peaks.length; j++) top = Math.max(top, peaks[j]);
    return Math.min(1, Math.max(0, top));
  });
}

/** Whether the times read h:mm:ss: a recording that passes an hour holds the hour's place throughout. */
export const isLong = (m: Pick<Meeting, "durationSec">): boolean => m.durationSec >= 3600;

/** A moment as the canvas writes it. */
export const timeOf = (seconds: number, m: Pick<Meeting, "durationSec">): string => meetingTime(seconds, isLong(m));

/** The turn playing at `t`: the last one that starts at or before it. Null before the first. */
export function segmentAt(segments: readonly MeetingSegment[], t: number): MeetingSegment | null {
  let lo = 0;
  let hi = segments.length - 1;
  let found: MeetingSegment | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].start <= t) {
      found = segments[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** What a speaker is called: his name, the file's, else "Speaker 2"; a turn with no speaker is "Unknown". */
export function speakerName(speakers: readonly MeetingSpeaker[], id: string | null): string {
  const s = id ? speakers.find((x) => x.id === id) : undefined;
  return s ? (s.name ?? s.label) : "Unknown";
}

/** The turn a task was said in: its first cited turn, else the turn its moment falls in. */
export function turnOfAction(action: MeetingAction, segments: readonly MeetingSegment[]): string | null {
  const ref = action.refs.find((id) => segments.some((s) => s.id === id));
  if (ref) return ref;
  return action.at === null ? null : (segmentAt(segments, action.at)?.id ?? null);
}

/** The tasks to show (rejected ones are gone), by the turn they sit under, in the transcript's order. */
export function tasksByTurn(m: Pick<Meeting, "notes" | "segments">): Map<string, MeetingAction[]> {
  const out = new Map<string, MeetingAction[]>();
  for (const action of m.notes?.actions ?? []) {
    if (action.state === "rejected") continue;
    const turn = turnOfAction(action, m.segments);
    if (!turn) continue;
    out.set(turn, [...(out.get(turn) ?? []), action]);
  }
  return out;
}

/** The tasks waiting for him, in the order they were said: what the stepper steps through. */
export function proposedTasks(m: Pick<Meeting, "notes" | "segments">): MeetingAction[] {
  const order = new Map(m.segments.map((s, i) => [s.id, i]));
  const rank = (a: MeetingAction): number => {
    const turn = turnOfAction(a, m.segments);
    return turn ? (order.get(turn) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
  };
  return (m.notes?.actions ?? []).filter((a) => a.state === "proposed").sort((a, b) => rank(a) - rank(b) || (a.at ?? 0) - (b.at ?? 0));
}

/** One find hit: a turn and where in its words. */
export interface FindHit {
  segment: string;
  from: number;
  to: number;
}

/** Every place `query` is in the turns' words, case aside, in order. An empty query finds nothing. */
export function findHits(segments: readonly MeetingSegment[], query: string): FindHit[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [];
  const out: FindHit[] = [];
  for (const s of segments) {
    const text = s.text.toLocaleLowerCase();
    for (let at = text.indexOf(q); at >= 0; at = text.indexOf(q, at + q.length)) out.push({ segment: s.id, from: at, to: at + q.length });
  }
  return out;
}

/** A turn's words cut into runs: plain, a hit, the current hit. */
export function markRuns(text: string, hits: readonly FindHit[], current: FindHit | null): { text: string; hit: "none" | "hit" | "current" }[] {
  if (hits.length === 0) return [{ text, hit: "none" }];
  const out: { text: string; hit: "none" | "hit" | "current" }[] = [];
  let at = 0;
  for (const h of hits) {
    if (h.from > at) out.push({ text: text.slice(at, h.from), hit: "none" });
    out.push({ text: text.slice(h.from, h.to), hit: current && current.segment === h.segment && current.from === h.from ? "current" : "hit" });
    at = h.to;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: "none" });
  return out;
}

/** The span a run of turns covers, from the first's start to the last's end (or the next turn's start). */
export function stretchOf(segments: readonly MeetingSegment[], ids: readonly string[]): { start: number; end: number } | null {
  const picked = segments.map((s, i) => ({ s, i })).filter(({ s }) => ids.includes(s.id));
  if (picked.length === 0) return null;
  const first = picked[0].s;
  const { s: last, i } = picked[picked.length - 1];
  return { start: first.start, end: last.end ?? segments[i + 1]?.start ?? last.start };
}

/** What Ask's chip says for a stretch: "15:02 to 15:41, Staff sync". */
export function stretchLabel(m: Pick<Meeting, "durationSec" | "title">, span: { start: number; end: number }): string {
  return `${timeOf(span.start, m)} to ${timeOf(span.end, m)}, ${m.title}`;
}

/** The line under the turns while it transcribes. */
export function progressLine(m: Pick<Meeting, "progress" | "durationSec">): string {
  const p = m.progress;
  if (!p || p.phase !== "words" || p.total <= 0) return "Finding who speaks";
  if (p.total < 120) return `Transcribing, ${meetingTime(p.done)} of ${meetingTime(p.total)}`;
  return `Transcribing, ${Math.floor(p.done / 60)} of ${Math.round(p.total / 60)} minutes`;
}

/** A due date as a task row shows it: "Fri", "Nov 28"; nothing when it has none. */
export function dueOf(due: string | undefined, now = Date.now(), locale?: string): string {
  if (!due) return "";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(due) ? new Date(`${due}T09:00:00`) : new Date(due);
  const at = date.getTime();
  if (!Number.isFinite(at)) return "";
  const days = (at - now) / 86_400_000;
  return days > -1 && days < 6 ? date.toLocaleDateString(locale, { weekday: "short" }) : date.toLocaleDateString(locale, { month: "short", day: "numeric" });
}
