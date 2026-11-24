import { useSyncExternalStore } from "react";
import type { ChatFile } from "@shared/work/messages";
import type { RowAnchor } from "../../lib/transcriptWindow";
import type { ChatFilter } from "./model";

/**
 * What each workspace's Messages shows, kept while the window lives, so
 * coming back finds it as it was (as Mail's page does): the open
 * conversation, the filter, the search, where the list and each
 * conversation were scrolled, and what he typed in each. The places are kept
 * outside React, so a scroll re-renders nothing; the words wake only the
 * composer that reads them.
 */

export interface MessagesPage {
  chatId: string | null;
  filter: ChatFilter;
  query: string;
}

const BLANK: MessagesPage = { chatId: null, filter: "all", query: "" };
const pages = new Map<string, MessagesPage>();
const listeners = new Set<() => void>();

export const pageOf = (workspaceId: string): MessagesPage => pages.get(workspaceId) ?? BLANK;

/** Changes what a workspace's Messages shows. The preview sets its scenes through it. */
export function patchPage(workspaceId: string, next: Partial<MessagesPage>): void {
  pages.set(workspaceId, { ...pageOf(workspaceId), ...next });
  for (const listener of listeners) listener();
}

export function usePage(workspaceId: string): MessagesPage {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => pageOf(workspaceId),
    () => pageOf(workspaceId),
  );
}

// ── Kept without a render ──

const listTops = new Map<string, number>();
/** Where a conversation was scrolled when he left it: a block and how far up from its foot; none at the foot. */
const places = new Map<string, RowAnchor>();
const typed = new Map<string, string>();
/** Whose words the field holds: the draft they came from, kept beside the words. */
const typedFrom = new Map<string, string>();
const key = (workspaceId: string, chatId: string): string => `${workspaceId}\u0000${chatId}`;

/** Where the list was scrolled, each filter its own place. */
export const listTopOf = (workspaceId: string, filter: ChatFilter): number => listTops.get(`${workspaceId}\u0000${filter}`) ?? 0;
export const keepListTop = (workspaceId: string, filter: ChatFilter, top: number): void => void listTops.set(`${workspaceId}\u0000${filter}`, top);

/**
 * Where the list's keys stood when a conversation opened from it: the row (or,
 * in a search, the hit) and its place in the list. Under 640px Back hands the
 * keys back there; a row gone meanwhile gives way to the one now in its place.
 */
export interface ReturnTarget {
  chatId: string;
  index: number;
  hit?: string;
}
const opened = new Map<string, ReturnTarget>();
const returns = new Map<string, ReturnTarget>();
/** Notes where a conversation was opened from. */
export const openedFrom = (workspaceId: string, target: ReturnTarget): void => void opened.set(workspaceId, target);
/** He came back: the list, mounting again, takes the keys where they stood. */
export function returnTo(workspaceId: string, chatId: string): void {
  const from = opened.get(workspaceId);
  returns.set(workspaceId, from?.chatId === chatId ? from : { chatId, index: 0 });
}
/** Comes back to the list's first row: a list mounting afresh (Clear filter) takes the keys there. */
export const returnToTop = (workspaceId: string): void => void returns.set(workspaceId, { chatId: "", index: 0 });
/** Where to stand, if he just came back, left in place for whatever can take the keys (a failed list's Retry only looks). */
export const peekReturn = (workspaceId: string): ReturnTarget | undefined => returns.get(workspaceId);
/** Taken once: where to stand, if he just came back. */
export function takeReturn(workspaceId: string): ReturnTarget | undefined {
  const target = returns.get(workspaceId);
  returns.delete(workspaceId);
  return target;
}

export const placeOf = (workspaceId: string, chatId: string): RowAnchor | undefined => places.get(key(workspaceId, chatId));
export function keepPlace(workspaceId: string, chatId: string, anchor: RowAnchor | null): void {
  if (anchor) places.set(key(workspaceId, chatId), anchor);
  else places.delete(key(workspaceId, chatId));
  visitPlaces.set(key(workspaceId, chatId), anchor);
}
/** Where he stood in this visit (null at the foot), if he has moved in it: a remount (Retry) puts him back there. */
const visitPlaces = new Map<string, RowAnchor | null>();
export const visitPlaceOf = (workspaceId: string, chatId: string): RowAnchor | null | undefined => visitPlaces.get(key(workspaceId, chatId));

