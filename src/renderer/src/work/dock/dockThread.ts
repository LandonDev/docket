import type { ContextChip } from "@shared/work";
import type { Session } from "../../lib/session";
import { chipPort } from "../../lib/contextChips";
import { afterCreate } from "../../lib/tcserver/commands";
import { sessionStore } from "../../lib/tcserver/store";
import { workDockPort } from "../../lib/workSwitch";
import { aboutFor, addContextChip, contextChipsOf, setSendChips } from "../canvas/chips";
import type { DockSubject } from "./subject";

/**
 * Which chat a dock shows, and its draft until he sends (docs/agents/work-files.md "Ask"). Opening a dock makes no
 * thread: it shows the thread it showed for this subject this run, else the subject's thread from before (`find`),
 * else a draft that is on no host and in no rail. A draft becomes a thread by the composer's own send; in that send,
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
 * Which thread the subject's dock shows: the one it showed before, while it is a live thread; else the subject's
 * thread from before; else a draft (the one from before, so what he typed is still there).
 */
export async function dockThread(workspace: DockWorkspace, subject: DockSubject): Promise<DockThread> {
  const known = shown.get(subject.key);
  const meta = known ? sessionStore.metaOf(known) : null;
  if (known && meta && !meta.archived) return { id: known, draft: false };
  const held = await subject.find();
  if (held) {
    shown.set(subject.key, held);
    return { id: held, draft: false };
  }
  // A thread from before that is now archived is not reopened as a draft: a new draft takes its place.
  const id = draftFor(workspace, subject, known && !meta ? known : undefined);
  shown.set(subject.key, id);
  return { id, draft: true };
}

/** The drafts the docks made this run: the session to put back in the open set, its subject's chips, and its first send's step. */
const drafts = new Map<string, { session: Session; chips: readonly ContextChip[]; chipIn: DockSubject["chipIn"]; hold: () => Promise<void>; must: boolean }>();
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

/** A draft for the subject, in the store's open set (no host has it, so no rail lists it), its chips on it. */
function draftFor(workspace: DockWorkspace, subject: DockSubject, again: string | undefined): string {
  const port = workDockPort.get();
  if (!port) throw new Error("This window cannot start a chat here");
  if (!heeding) {
    heeding = true;
    chipPort.subscribe(heedChips);
  }
  // The draft from before as it last stood (his picks kept), else a new one seeded as New thread seeds one.
  const kept = again ? sessionStore.get(again) : undefined;
  const session = kept ?? (subject.seed ? subject.seed(port.draft(workspace, again)) : port.draft(workspace, again));
  const { hold } = subject;
  // A composer's hold runs only while its lead chip is still on the composer: he took it off, so the thread is not about it.
  const run = (): Promise<void> => (!hold || chipTaken.has(session.id) ? Promise.resolve() : hold(session.id));
  drafts.set(session.id, { session, chips: subject.chips, chipIn: subject.chipIn, hold: run, must: !!subject.mustHold });
  // In the store before the dock draws it, so nothing asks a host for an id no host has.
  sessionStore.mutate((prev) => [...prev.filter((s) => s.id !== session.id), session]);
  putChips(session.id);
  return session.id;
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
 * The dock shows `id`. A draft goes into the session store's open set (as it last stood there, its picks kept), its
 * subject's chips are put on it (each time it is shown, unless he took them off), and its first send's step is set.
 * A thread is left as it is.
 */
export function enterDock(id: string): void {
  const draft = drafts.get(id);
  if (!draft || !sessionStore.isDraft(id) || sessionStore.isProvisional(id)) return;
  if (!sessionStore.isOpen(id)) {
    const session = sessionStore.get(id) ?? draft.session;
    sessionStore.mutate((prev) => [...prev.filter((s) => s.id !== id), session]);
  }
  putChips(id);
  afterCreate.set(id, draft.hold, { must: draft.must });
}

/**
 * The dock let go of what it showed. A draft he sent nothing in leaves the open set (it was never on a host) and its
 * step is cleared; its composer's words and chips stay with its id, for the next time the subject's dock opens this
 * run (`enterDock` puts it back). A draft whose first send is under way is left to it.
 */
export function leaveDock(id: string): void {
  if (!sessionStore.isDraft(id) || sessionStore.isProvisional(id)) return;
  if ((sessionStore.get(id)?.blocks.length ?? 0) > 0) return;
  afterCreate.clear(id);
  setSendChips(id, null);
  sessionStore.mutate((prev) => prev.filter((s) => s.id !== id));
}

/** Test seam: forget what the docks showed. */
export function resetDocks(): void {
  shown.clear();
  drafts.clear();
  chipSeen.clear();
  chipTaken.clear();
}
