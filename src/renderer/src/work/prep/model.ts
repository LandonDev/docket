import { prepEndOf, type PrepAddedPerson, type PrepDraft, type PrepEvent, type PrepFileRef, type PrepPage, type PrepPerson, type PrepProblem, type PrepSuggestion, type PrepTask, type PrepUpcoming } from "@shared/contract-work-prep";
import { formatLeave, formatStamp, formatTime } from "work-kit/views/lib/format";

/**
 * A meeting's page in words (docs/agents/work-prep.md "The page"): the one
 * comma line under its title, what each row says, and which verb its header
 * holds. Pure, so the page, its preview and its tests share one reading.
 */

const DAY = 86_400_000;
const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const dayOffset = (ms: number, now: number): number => Math.round((startOfDay(ms) - startOfDay(now)) / DAY);

/** The day a meeting is on, as a sentence starts with it: "Today", "Tomorrow", "Yesterday", else "Mon, Nov 16". */
export function dayWords(ms: number, now: number): string {
  const offset = dayOffset(ms, now);
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  if (offset === -1) return "Yesterday";
  return new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** A day inside a sentence or a label: "Nov 16". */
export const shortDay = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** "2:00 to 2:45 PM", "11:30 AM to 12:15 PM", "2:00 PM" with no end, "all day". */
export function timeWords(event: Pick<PrepEvent, "startsAt" | "endsAt" | "allDay">): string {
  if (event.allDay) return "all day";
  if (event.endsAt === undefined || event.endsAt <= event.startsAt) return formatTime(event.startsAt);
  return `${formatLeave(event.startsAt, event.endsAt)} to ${formatTime(event.endsAt)}`;
}

/**
 * The one muted line under the title: when it is, where, and when to leave
 * while that is still ahead. "Today, 2:00 to 2:45 PM, RecWell 204, leave 1:40".
 */
export function whenLine(event: PrepEvent, now: number): string {
  const parts = [dayWords(event.startsAt, now), timeWords(event)];
  if (event.location?.trim()) parts.push(event.location.trim());
  if (event.leaveAt !== undefined && !event.allDay && now < event.startsAt) parts.push(`leave ${formatLeave(event.leaveAt, event.startsAt)}`);
  return parts.join(", ");
}

/** Whether the meeting is over: what turns Prepare into Follow up. */
export const isOver = (event: Pick<PrepEvent, "startsAt" | "endsAt">, now: number): boolean => prepEndOf(event) <= now;

/** A person's second line: their newest mail's subject, when there is one. */
export const personLine = (person: PrepPerson): string | undefined => (person.mail ? person.mail.subject.trim() || "(no subject)" : undefined);

/** What trails a person's row: "Declined" for one who declined, else the day of their newest mail. */
export function personTrail(person: PrepPerson, now: number): string | undefined {
  if (person.declined) return "Declined";
  return person.mail ? formatStamp(person.mail.at, now) : undefined;
}

/** Why a task is on the page; a task that only names the subject has no second line. */
export function taskLine(task: PrepTask): string | undefined {
  if (!task.who) return undefined;
  if (task.why === "asked") return `Asked by ${task.who}`;
  if (task.why === "waiting") return `Waiting on ${task.who}`;
  return undefined;
}

/** Where a file lives: its site for a link, nothing for one of the workspace's own. */
export function fileWhere(file: PrepFileRef): string | undefined {
  if (!file.url) return undefined;
  try {
    return new URL(file.url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** "and 3 more", for the people past the ones drawn. */
export const moreWords = (count: number): string | undefined => (count > 0 ? `and ${count} more` : undefined);

const PART: Record<PrepProblem, string> = { people: "People", tasks: "Tasks", last: "Last time", drafts: "The follow-up mail" };

/** What did not load, as the state line says it: "Tasks did not load", "People and tasks did not load". */
export function problemWords(problems: readonly PrepProblem[]): string | null {
  const names = [...new Set(problems)].map((p) => PART[p]);
  if (!names.length) return null;
  // One sentence: only its first word is capitalised.
  const rest = names.slice(1).map((n) => n.charAt(0).toLowerCase() + n.slice(1));
  const list = rest.length === 0 ? names[0]! : `${[names[0]!, ...rest.slice(0, -1)].join(", ")} and ${rest.at(-1)!}`;
  return `${list} did not load`;
}

/** The label over last time's section: "Last time, Nov 16". */
export const lastLabel = (last: NonNullable<PrepPage["last"]>): string => `Last time, ${shortDay(last.startsAt)}`;

/** Whether the page has anyone on it at all. */
export const nobodyOn = (page: Pick<PrepPage, "people" | "morePeople">): boolean => page.people.length === 0 && page.morePeople === 0;

const fold = (s: string): string => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** A person as a page keeps them once: their address, or their folded name when they have none (the host's `personKey`). */
export const addedKey = (person: Pick<PrepAddedPerson, "address" | "name">): string => (person.address ? person.address.trim().toLowerCase() : `~${fold(person.name)}`);

/**
 * Everyone Add people can tick: those the page already added (a name he typed
 * among them) first, then the sector's people who are not on the event
 * itself, each once.
 */
export function pickable(page: Pick<PrepPage, "people" | "doc">, directory: readonly { _id: string; name: string; emails: string[] }[]): PrepAddedPerson[] {
  const onEvent = new Set(page.people.filter((p) => !p.added && p.address).map((p) => p.address!.toLowerCase()));
  const out = new Map<string, PrepAddedPerson>();
  for (const p of page.doc.people) out.set(addedKey(p), p);
  for (const p of directory) {
    if (p.emails.some((e) => onEvent.has(e.toLowerCase()))) continue;
    const address = p.emails[0]?.toLowerCase();
    const person: PrepAddedPerson = { name: p.name, ...(address ? { address } : {}), personId: p._id };
    // Someone already added by one of their addresses is that same person, not a second row.
    const held = p.emails.map((e) => e.toLowerCase()).find((e) => out.has(e));
    if (held || out.has(addedKey(person))) continue;
    out.set(addedKey(person), person);
  }
  return [...out.values()];
}

/** A thread's status as the window's own session row has it; undefined: this window does not hold the thread. */
export type ThreadStatus = string | undefined;

/** Whether a thread is still at work: running, queued to run, or waiting on him inside its turn. */
export const threadWorks = (status: ThreadStatus): boolean => status === "running" || status === "queued" || status === "waiting";

/**
 * The header's one verb (docs/agents/work-prep.md "The header"). Before the
 * end: Brief me, then Preparing while its thread works, then nothing once a
 * brief stands. After the end, or once notes stand: Add notes, then Follow
 * up, then Following up while its thread works, then nothing once an outcome
 * stands. The window knows a thread's status from its own row; for a thread
 * it does not hold, the host's bound on time stands in.
 */
export type HeadVerb = "brief" | "preparing" | "addNotes" | "followUp" | "following" | null;

export function headVerb(page: Pick<PrepPage, "event" | "doc" | "state" | "briefSessionId" | "followSessionId">, now: number, threads: { brief: ThreadStatus; follow: ThreadStatus }): HeadVerb {
  const { doc } = page;
  if (page.followSessionId && threadWorks(threads.follow)) return "following";
  if (doc.after) return null;
  if (doc.notes) return "followUp";
  if (isOver(page.event, now)) return "addNotes";
  if (page.briefSessionId && (threads.brief === undefined ? page.state === "working" : threadWorks(threads.brief))) return "preparing";
  return doc.brief ? null : "brief";
}

/** Whether the brief's place shows its bones: a thread is writing and nothing stands yet. */
export const briefIsComing = (page: Pick<PrepPage, "doc">, verb: HeadVerb): boolean => verb === "preparing" && !page.doc.brief;

/** The thread More's Open thread opens: the follow-up's once there is one, else the brief's. */
export const pageThread = (page: Pick<PrepPage, "briefSessionId" | "followSessionId">): string | null => page.followSessionId ?? page.briefSessionId;

/** A suggested task's muted line: who it falls to and when it is due, as one comma sentence. */
export function suggestionLine(task: Pick<PrepSuggestion, "who" | "due">, now: number): string | undefined {
  const parts = [task.who?.trim(), task.due !== undefined ? `due ${dayWords(task.due, now).replace(/^(Today|Tomorrow|Yesterday)$/, (d) => d.toLowerCase())}` : undefined].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

/** The suggestions the page still draws: one he rejected is gone. */
export const shownTasks = (tasks: readonly PrepSuggestion[]): PrepSuggestion[] => tasks.filter((t) => t.state !== "rejected");

/** "Add 3 tasks", "Add 1 task". */
export const addTasksLabel = (count: number): string => `Add ${count} ${count === 1 ? "task" : "tasks"}`;

/** The mail row's words: "Follow-up to Maya Chen and Tom Beck". */
export function draftLine(draft: Pick<PrepDraft, "to" | "subject">): string {
  const to = draft.to;
  if (!to.length) return draft.subject.trim() || "Follow-up mail";
  const names = to.length <= 2 ? to.join(" and ") : `${to[0]}, ${to[1]} and ${to.length - 2} more`;
  return `Follow-up to ${names}`;
}

/** How many lines of his notes the page shows before Show all. */
export const NOTES_LINES = 6;
/** Whether notes run past what six lines hold: long by lines or by length. */
export const notesAreLong = (text: string): boolean => text.split("\n").length > NOTES_LINES || text.length > 480;

/** The files Follow up reads as the notes: a recording, or a transcript Teams, Zoom or a recorder wrote. */
export const NOTES_FILE_ACCEPT = "audio/*,video/*,.vtt,.srt,.txt,.docx";
const TRANSCRIPT = /\.(vtt|srt|txt|docx)$/i;
/** What a notes file is, as its row says under its name. */
export const notesFileKind = (name: string): "Transcript" | "Recording" => (TRANSCRIPT.test(name.trim()) ? "Transcript" : "Recording");

/** "Uploading Staff sync.m4a, 42%": the dialog's line while a file goes up. */
export function uploadWords(name: string, progress: { sent: number; total: number } | null): string {
  if (!progress || progress.total <= 0) return `Uploading ${name}`;
  return `Uploading ${name}, ${Math.min(100, Math.round((progress.sent / progress.total) * 100))}%`;
}

/**
 * What a meeting's row on Today gains from prep (SEAMS, today: a `TodayMark` on
 * `event:<LifeOS event id>`): a press opens its page, and it says "Prep is
 * ready" only once a brief stands. Plain data, so Today's source is one map
 * over `work.prep.upcoming`.
 */
export function meetingMark(meeting: Pick<PrepUpcoming, "workspaceId" | "eventId" | "state">): { key: string; note?: string; target: { workspaceId: string; view: "prep"; event: string } } {
  return { key: `event:${meeting.eventId}`, ...(meeting.state === "briefed" ? { note: "Prep is ready" } : {}), target: { workspaceId: meeting.workspaceId, view: "prep", event: meeting.eventId } };
}