/** What he typed in a conversation and has not sent; the composer reads it back. */
export const typedIn = (workspaceId: string, chatId: string): string => typed.get(key(workspaceId, chatId)) ?? "";
/** The draft whose words the field holds (or his edit of them), if they came from one; else they are his own. */
export const typedFromDraft = (workspaceId: string, chatId: string): string | null => typedFrom.get(key(workspaceId, chatId)) ?? null;
/**
 * The field's revision: moved on by every change of its words, so a press that settles later can tell the field it
 * left from one that only reads the same (cleared and the same words typed again as his own).
 */
const typedRevs = new Map<string, number>();
export const typedRev = (workspaceId: string, chatId: string): number => typedRevs.get(key(workspaceId, chatId)) ?? 0;
/**
 * The field as a press found it: its words, whose they are and its revision. Every step that awaits (Send, Discard,
 * Copy's cleanup, Undo and the draft save inside it) takes this before it awaits and judges by it after: the field is
 * the pressed one only while its revision stands (`stillPressed`), whatever words it holds.
 */
export interface PressedField {
  text: string;
  from: string | null;
  rev: number;
}
export const fieldAsPressed = (workspaceId: string, chatId: string): PressedField => ({ text: typedIn(workspaceId, chatId), from: typedFromDraft(workspaceId, chatId), rev: typedRev(workspaceId, chatId) });
export const stillPressed = (workspaceId: string, chatId: string, pressed: PressedField): boolean => typedRev(workspaceId, chatId) === pressed.rev;
const typedListeners = new Set<() => void>();
/**
 * Keeps the field's words. `from` says whose they are: a draft's id, null for
 * his own, or left out to keep what was said before (an edit of a draft's words
 * stays the draft's). An empty field belongs to no one.
 */
export function keepTyped(workspaceId: string, chatId: string, text: string, from?: string | null): void {
  const at = key(workspaceId, chatId);
  typedRevs.set(at, (typedRevs.get(at) ?? 0) + 1);
  if (text) typed.set(at, text);
  else typed.delete(at);
  if (!text || from === null) typedFrom.delete(at);
  else if (from !== undefined) typedFrom.set(at, from);
  for (const listener of typedListeners) listener();
}
/** What he typed in one conversation, live: an Undo puts a reply's words back here. */
export function useTypedFrom(workspaceId: string, chatId: string): string | null {
  return useSyncExternalStore(
    (fn) => {
      typedListeners.add(fn);
      return () => void typedListeners.delete(fn);
    },
    () => typedFromDraft(workspaceId, chatId),
    () => typedFromDraft(workspaceId, chatId),
  );
}
export function useTyped(workspaceId: string, chatId: string): string {
  return useSyncExternalStore(
    (fn) => {
      typedListeners.add(fn);
      return () => void typedListeners.delete(fn);
    },
    () => typedIn(workspaceId, chatId),
    () => typedIn(workspaceId, chatId),
  );
}

/**
 * The revision at which a draft's words filled an empty field (on arrival, or by Use draft into an empty one). While the
 * field still stands at it, its words are the draft's untouched: once that draft leaves the Outbox's list elsewhere (sent
 * or discarded in another window), they go with it rather than stand as his own for a second Send.
 */
const filledRevs = new Map<string, number>();
export const markFilled = (workspaceId: string, chatId: string): void => void filledRevs.set(key(workspaceId, chatId), typedRev(workspaceId, chatId));
export const filledUntouched = (workspaceId: string, chatId: string): boolean => filledRevs.get(key(workspaceId, chatId)) === typedRev(workspaceId, chatId);

/**
 * His own words kept aside, out of the field, until he puts them back (Use words): a Send that may have gone (the host's
 * answer was lost, or LifeOS failed past a refusal, so it may have queued them), and Undo's words recalled while a draft
 * in the field was sending elsewhere. Each press is its own part, so a second lost Send never writes over the first.
 * An unsure part goes once his reply with those words shows in the conversation (it went; `settleAside`), else only by
 * Use words: a later Send of his own does not drop them.
 */
