import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { PrepAddedPerson, PrepAhead, PrepPage } from "@shared/contract-work-prep";
import type { CanvasSource } from "@shared/work";
import { attachmentSettings, blobSource, formatBytes, uploadFile, type UploadProgress } from "../../lib/attachmentUpload";
import { registry } from "../../lib/connection";
import { refusalWords } from "../../lib/settingsHome";
import { stillChosen, workViewNow, type OpenWorkView } from "../../lib/workSwitch";

/**
 * The window's copy of each meeting's page (the host's `work.prep.page`,
 * src/main/server/work/prep): read when a page opens, and again whenever the
 * `work.prep` push says its `rev` moved (the push carries ids alone). One
 * copy per meeting, shared by the page's header and its body.
 */

export interface PrepView {
  page: PrepPage | null;
  /** a read is on its way: a Retry with no page to show draws the bones, not a button that looks deaf */
  reading?: boolean;
  /** the first answer has come */
  loaded: boolean;
  /** the last read failed: why */
  error: string | null;
}

interface Entry extends PrepView {
  environmentId: string;
  workspaceId: string;
  eventId: string;
  /** a read is running; `again`: something changed while it ran */
  fetching: boolean;
  again: boolean;
}

const EMPTY: PrepView = { page: null, loaded: false, error: null };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const keyOf = (workspaceId: string, eventId: string): string => `${workspaceId}\n${eventId}`;
const tell = (): void => {
  for (const listener of listeners) listener();
};
function put(key: string, patch: Partial<Entry>): void {
  const prev = entries.get(key);
  if (!prev) return;
  entries.set(key, { ...prev, ...patch });
  tell();
}

const ask = <T,>(environmentId: string, method: string, params: unknown): Promise<T> => registry.linkOf(environmentId).request<T>(method, params);

/** The read running for each page, so a second ask waits for the same answer. */
const reading = new Map<string, Promise<void>>();

/**
 * Reads a meeting's page from its host; a change while it runs reads once
 * more after it. Answers when the page on screen is as fresh as this ask
 * (the read settled, and any read a change queued behind it), so a Retry
 * spins until then. A read that fails keeps the page it had and says why.
 */
export function loadPrep(environmentId: string, workspaceId: string, eventId: string): Promise<void> {
  const key = keyOf(workspaceId, eventId);
  const entry = entries.get(key);
  if (!entry || entry.environmentId !== environmentId) entries.set(key, { ...EMPTY, environmentId, workspaceId, eventId, fetching: false, again: false });
  else if (entry.fetching) {
    put(key, { again: true });
    return (reading.get(key) ?? Promise.resolve()).then(() => reading.get(key));
  }
  put(key, { fetching: true, again: false });
  const run = ask<{ page: PrepPage }>(environmentId, "work.prep.page", { workspaceId, eventId })
    .then(
      ({ page }) => {
        const now = entries.get(key);
        // An answer older than what is held (a write's own answer won the race) keeps what is held.
        put(key, { ...(now?.page && page.rev < now.page.rev ? {} : { page }), loaded: true, error: null, fetching: false });
      },
      (err: unknown) => put(key, { loaded: true, error: refusalWords(err) || "The host did not answer", fetching: false }),
    )
    .then(() => {
      reading.delete(key);
      if (entries.get(key)?.again) return loadPrep(environmentId, workspaceId, eventId);
    });
  reading.set(key, run);
  return run;
}

