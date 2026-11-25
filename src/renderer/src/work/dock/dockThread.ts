import type { ContextChip } from "@shared/work";
import type { Session } from "../../lib/session";
import { chipPort } from "../../lib/contextChips";
import { afterCreate, type CreateFold } from "../../lib/tcserver/commands";
import { draftPicks, dockDraftKey, projectDrafts, sessionFromDraft } from "../../lib/projectDrafts";
import { sessionStore } from "../../lib/tcserver/store";
import { workDockPort } from "../../lib/workSwitch";
import { aboutFor, addContextChip, contextChipsOf, setSendChips, swapContextChip } from "../canvas/chips";
import type { DockSubject } from "./subject";

/**
 * Which chat a dock shows, and its draft until he sends (docs/agents/work-files.md "Ask"). Opening a dock makes no
 * thread: it shows the thread it showed for this subject this run, else the subject's thread from before (`find`),
 * else a draft that is on no host and in no rail. The draft keeps a record of its own by the subject's key
 * (lib/projectDrafts.ts `dockDraftKey`), so his words come back after a quit and a launch. A draft becomes a thread by the composer's own send; in that send,
 * between the create and the message, the subject's `hold` runs (`afterCreate`). A dock closed with nothing sent
 * leaves nothing behind. Nothing here knows what the subject is.
 */

/** The workspace a dock's draft is made in. */
export type DockWorkspace = { id: string; environmentId: string; path: string };

/** What a subject's dock showed this run, by `subject.key`: a draft's id (its composer keeps what he typed) or the thread it became. */
const shown = new Map<string, string>();

/** The thread a dock shows: a thread of the host's, or a draft not made yet. */
export interface DockThread {
  id: string;
  draft: boolean;
}

/**
 * What the dock shows the moment it opens, with no ask of any host: the thread it showed before for this subject,
 * while that is a live thread; else a draft (the one from before, so what he typed is still there). Safe to call while
 * drawing: the draft is only planned here, and `enterDock` puts it in the store in the commit that draws it. The
 * subject's thread from before, if any, comes later (`findThread`), and the dock shows it only while the draft is empty.
 */
export function dockThreadNow(workspace: DockWorkspace, subject: DockSubject): DockThread {
  const known = shown.get(subject.key);
  const meta = known ? sessionStore.metaOf(known) : null;
  if (known && meta && !meta.archived) return { id: known, draft: false };
  // A thread from before that is now archived is not reopened as a draft: a new draft takes its place.
  const id = planDraft(workspace, subject, known && !meta ? known : undefined);
  shown.set(subject.key, id);
  return { id, draft: true };
}

/** Most subjects whose `find` is kept; past it the oldest is asked again next time. */
export const FOUND_KEPT = 200;
/** Each subject's `find`, asked once a run (a failed one is asked again): its tab shown again asks the host nothing. */
const found = new Map<string, Promise<string | null>>();

/**
 * The subject's thread from before, asked of its host once a run. A thread kept here that he archived since, or that
 * this window no longer knows as live, is no answer.
 */
export async function findThread(subject: DockSubject): Promise<string | null> {
  let asked = found.get(subject.key);
  if (!asked) {
    asked = subject.find();
    found.set(subject.key, asked);
    if (found.size > FOUND_KEPT) found.delete(found.keys().next().value!);
    asked.catch(() => {
      if (found.get(subject.key) === asked) found.delete(subject.key);
    });
  }
  const held = await asked;
  const meta = held ? sessionStore.metaOf(held) : null;
  return held && !meta?.archived ? held : null;
}

/** The dock shows the subject's thread from before in its draft's place (the draft was empty). */
export function showFound(subjectKey: string, id: string): void {
  shown.set(subjectKey, id);
}

/**
 * Which thread the subject's dock shows, settled: the one it showed before, while it is a live thread; else the
 * subject's thread from before; else a draft, in the store. (The dock draws `dockThreadNow` at once instead.)
 */
export async function dockThread(workspace: DockWorkspace, subject: DockSubject): Promise<DockThread> {
  const now = dockThreadNow(workspace, subject);
  if (!now.draft) return now;
  const held = await findThread(subject);
  if (held) {
    shown.set(subject.key, held);
    return { id: held, draft: false };
  }
  keepDraft(now.id);
  sessionStore.mutate((prev) => [...prev.filter((s) => s.id !== now.id), drafts.get(now.id)!.session]);
  putChips(now.id);
  return now;
}

/** The planned draft of `id`, before the store has it: what the dock's first commit draws its composer from. */
export function plannedDraft(id: string): Session | undefined {
  return drafts.get(id)?.session;
}