export interface AsidePart {
  text: string;
  /** a Send that may have gone, as against words Undo recalled */
  unsure: boolean;
  /** when it was kept aside, on the view's clock */
  at: number;
}
const aside = new Map<string, readonly AsidePart[]>();
const NO_ASIDE: readonly AsidePart[] = [];
const asideListeners = new Set<() => void>();
const setAside = (at: string, parts: readonly AsidePart[]): void => {
  if (parts.length) aside.set(at, parts);
  else if (!aside.delete(at)) return;
  for (const listener of asideListeners) listener();
};
export const asideOf = (workspaceId: string, chatId: string): readonly AsidePart[] => aside.get(key(workspaceId, chatId)) ?? NO_ASIDE;
export const keepAside = (workspaceId: string, chatId: string, part: AsidePart): void => setAside(key(workspaceId, chatId), [...asideOf(workspaceId, chatId), part]);
/** His Send that may have gone, its words kept aside. */
export const keepUnsure = (workspaceId: string, chatId: string, words: string, at: number): void => keepAside(workspaceId, chatId, { text: words, unsure: true, at });
/** Every part, oldest first, joined a line apart, and let go: Use words. */
export function takeAside(workspaceId: string, chatId: string): string {
  const words = asideOf(workspaceId, chatId)
    .map((part) => part.text)
    .join("\n");
  setAside(key(workspaceId, chatId), NO_ASIDE);
  return words;
}
/** The clock may run a little apart between the view and LifeOS: a reply this much older than its part still counts. */
const ASIDE_SLACK_MS = 120_000;
/**
 * Drops each unsure part whose words now show as his own message in the conversation, sent no earlier than the part was
 * kept: LifeOS took that Send, so the words are there and need no second press. Undo's words that match go the same way.
 */
export function settleAside(workspaceId: string, chatId: string, mine: readonly { text: string; sentAt: number }[]): void {
  const parts = asideOf(workspaceId, chatId);
  if (!parts.length) return;
  const left = parts.filter((part) => !part.unsure || !mine.some((m) => m.text.trim() === part.text.trim() && m.sentAt >= part.at - ASIDE_SLACK_MS));
  if (left.length !== parts.length) setAside(key(workspaceId, chatId), left);
}
/** Undo put these words back in the field: an unsure part of the same words is that very reply, and goes. */
export function dropAsideWords(workspaceId: string, chatId: string, words: string): void {
  const parts = asideOf(workspaceId, chatId);
  const left = parts.filter((part) => !(part.unsure && part.text.trim() === words.trim()));
  if (left.length !== parts.length) setAside(key(workspaceId, chatId), left);
}
export function useAside(workspaceId: string, chatId: string): readonly AsidePart[] {
  return useSyncExternalStore(
    (fn) => {
      asideListeners.add(fn);
      return () => void asideListeners.delete(fn);
    },
    () => asideOf(workspaceId, chatId),
    () => asideOf(workspaceId, chatId),
  );
}

/**
 * The draft the field's words came from, as the list last showed it, and whether the host has said it ended. The
 * Outbox's list is capped, so a draft still held can leave it: its words stay the draft's (`originOf`, drafts.ts) until
 * the host, asked by the draft's id, says it was sent, discarded or went stale (`endDraft`).
 */
const fieldDrafts = new Map<string, ThreadDraftLike>();
const endedDrafts = new Map<string, string>();
const endListeners = new Set<() => void>();
type ThreadDraftLike = { id: string; held: boolean; text: string; threadId: string | null; thread?: string };
export const rememberDraft = (workspaceId: string, chatId: string, draft: ThreadDraftLike): void => void fieldDrafts.set(key(workspaceId, chatId), draft);
export function rememberedDraft<T extends ThreadDraftLike>(workspaceId: string, chatId: string, id: string): T | undefined {
  const draft = fieldDrafts.get(key(workspaceId, chatId));
  return draft?.id === id ? (draft as T) : undefined;
}
export const draftEnded = (workspaceId: string, chatId: string, id: string): boolean => endedDrafts.get(key(workspaceId, chatId)) === id;
export function endDraft(workspaceId: string, chatId: string, id: string): void {
  endedDrafts.set(key(workspaceId, chatId), id);
  for (const listener of endListeners) listener();
}
export function useDraftEnded(workspaceId: string, chatId: string, id: string | null): boolean {
  return useSyncExternalStore(
    (fn) => {
      endListeners.add(fn);
      return () => void endListeners.delete(fn);
    },
    () => (id ? draftEnded(workspaceId, chatId, id) : false),
    () => (id ? draftEnded(workspaceId, chatId, id) : false),
  );
}