/** Keeps a page a write answered with. */
export function holdPrep(page: PrepPage): void {
  const key = keyOf(page.workspaceId, page.event.id);
  if (entries.has(key)) put(key, { page, loaded: true, error: null });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The page as the window holds it now, with no read of its own: the header's copy of what the body reads. */
export function usePrepHeld(workspaceId: string, eventId: string | null): PrepView {
  const key = keyOf(workspaceId, eventId ?? "");
  return useSyncExternalStore(subscribe, () => entries.get(key) ?? EMPTY);
}

/** A meeting's page, live: read on mount and whenever its host says it changed. */
export function usePrep(environmentId: string, workspaceId: string, eventId: string | null): PrepView {
  const key = keyOf(workspaceId, eventId ?? "");
  const held = useSyncExternalStore(subscribe, () => entries.get(key) ?? EMPTY);
  const view = useMemo<PrepView>(() => ({ page: held.page, loaded: held.loaded, error: held.error, reading: "fetching" in held && (held as Entry).fetching }), [held]);
  useEffect(() => {
    if (!eventId) return;
    // Every mount asks once more: the facts are LifeOS's as they stand now.
    void loadPrep(environmentId, workspaceId, eventId);
    return registry.linkOf(environmentId).onPush((push) => {
      const held = entries.get(key)?.page;
      // The follow-up's mail is LifeOS's own draft: it comes with no page write, so the held feed says when to look again.
      if (push.push === "work.outbox") return void (held?.followSessionId && loadPrep(environmentId, workspaceId, eventId));
      // A recording is read, or fails to be, long after the dialog closed and with no page write: the meetings pillar says which
      // meeting, and the Notes row is read again when it is this page's.
      if (push.push === "work.meetings") return void (held?.notesFile?.itemId === push.itemId && (push.status === "failed" || push.status === "ready") && loadPrep(environmentId, workspaceId, eventId));
      if (push.push !== "work.prep" || push.workspaceId !== workspaceId || push.eventId !== eventId) return;
      if (!held || push.rev > held.rev) void loadPrep(environmentId, workspaceId, eventId);
    });
  }, [environmentId, workspaceId, eventId, key]);
  return view;
}

/** Sets the people added to a page; answers once the host kept them. */
export async function setPrepPeople(environmentId: string, workspaceId: string, eventId: string, people: PrepAddedPerson[]): Promise<void> {
  holdPrep((await ask<{ page: PrepPage }>(environmentId, "work.prep.people", { workspaceId, eventId, people })).page);
}

// ── Notes he typed that the host has not kept ──

/** What he typed in a Notes dialog whose save did not go through, and why: the dialog opens again on it, so nothing typed is lost. */
const drafts = new Map<string, { text: string; error: string }>();
export const heldNotes = (workspaceId: string, eventId: string): { text: string; error: string } | null => drafts.get(keyOf(workspaceId, eventId)) ?? null;
export const holdNotes = (workspaceId: string, eventId: string, text: string, error: string): void => void drafts.set(keyOf(workspaceId, eventId), { text, error });
export const dropNotes = (workspaceId: string, eventId: string): void => void drafts.delete(keyOf(workspaceId, eventId));

/** For tests and the preview: forget every page. */
export function resetPrep(): void {
  drafts.clear();
  reading.clear();
  entries.clear();
  tell();
}

/** Brief me: the host starts the brief thread, or answers the one still working. `restart`: the window knows that thread stopped. */
export const briefPrep = async (environmentId: string, workspaceId: string, eventId: string, restart = false): Promise<string> =>
  (await ask<{ sessionId: string }>(environmentId, "work.prep.brief", { workspaceId, eventId, ...(restart ? { restart } : {}) })).sessionId;

/** Another window kept other notes since this dialog opened; `now` is what the host holds. */
export class NotesChanged extends Error {
  constructor(readonly now: string) {
    super("These notes were changed in another window while you typed. Your words are still here: save again to put them in place of those.");
  }
}

/**
 * Keeps his notes with the page (empty text takes them back). `base`: the words the dialog opened on (or last
 * kept); when the host holds others by now, nothing is written and this throws `NotesChanged`. `dropItem`: the
 * meeting an upload went to never got its file, or could not read it, so it is no notes; the host lets go of that
 * meeting alone, and keeps the words it holds (another window may have kept newer ones than this one had).
 */
export async function keepPrepNotes(environmentId: string, workspaceId: string, eventId: string, text: string, opts: { base?: string; dropItem?: string } = {}): Promise<void> {
  const { dropItem, base } = opts;
  const out = await ask<{ page: PrepPage; conflict?: boolean }>(environmentId, "work.prep.notes", { workspaceId, eventId, text, ...(dropItem ? { dropFile: true, itemId: dropItem } : base !== undefined ? { base } : {}) });
  holdPrep(out.page);
  if (out.conflict) throw new NotesChanged(out.page.doc.notes?.text ?? "");
}

/** Follow up: the host starts the follow-up thread from the notes, or answers the one still working. `restart`: the window knows that thread stopped. */
export const followUpPrep = async (environmentId: string, workspaceId: string, eventId: string, restart = false): Promise<string> =>
  (await ask<{ sessionId: string }>(environmentId, "work.prep.followUp", { workspaceId, eventId, ...(restart ? { restart } : {}) })).sessionId;

/**
 * Follow up from a recording or a transcript he picked. The host starts the
 * follow-up thread with an empty meeting beside it; the file then goes up to
 * that thread's host, into the workspace's folder, and the meetings pillar's
 * own start reads it there (a recording is transcribed on that host). Nothing
 * of it goes anywhere else. Throws the words to show when the host cannot
 * read it: a transcriber that is not installed, a file over the host's limit.
 */
export async function followUpFromFile(
  environmentId: string,
  workspaceId: string,
  eventId: string,
  file: File,
  opts: { onProgress?: (progress: UploadProgress) => void; restart?: boolean; typed?: string } = {},
): Promise<string> {
  const [{ maxBytes }, source] = await Promise.all([attachmentSettings(environmentId), blobSource(file)]);
  // Said before any thread starts: a file the host will not take starts nothing.
  if (source.size > maxBytes) throw new Error(`${file.name} is ${formatBytes(source.size)}, over this host’s ${formatBytes(maxBytes)} limit`);
  const { sessionId, itemId } = await ask<{ sessionId: string; itemId?: string }>(environmentId, "work.prep.followUp", { workspaceId, eventId, recording: { name: file.name }, ...(opts.restart ? { restart: true } : {}) });
  if (!itemId) throw new Error("A follow-up is already at work on this meeting. Open its thread from More.");
  try {
    const landed = await uploadFile({ threadEnv: environmentId, sessionId, name: file.name, ...(file.type ? { mime: file.type } : {}), source, into: "workspace", ...(opts.onProgress ? { onProgress: opts.onProgress } : {}) });
    const { meeting } = await ask<{ meeting: { status: string; error?: string | null } }>(environmentId, "work.meetings.start", { itemId, source: { at: "file", host: environmentId, path: landed.path } });
    if (meeting.status === "failed") throw new Error(meeting.error?.trim() || "This host could not read the file.");
  } catch (err) {
    // The file never arrived, or the host could not read it: this upload's meeting is no notes. What he typed stays; the page offers Add notes or Follow up as before.
    await keepPrepNotes(environmentId, workspaceId, eventId, opts.typed ?? "", { dropItem: itemId }).catch(() => undefined);
    throw err;
  } finally {
    void loadPrep(environmentId, workspaceId, eventId);
  }
  return sessionId;
}

/** His word on suggested tasks; answers the ones LifeOS did not take, each with why. */
export async function decidePrepTasks(environmentId: string, workspaceId: string, eventId: string, taskIds: string[], decision: "accept" | "reject"): Promise<{ id: string; error: string }[]> {
  const out = await ask<{ page: PrepPage; failed: { id: string; error: string }[] }>(environmentId, "work.prep.decide", { workspaceId, eventId, taskIds, decision });
  holdPrep(out.page);
  return out.failed;
}

/** Turns Prepare ahead on or off for the workspace, in this window's time zone; the page is read again after. */
export async function setPrepAhead(environmentId: string, workspaceId: string, eventId: string, on: boolean): Promise<void> {
  await ask<PrepAhead>(environmentId, "work.prep.ahead", { workspaceId, on, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  await loadPrep(environmentId, workspaceId, eventId);
}

/** A day as the templates fill `{{Date}}` from it: "2026-11-20", on this window's clock. */
export const localDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Write in a document: the host makes the meeting's notes file from the job's
 * Meeting notes template and keeps it as the page's notes, dated by the
 * meeting's own day (Friday's meeting written up on Monday says Friday).
 * Answers the file, for the window to open.
 */
export async function notesDocPrep(environmentId: string, workspaceId: string, eventId: string, meetingAt: number): Promise<CanvasSource> {
  const out = await ask<{ page: PrepPage; source: CanvasSource; title: string }>(environmentId, "work.prep.notesDoc", { workspaceId, eventId, today: localDay(meetingAt) });
  holdPrep(out.page);
  if (out.source.at !== "file") throw new Error("The notes document is not a file this window can open.");
  return out.source;
}

/**
 * Opens his notes document in a Files tab of the meeting's own workspace, through Files' way in from another screen
 * (`openInFiles`): the file is opened where it is, in that workspace and no other, whichever job is in front by the
 * time the host answers. `chosen`: the number the press took (`choose`) and the view it saw; when he has gone
 * somewhere since, nothing opens, and the page's Notes row holds the document.
 */
export async function openNotesDoc(environmentId: string, workspaceId: string, source: CanvasSource, chosen?: { mine: number; before: OpenWorkView | null }): Promise<void> {
  const { openInFiles } = await import("../files/openFrom");
  // Asked after the opener has loaded, the last wait before Files: he has gone nowhere since the press, and is still on
  // the meeting he pressed it on (another meeting's page in the same job counts as no new choice of view).
  if (chosen && (!stillChosen(chosen.mine, chosen.before, workspaceId) || workViewNow()?.event !== chosen.before?.event)) return;
  await openInFiles({ id: workspaceId, environmentId }, { ref: source, name: source.at === "file" ? fileName(source.path) : "Notes" });
}

const fileName = (path: string): string => path.split(/[\\/]/).pop() || path;