/** The drafts the docks made this run: the session to put back in the open set, its subject's chips, and its first send's step. */
const drafts = new Map<
  string,
  {
    /** the subject's key, for its record */
    key: string;
    seed: DockSubject["seed"];
    session: Session;
    chips: readonly ContextChip[];
    chipIn: DockSubject["chipIn"];
    hold: () => Promise<void>;
    must: boolean;
    fold?: () => CreateFold;
    onItemsFailed?: DockSubject["onItemsFailed"];
  }
>();
/** Drafts whose composer has held the subject's lead chip, and those he took it off: a chip he took off is not put back. */
const chipSeen = new Set<string>();
const chipTaken = new Set<string>();

const sameChip = (a: ContextChip, b: ContextChip): boolean => a.kind === b.kind && JSON.stringify(a.ref) === JSON.stringify(b.ref);

/**
 * Follows each composer draft's lead chip as he changes it. The chip gone from a composer that still has a draft is
 * his doing, unless the composer is sending: a send takes every chip at once and keeps the first for the create
 * (`aboutFor`), and then the chip went with the message.
 */
function heedChips(): void {
  for (const [id, draft] of drafts) {
    const lead = draft.chips[0];
    if (draft.chipIn !== "composer" || !lead || chipTaken.has(id) || !sessionStore.isDraft(id)) continue;
    const have = contextChipsOf(id);
    if (have.some((c) => sameChip(c, lead))) chipSeen.add(id);
    else if (chipSeen.has(id) && !(have.length === 0 && aboutFor(id))) chipTaken.add(id);
  }
}
let heeding = false;

/**
 * A draft for the subject, planned: its session made and its first send's step set here, nothing written yet. The
 * draft goes in the store's open set (no host has it, so no rail lists it) and its record is kept when the dock
 * enters it (`enterDock`, `keepDraft`), in the commit that draws it. Planned twice (a redraw), it is the same draft.
 */
function planDraft(workspace: DockWorkspace, subject: DockSubject, again: string | undefined): string {
  const planned = again ? drafts.get(again) : undefined;
  if (planned && planned.key === subject.key && !sessionStore.get(again!)) return again!;
  const port = workDockPort.get();
  if (!port) throw new Error("This window cannot start a chat here");
  // The draft from before as it last stood (his picks kept); else the one a launch before kept for the subject, rebuilt
  // with its id so the composer finds its words; else a new one seeded as New thread seeds one.
  const key = dockDraftKey(subject.key);
  const record = projectDrafts.get(key);
  const kept = again ? sessionStore.get(again) : undefined;
  const remembered = !kept && record && (!again || record.id === again) && !sessionStore.metaOf(record.id) ? sessionFromDraft(record, null) : undefined;
  const made = kept ?? remembered ?? port.draft(workspace, again);
  const session = subject.seed && !kept ? subject.seed(made) : made;
  drafts.set(session.id, { key: subject.key, seed: subject.seed, session, chipIn: subject.chipIn, ...stepsOf(session.id, subject) });
  return session.id;
}

/** A draft's chips and first-send step, from its subject. */
function stepsOf(id: string, subject: DockSubject): { chips: readonly ContextChip[]; hold: () => Promise<void>; must: boolean; fold?: () => CreateFold; onItemsFailed?: DockSubject["onItemsFailed"] } {
  const { hold } = subject;
  // A composer's hold runs only while its lead chip is still on the composer: he took it off, so the thread is not about it.
  const run = (): Promise<void> => (!hold || chipTaken.has(id) ? Promise.resolve() : hold(id));
  // The same step as data, under the same rule, for a host that runs it inside the create.
  const fold = subject.fold ? (): CreateFold => (chipTaken.has(id) ? {} : subject.fold!()) : undefined;
  return { chips: subject.chips, hold: run, must: !!subject.mustHold, fold, onItemsFailed: subject.onItemsFailed };
}

/**
 * The subject under its key is about another thing now (Keep Both moved a file tab to the copy it made): its draft
 * keeps what he typed and takes the subject's chips and first-send step, so the first send names and opens the file
 * the tab shows. The lead chip in its composer is swapped where it sits, unless he took it off; the subject's thread
 * from before is asked again. A draft already sent, or a thread, is left as it is.
 */