/** A send LifeOS refused, in its words, kept with the conversation until he types or sends again. */
const refusals = new Map<string, string>();
const refusalListeners = new Set<() => void>();
export function keepRefusal(workspaceId: string, chatId: string, words: string | null): void {
  if (words) refusals.set(key(workspaceId, chatId), words);
  else if (!refusals.delete(key(workspaceId, chatId))) return;
  for (const listener of refusalListeners) listener();
}
export function useRefusal(workspaceId: string, chatId: string): string | null {
  return useSyncExternalStore(
    (fn) => {
      refusalListeners.add(fn);
      return () => void refusalListeners.delete(fn);
    },
    () => refusals.get(key(workspaceId, chatId)) ?? null,
    () => refusals.get(key(workspaceId, chatId)) ?? null,
  );
}

/**
 * Where "New" sat when a conversation opened, kept for the visit: a Retry or a
 * remount finds the same line, and leaving the conversation ends the visit.
 */
const visits = new Map<string, number | null>();
export const visitSince = (workspaceId: string, chatId: string): number | null | undefined => visits.get(key(workspaceId, chatId));
export const keepVisitSince = (workspaceId: string, chatId: string, since: number | null): void => void visits.set(key(workspaceId, chatId), since);
/** His deliberate unread mark, kept with the visit: the newest message from someone else when he set it. */
const unreadHeld = new Map<string, number>();
export const heldUnread = (workspaceId: string, chatId: string): number | undefined => unreadHeld.get(key(workspaceId, chatId));
export const holdUnread = (workspaceId: string, chatId: string, lastIn: number): void => void unreadHeld.set(key(workspaceId, chatId), lastIn);
export const releaseUnread = (workspaceId: string, chatId: string): void => void unreadHeld.delete(key(workspaceId, chatId));
/**
 * His Mark unread, held from the command itself (not from LifeOS's answer, which may come after a remount): only on the
 * conversation he has open, whose visit would otherwise mark it read again. A refused write lets the hold go.
 */
export function markUnreadHeld(markUnread: (chatId: string, onFailed?: () => void) => void, workspaceId: string, row: { _id: string; lastInAt?: number }, open: boolean): void {
  if (open) holdUnread(workspaceId, row._id, row.lastInAt ?? 0);
  markUnread(row._id, open ? () => releaseUnread(workspaceId, row._id) : undefined);
}
export function endVisit(workspaceId: string, chatId: string): void {
  visits.delete(key(workspaceId, chatId));
  if (fileWants.delete(key(workspaceId, chatId))) tellWants();
  visitPlaces.delete(key(workspaceId, chatId));
  unreadHeld.delete(key(workspaceId, chatId));
}

/**
 * The conversation's gate: one at a time, every composer action that waits on the host and then touches the field, the
 * draft marks or the refusal holds it (his own Send until LifeOS answers, a held draft's press, Discard, Copy's drop of a
 * copy-only draft, and Undo's placement of the recalled words). While it is held nothing else may start (the composer
 * disables Send, Discard and Copy and ignores Return); Undo's placement, which he did not start from the composer, queues
 * behind the holder instead. The record says who holds it, and for a held press which draft, so the line can name it
 * whatever the live list says meanwhile.
 */
