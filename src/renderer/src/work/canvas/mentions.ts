import type { ChipKind, MentionAnswer, MentionHit } from "@shared/work";
import { registry } from "../../lib/connection";
import { addContextChip } from "./chips";
import { CHIP_GLYPH } from "./ComposerChips";
import { Layers, type IconComponent } from "../../chrome/icons";

/**
 * The composer's `@` for Work (docs/agents/work-canvas.md "Mentions"): the
 * host's answer (`work.canvas.mentions`, found only in what the thread may
 * read) as rows the `@` list draws, and a pick that puts the chip in the
 * composer. The composer is in the first paint and this is not: it reaches
 * these through the work-canvas chunk once a thread that may mention Work
 * things types `@`.
 */

/** One row of the `@` list: the hit, its group's name and glyph, and its muted facts. */
export interface WorkMentionRow {
  hit: MentionHit;
  group: string;
  Glyph: IconComponent;
  /** the time, worded for the row ("2:00 PM", "Apr 10") */
  when?: string;
}

export interface WorkMentionResult {
  rows: WorkMentionRow[];
  /** one muted line for the kinds that could not be searched, or null */
  failed: string | null;
}

/** Each kind's group in the list. */
const GROUP: Record<ChipKind, string> = {
  task: "Tasks",
  mail: "Mail",
  event: "Agenda",
  project: "Projects",
  card: "Cards",
  person: "People",
  doc: "Documents",
  item: "Items",
  held: "Outbox",
  routine: "Routines",
  selection: "Selections",
};
const LIFEOS_KINDS: readonly ChipKind[] = ["task", "mail", "event", "project", "card", "person", "doc"];

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const dayYear = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

/** A time as a row says it: today's as a time, this year's as a day, an older one with its year. */
export function whenWords(at: number, now = Date.now()): string {
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return time.format(date);
  return (date.getFullYear() === today.getFullYear() ? day : dayYear).format(date);
}

/** Where a draft will be made, for a thread the host does not have yet. */
export interface MentionDraft {
  projectId?: string | null;
  workspaceId?: string | null;
  work?: boolean;
}

/** The host's answer for `text`, as rows. Throws when the host could not be asked. */
export async function searchWorkMentions(env: string, sessionId: string, text: string, draft?: MentionDraft): Promise<WorkMentionResult> {
  const answer = await registry.linkOf(env).request<MentionAnswer>("work.canvas.mentions", { sessionId, text, ...(draft ? { draft } : {}) });
  return resultOf(answer);
}

export function resultOf(answer: MentionAnswer, now = Date.now()): WorkMentionResult {
  const rows = answer.hits.map((hit) => ({
    hit,
    group: GROUP[hit.chip.kind] ?? "More",
    Glyph: CHIP_GLYPH[hit.chip.kind] ?? Layers,
    ...(hit.at ? { when: whenWords(hit.at, now) } : {}),
  }));
  const failed = answer.failed.length === 0 ? null : answer.failed.every((k) => LIFEOS_KINDS.includes(k)) ? "Couldn't reach LifeOS" : "Couldn't search everything";
  return { rows, failed };
}

/** The pick: the thing goes in the thread's composer as a chip. */
export function pickWorkMention(sessionId: string, row: WorkMentionRow): void {
  addContextChip(sessionId, row.hit.chip);
}