export function rebindDock(subject: DockSubject): void {
  for (const [id, draft] of drafts) {
    if (draft.key !== subject.key || !sessionStore.isDraft(id) || sessionStore.isProvisional(id)) continue;
    const was = draft.chips[0];
    const lead = subject.chips[0];
    if (was && lead ? sameChip(was, lead) : was === lead) continue;
    const next = { ...draft, ...stepsOf(id, subject) };
    drafts.set(id, next);
    found.delete(subject.key);
    if (draft.chipIn === "send") setSendChips(id, next.chips);
    else if (was && lead && !chipTaken.has(id)) swapContextChip(id, was, lead);
    if (sessionStore.shownApart().has(id)) afterCreate.set(id, next.hold, { must: next.must, fold: next.fold, onItemsFailed: next.onItemsFailed });
  }
}

/** A planned draft's record and rule, written once the dock draws it. */
function keepDraft(id: string): void {
  const draft = drafts.get(id);
  if (!draft) return;
  if (!heeding) {
    heeding = true;
    chipPort.subscribe(heedChips);
  }
  const key = dockDraftKey(draft.key);
  // The subject's own record, never the workspace's draft: what he types here comes back after a launch, here alone.
  if (projectDrafts.get(key)?.id !== id) projectDrafts.put(key, { ...draftPicks(draft.session), segments: [], attachments: [] });
  // The seed holds after his defaults land too (sessionStore.reseedDrafts): a mail chat's draft never becomes Muse.
  if (draft.seed) sessionStore.keepDraftRule(id, draft.seed);
}

/**
 * Whether the draft holds nothing of his: no row sent, and no words or files in its composer (`composer`, the input on
 * screen, else its kept record). Only then may the dock show the subject's thread from before in its place.
 */
export function draftIsEmpty(id: string, composer: Element | null | undefined): boolean {
  if (!sessionStore.isDraft(id) || sessionStore.isProvisional(id) || (sessionStore.get(id)?.blocks.length ?? 0) > 0) return false;
  if (composer?.textContent?.trim()) return false;
  const draft = drafts.get(id);
  const record = draft ? projectDrafts.get(dockDraftKey(draft.key)) : undefined;
  if (!record || record.id !== id) return true;
  return record.attachments.length === 0 && record.segments.every((s) => "text" in s && !s.text.trim());
}

/** The subject's chips on a draft: in its composer unless he took the lead off, or held for its first send. */
function putChips(id: string): void {
  const draft = drafts.get(id);
  if (!draft) return;
  if (draft.chipIn === "send") return setSendChips(id, draft.chips);
  if (chipTaken.has(id)) return;
  for (const chip of draft.chips) addContextChip(id, chip);
}

/**
 * The dock shows `id`, and tells the store so (`showApart`): a dock is no pane and no tab, and the store then holds its
 * chat as a mounted pane's, its transcript loaded and replayed on a reconnect, and the idle sweep leaves it in the
 * open set (a chat out of the open set takes no send and no pick). A draft goes into the open set (as it last stood there, its picks
 * kept), its subject's chips are put on it (each time it is shown, unless he took them off), and its first send's
 * step is set. A thread the store holds is opened too.
 */
export function enterDock(id: string): void {
  sessionStore.showApart(id, true);
  const draft = drafts.get(id);
  if (!draft || !sessionStore.isDraft(id) || sessionStore.isProvisional(id)) {
    sessionStore.openForSend(id);
    return;
  }
  keepDraft(id);
  if (!sessionStore.isOpen(id)) {
    const session = sessionStore.get(id) ?? draft.session;
    sessionStore.mutate((prev) => [...prev.filter((s) => s.id !== id), session]);
    // Out of the open set it heard no defaults land: it takes them now.
    sessionStore.reseedDrafts();
  }
  putChips(id);
  afterCreate.set(id, draft.hold, { must: draft.must, fold: draft.fold, onItemsFailed: draft.onItemsFailed });
}

/**
 * The dock let go of what it showed. A draft he sent nothing in leaves the open set (it was never on a host) and its
 * step is cleared; its composer's words and chips stay with its id, for the next time the subject's dock opens this
 * run (`enterDock` puts it back). A draft whose first send is under way is left to it.
 */
export function leaveDock(id: string): void {
  sessionStore.showApart(id, false);
  if (!sessionStore.isDraft(id) || sessionStore.isProvisional(id)) return;
  if ((sessionStore.get(id)?.blocks.length ?? 0) > 0) return;
  afterCreate.clear(id);
  setSendChips(id, null);
  sessionStore.mutate((prev) => prev.filter((s) => s.id !== id));
}

/** Test seam: forget what the docks showed. */
export function resetDocks(): void {
  shown.clear();
  found.clear();
  drafts.clear();
  chipSeen.clear();
  chipTaken.clear();
  for (const id of sessionStore.shownApart()) sessionStore.showApart(id, false);
}