export interface GateDraft {
  id: string;
  text: string;
  threadId: string | null;
  thread?: string;
}
export type Gate = { kind: "send"; text: string } | { kind: "press"; text: string; draft: GateDraft } | { kind: "discard"; draft: GateDraft } | { kind: "drop" } | { kind: "undo" };
const gates = new Map<string, Gate>();
/** The end of each conversation's queue: a step waits for it before it holds the gate. */
const tails = new Map<string, Promise<void>>();
const gateListeners = new Set<() => void>();
const tellGate = (): void => {
  for (const listener of gateListeners) listener();
};
export const gateOf = (workspaceId: string, chatId: string): Gate | undefined => gates.get(key(workspaceId, chatId));
/** Kept for its readers: the gate's record while his Send (or any action) is on its way. */
export const pendingPress = gateOf;
function hold<T>(at: string, gate: Gate, step: () => Promise<T>): Promise<T> {
  const before = tails.get(at);
  let free!: () => void;
  const mine = new Promise<void>((resolve) => (free = resolve));
  const tail = (before ?? Promise.resolve()).then(() => mine);
  tails.set(at, tail);
  // Free, it is held at once (the record is there before the press returns); else once the holder before it lets go.
  const run = async (): Promise<T> => {
    gates.set(at, gate);
    tellGate();
    try {
      return await step();
    } finally {
      gates.delete(at);
      if (tails.get(at) === tail) tails.delete(at);
      free();
      tellGate();
    }
  };
  return before ? before.then(run) : run();
}
/** Whether nothing holds the gate or waits for it. */
export const gateFree = (workspaceId: string, chatId: string): boolean => !gates.has(key(workspaceId, chatId)) && !tails.has(key(workspaceId, chatId));
/** Starts a step holding the gate, or nothing (null) when another holds it or waits for it: nothing starts while one runs. */
export function startGated<T>(workspaceId: string, chatId: string, gate: Gate, step: () => Promise<T>): Promise<T> | null {
  const at = key(workspaceId, chatId);
  if (gates.has(at) || tails.has(at)) return null;
  return hold(at, gate, step);
}
/** Runs a step holding the gate once whoever holds it now has finished (Undo's placement): one wait point, the queue. */
export function runGated<T>(workspaceId: string, chatId: string, gate: Gate, step: () => Promise<T>): Promise<T> {
  return hold(key(workspaceId, chatId), gate, step);
}
export function useGate(workspaceId: string, chatId: string): Gate | undefined {
  return useSyncExternalStore(
    (fn) => {
      gateListeners.add(fn);
      return () => void gateListeners.delete(fn);
    },
    () => gateOf(workspaceId, chatId),
    () => gateOf(workspaceId, chatId),
  );
}

/**
 * What became of a thread's draft here before the Outbox's own list says so: settled (pressed and gone, or discarded)
 * and not to be offered again, or failed with LifeOS's reason. Kept per conversation until the list itself drops the
 * draft (or lists it failed), so no mount, Retry or 640px crossing offers it again in the meantime.
 */
export type DraftMark = { settled: true } | { failed: string; unknown?: boolean };
const draftMarks = new Map<string, ReadonlyMap<string, DraftMark>>();
const NO_MARKS: ReadonlyMap<string, DraftMark> = new Map();
const markListeners = new Set<() => void>();
export const draftMarksOf = (workspaceId: string, chatId: string): ReadonlyMap<string, DraftMark> => draftMarks.get(key(workspaceId, chatId)) ?? NO_MARKS;
export function markDraft(workspaceId: string, chatId: string, draftId: string, mark: DraftMark | null): void {
  const at = key(workspaceId, chatId);
  const next = new Map(draftMarks.get(at) ?? NO_MARKS);
  if (mark) next.set(draftId, mark);
  else if (!next.delete(draftId)) return;
  if (next.size) draftMarks.set(at, next);
  else draftMarks.delete(at);
  for (const listener of markListeners) listener();
}
export function useDraftMarks(workspaceId: string, chatId: string): ReadonlyMap<string, DraftMark> {
  return useSyncExternalStore(
    (fn) => {
      markListeners.add(fn);
      return () => void markListeners.delete(fn);
    },
    () => draftMarksOf(workspaceId, chatId),
    () => draftMarksOf(workspaceId, chatId),
  );
}

/**
 * The drafts a conversation's composer has already met, while the window lives: only one it has not met fills an empty
 * field. Kept with the conversation, not the composer's mount, so a remount (leaving and coming back, a Retry) never
 * puts back a draft he already saw and pushed aside.
 */
const seenDrafts = new Map<string, Set<string>>();
export const draftSeen = (workspaceId: string, chatId: string, draftId: string): boolean => seenDrafts.get(key(workspaceId, chatId))?.has(draftId) ?? false;
export function seeDraft(workspaceId: string, chatId: string, draftId: string): void {
  const at = key(workspaceId, chatId);
  const seen = seenDrafts.get(at) ?? new Set<string>();
  seen.add(draftId);
  seenDrafts.set(at, seen);
}

/**
 * The held reply whose press from this composer failed last (or may have gone): it owns the composer's line over any
 * other draft waiting, with its Open in Outbox, until he opens it there or the Outbox's state for it changes.
 */
