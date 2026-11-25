import type { ContextChip } from "@shared/work";
import type { DraftRecord } from "./projectDrafts";

/**
 * Which draft a start about a thing (Start thread on a task, a mail, an event) opens, so a new start never takes
 * another start's unsent words (docs/agents/work.md "Threads file into their projects"). A scope keeps one draft
 * (lib/projectDrafts.ts); a start about a thing takes it only when it holds nothing he wrote, or when it is already
 * about that thing. Otherwise the start opens a draft of its own, kept under the scope's key and the thing's, and the
 * scope's draft stays as he left it: New thread in that scope finds it again, and a second start about the same thing
 * finds its own.
 */

/** A start about a thing, as the window's draft opener gets it: the thing, and the chip a draft's composer leads with
 *  now (Work's chip store, which the first paint may not import: the start brings its reader). */
export type DraftSource = { about: ContextChip; leadOf: (sessionId: string) => ContextChip | undefined };

/** The key a start's own draft lives under: its scope's, then the thing it is about. */
export const sourceDraftKey = (scopeKey: string, about: ContextChip): string => `${scopeKey}#about:${JSON.stringify(about.ref)}`;

/** Whether a draft holds anything he wrote or attached. */
export const holdsWords = (record: Pick<DraftRecord, "segments" | "attachments">): boolean =>
  record.attachments.length > 0 || record.segments.some((s) => ("text" in s ? s.text.trim() !== "" : true));

const sameRef = (a: ContextChip | undefined, b: ContextChip): boolean => !!a && JSON.stringify(a.ref) === JSON.stringify(b.ref);

export function draftKeyForSource(args: {
  scopeKey: string;
  about: ContextChip;
  record: (key: string) => DraftRecord | undefined;
  /** whether draft `id` has become a thread (a host meta): its record is no draft any more */
  sent: (id: string) => boolean;
  /** the chip a draft's composer leads with now */
  leadOf: (id: string) => ContextChip | undefined;
}): string {
  const { scopeKey, about, record, sent, leadOf } = args;
  const own = sourceDraftKey(scopeKey, about);
  const mine = record(own);
  if (mine && !sent(mine.id)) return own;
  const scope = record(scopeKey);
  if (!scope || sent(scope.id) || !holdsWords(scope) || sameRef(leadOf(scope.id), about)) return scopeKey;
  return own;
}
