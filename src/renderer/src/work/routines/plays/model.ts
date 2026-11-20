import {
  PLAY_TAKE_CHIPS,
  PLAY_TAKES,
  STARTER_PLAYS,
  isThingTake,
  playInputsProblem,
  takeOfChip,
  type PlayInputs,
  type PlayRow,
  type PlayTake,
  type StarterPlay,
} from "@shared/contract-work-routines";
import type { ChipKind, ContextChip } from "@shared/work";

/**
 * The plays' words and rules on screen (docs/agents/work-plays.md): what a
 * play takes, in a line; the starters still to offer; which plays a thing
 * can start; and what a start still needs from him.
 */

export const TAKE_LABEL: Record<PlayTake, string> = { mail: "Mail", task: "Task", event: "Event", file: "File", date: "Date", text: "Text" };
const TAKE_NOUN: Record<PlayTake, string> = { mail: "a mail", task: "a task", event: "an event", file: "a file", date: "a date", text: "a line of text" };

/** "Takes a mail", "Takes a mail and a date", "Takes nothing". */
export function takesLine(takes: readonly PlayTake[]): string {
  if (!takes.length) return "Takes nothing";
  const nouns = takes.map((t) => TAKE_NOUN[t]);
  return `Takes ${nouns.length > 1 ? `${nouns.slice(0, -1).join(", ")} and ${nouns.at(-1)}` : nouns[0]}`;
}

/** The starters of this sector he has not added yet, in their own order: none he added, and none named as a play he has. */
export function startersLeft(sector: string | null | undefined, plays: readonly PlayRow[]): readonly StarterPlay[] {
  const added = new Set(plays.map((p) => p.starter).filter(Boolean));
  const names = new Set(plays.map((p) => p.name.trim().toLowerCase()));
  return (STARTER_PLAYS[sector ?? ""] ?? []).filter((s) => !added.has(s.key) && !names.has(s.name.toLowerCase()));
}

/** The plays a thing of this kind can start: his own (no proposal), that take it. */
export function playsFor(plays: readonly PlayRow[], kind: string): PlayRow[] {
  const take = takeOfChip(kind as ChipKind);
  return take ? plays.filter((p) => !p.proposed && p.takes.includes(take)) : [];
}

/** What he still gives a start, once the thing it started from is in: the takes no chip fills. */
export function takesLeft(play: Pick<PlayRow, "takes">, given: readonly ContextChip[]): PlayTake[] {
  return play.takes.filter((t) => !(isThingTake(t) && given.some((c) => PLAY_TAKE_CHIPS[t].includes(c.kind))));
}

/** The chip kinds a picker for this take searches. */
export const pickerKinds = (take: PlayTake): readonly ChipKind[] => (isThingTake(take) ? PLAY_TAKE_CHIPS[take] : []);

/** A start's inputs from what he picked and typed, or why it cannot start yet. */
export function startInputs(play: Pick<PlayRow, "takes">, o: { chips: readonly ContextChip[]; date?: string; text?: string }): { inputs: PlayInputs } | { problem: string } {
  const inputs: PlayInputs = {
    chips: [...o.chips],
    ...(play.takes.includes("date") && o.date ? { date: o.date } : {}),
    ...(play.takes.includes("text") && o.text?.trim() ? { text: o.text.trim() } : {}),
  };
  for (const take of play.takes) {
    if (isThingTake(take) && !o.chips.some((c) => PLAY_TAKE_CHIPS[take].includes(c.kind))) return { problem: `Pick ${TAKE_NOUN[take]}` };
    if (take === "date" && !inputs.date) return { problem: "Pick a date" };
    if (take === "text" && !inputs.text) return { problem: "Give it a line of text" };
  }
  const problem = playInputsProblem(play.takes, inputs);
  return problem ? { problem: `${problem.charAt(0).toUpperCase()}${problem.slice(1)}` } : { inputs };
}

/** Today on his wall clock, as a date field holds it. */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface PlayForm {
  name: string;
  instructions: string;
  takes: PlayTake[];
}

export const blankPlay = (): PlayForm => ({ name: "", instructions: "", takes: [] });

/** Why the form cannot be saved, or null. */
export function playFormProblem(form: PlayForm): string | null {
  if (!form.name.trim()) return "Give it a name";
  if (!form.instructions.trim()) return "Say what it does";
  return null;
}

/** The takes in their one order, whatever order they were toggled in. */
export const orderedTakes = (takes: readonly string[]): PlayTake[] => PLAY_TAKES.filter((t) => takes.includes(t));