const failedPresses = new Map<string, string>();
const failedListeners = new Set<() => void>();
export function keepFailedPress(workspaceId: string, chatId: string, draftId: string | null): void {
  if (draftId) failedPresses.set(key(workspaceId, chatId), draftId);
  else if (!failedPresses.delete(key(workspaceId, chatId))) return;
  for (const listener of failedListeners) listener();
}
export function useFailedPress(workspaceId: string, chatId: string): string | null {
  return useSyncExternalStore(
    (fn) => {
      failedListeners.add(fn);
      return () => void failedListeners.delete(fn);
    },
    () => failedPresses.get(key(workspaceId, chatId)) ?? null,
    () => failedPresses.get(key(workspaceId, chatId)) ?? null,
  );
}

/**
 * Files he asked to open before their bytes came, by message and file, kept with the conversation's visit rather
 * than in a chip, so the ask settles once (opened when the file is stored, dropped when it fails) even when its
 * message has scrolled out of the column's window. Leaving the conversation lets them go.
 */
export interface FileWant {
  messageId: string;
  fileId: string;
  /** The file as it was asked for (its name and type), for an open made after its message left the loaded page. */
  file?: ChatFile;
}
const fileWants = new Map<string, readonly FileWant[]>();
const NO_WANTS: readonly FileWant[] = [];
const wantListeners = new Set<() => void>();
const tellWants = (): void => {
  for (const listener of wantListeners) listener();
};
export const fileWantsOf = (workspaceId: string, chatId: string): readonly FileWant[] => fileWants.get(key(workspaceId, chatId)) ?? NO_WANTS;
export function wantFile(workspaceId: string, chatId: string, want: FileWant): void {
  const now = fileWantsOf(workspaceId, chatId);
  if (now.some((w) => w.messageId === want.messageId && w.fileId === want.fileId)) return;
  fileWants.set(key(workspaceId, chatId), [...now, want]);
  tellWants();
}
export function settleFile(workspaceId: string, chatId: string, want: FileWant): void {
  const left = fileWantsOf(workspaceId, chatId).filter((w) => !(w.messageId === want.messageId && w.fileId === want.fileId));
  if (left.length) fileWants.set(key(workspaceId, chatId), left);
  else fileWants.delete(key(workspaceId, chatId));
  tellWants();
}
export function useFileWants(workspaceId: string, chatId: string): readonly FileWant[] {
  return useSyncExternalStore(
    (fn) => {
      wantListeners.add(fn);
      return () => void wantListeners.delete(fn);
    },
    () => fileWantsOf(workspaceId, chatId),
    () => fileWantsOf(workspaceId, chatId),
  );
}

// ── A message to bring into view ──

/** A message asked for from elsewhere (a search hit, a sent chip, a tell): held until the conversation has shown it once. */
const wanted = new Map<string, { chatId: string; messageId: string }>();
const wantedListeners = new Set<() => void>();
const tellWanted = (): void => {
  for (const listener of wantedListeners) listener();
};

/** Opens a conversation on one of its messages. */
export function wantMessage(workspaceId: string, chatId: string, messageId: string): void {
  wanted.set(workspaceId, { chatId, messageId });
  patchPage(workspaceId, { chatId });
  tellWanted();
}
/** The message a conversation is asked to bring into view, if any. */
export function useWanted(workspaceId: string, chatId: string): string | null {
  return useSyncExternalStore(
    (fn) => {
      wantedListeners.add(fn);
      return () => void wantedListeners.delete(fn);
    },
    () => {
      const want = wanted.get(workspaceId);
      return want?.chatId === chatId ? want.messageId : null;
    },
  );
}
/** Done with it: shown, or not to be found. */
export function dropWanted(workspaceId: string): void {
  if (wanted.delete(workspaceId)) tellWanted();
}

/** Test seam: every workspace back to blank. */
export function resetPages(): void {
  pages.clear();
  listTops.clear();
  places.clear();
  typed.clear();
  typedFrom.clear();
  typedRevs.clear();
  filledRevs.clear();
  aside.clear();
  fieldDrafts.clear();
  endedDrafts.clear();
  draftMarks.clear();
  visits.clear();
  fileWants.clear();
  failedPresses.clear();
  seenDrafts.clear();
  visitPlaces.clear();
  unreadHeld.clear();
  gates.clear();
  tails.clear();
  opened.clear();
  wanted.clear();
  returns.clear();
  refusals.clear();
  for (const listener of listeners) listener();
}
