import { useEffect, useSyncExternalStore } from "react";
import type { PrepAddedPerson, PrepAhead, PrepPage } from "@shared/contract-work-prep";
import { attachmentSettings, blobSource, formatBytes, uploadFile, type UploadProgress } from "../../lib/attachmentUpload";
import { registry } from "../../lib/connection";
import { refusalWords } from "../../lib/settingsHome";

/**
 * The window's copy of each meeting's page (the host's `work.prep.page`,
 * src/main/server/work/prep): read when a page opens, and again whenever the
 * `work.prep` push says its `rev` moved (the push carries ids alone). One
 * copy per meeting, shared by the page's header and its body.
 */

export interface PrepView {
  page: PrepPage | null;
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

/** Reads a meeting's page from its host; a change while it runs reads once more after it. */
export function loadPrep(environmentId: string, workspaceId: string, eventId: string): void {
  const key = keyOf(workspaceId, eventId);
  const entry = entries.get(key);
  if (!entry || entry.environmentId !== environmentId) entries.set(key, { ...EMPTY, environmentId, workspaceId, eventId, fetching: false, again: false });
  else if (entry.fetching) return put(key, { again: true });
  put(key, { fetching: true, again: false });
  void ask<{ page: PrepPage }>(environmentId, "work.prep.page", { workspaceId, eventId }).then(
    ({ page }) => {
      const now = entries.get(key);
      // An answer older than what is held (a write's own answer won the race) keeps what is held.
      put(key, { ...(now?.page && page.rev < now.page.rev ? {} : { page }), loaded: true, error: null, fetching: false });
      if (entries.get(key)?.again) loadPrep(environmentId, workspaceId, eventId);
    },
    (err: unknown) => {
      put(key, { loaded: true, error: refusalWords(err) || "The host did not answer", fetching: false });
      if (entries.get(key)?.again) loadPrep(environmentId, workspaceId, eventId);
    },
  );
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
  const view = useSyncExternalStore(subscribe, () => entries.get(key) ?? EMPTY);
  useEffect(() => {
    if (!eventId) return;
    // Every mount asks once more: the facts are LifeOS's as they stand now.
    loadPrep(environmentId, workspaceId, eventId);
    return registry.linkOf(environmentId).onPush((push) => {
      if (push.push !== "work.prep" || push.workspaceId !== workspaceId || push.eventId !== eventId) return;
      const held = entries.get(key)?.page;
      if (!held || push.rev > held.rev) loadPrep(environmentId, workspaceId, eventId);
    });
  }, [environmentId, workspaceId, eventId, key]);
  return view;
}

/** Sets the people added to a page; answers once the host kept them. */
export async function setPrepPeople(environmentId: string, workspaceId: string, eventId: string, people: PrepAddedPerson[]): Promise<void> {
  holdPrep((await ask<{ page: PrepPage }>(environmentId, "work.prep.people", { workspaceId, eventId, people })).page);
}

/** For tests and the preview: forget every page. */
export function resetPrep(): void {
  entries.clear();
  tell();
}

/** Brief me: the host starts the brief thread, or answers the one still working. */
export const briefPrep = async (environmentId: string, workspaceId: string, eventId: string): Promise<string> =>
  (await ask<{ sessionId: string }>(environmentId, "work.prep.brief", { workspaceId, eventId })).sessionId;

/** Keeps his notes with the page (empty text takes them back). */
export async function keepPrepNotes(environmentId: string, workspaceId: string, eventId: string, text: string): Promise<void> {
  holdPrep((await ask<{ page: PrepPage }>(environmentId, "work.prep.notes", { workspaceId, eventId, text })).page);
}

/** Follow up: the host starts the follow-up thread from the notes, or answers the one still working. */
export const followUpPrep = async (environmentId: string, workspaceId: string, eventId: string): Promise<string> =>
  (await ask<{ sessionId: string }>(environmentId, "work.prep.followUp", { workspaceId, eventId })).sessionId;

/**
 * Follow up from a recording or a transcript he picked. The host starts the
 * follow-up thread with an empty meeting beside it; the file then goes up to
 * that thread's host, into the workspace's folder, and the meetings pillar's
 * own start reads it there (a recording is transcribed on that host). Nothing
 * of it goes anywhere else. Throws the words to show when the host cannot
 * read it: a transcriber that is not installed, a file over the host's limit.
 */
export async function followUpFromFile(environmentId: string, workspaceId: string, eventId: string, file: File, onProgress?: (progress: UploadProgress) => void): Promise<string> {
  const [{ maxBytes }, source] = await Promise.all([attachmentSettings(environmentId), blobSource(file)]);
  // Said before any thread starts: a file the host will not take starts nothing.
  if (source.size > maxBytes) throw new Error(`${file.name} is ${formatBytes(source.size)}, over this host’s ${formatBytes(maxBytes)} limit`);
  const { sessionId, itemId } = await ask<{ sessionId: string; itemId?: string }>(environmentId, "work.prep.followUp", { workspaceId, eventId, recording: { name: file.name } });
  if (!itemId) throw new Error("A follow-up is already at work on this meeting. Open its thread from More.");
  try {
    const landed = await uploadFile({ threadEnv: environmentId, sessionId, name: file.name, ...(file.type ? { mime: file.type } : {}), source, into: "workspace", ...(onProgress ? { onProgress } : {}) });
    const { meeting } = await ask<{ meeting: { status: string; error?: string | null } }>(environmentId, "work.meetings.start", { itemId, source: { at: "file", host: environmentId, path: landed.path } });
    if (meeting.status === "failed") throw new Error(meeting.error?.trim() || "This host could not read the file.");
  } finally {
    loadPrep(environmentId, workspaceId, eventId);
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
  loadPrep(environmentId, workspaceId, eventId);
}

/**
 * Write in a document: the host makes the meeting's notes file from the job's
 * Meeting notes template and keeps it as the page's notes. Answers the file,
 * for the window to open.
 */
export async function notesDocPrep(environmentId: string, workspaceId: string, eventId: string): Promise<{ path: string; title: string }> {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const out = await ask<{ page: PrepPage; source: { at: string; path?: string }; title: string }>(environmentId, "work.prep.notesDoc", { workspaceId, eventId, today });
  holdPrep(out.page);
  if (out.source.at !== "file" || !out.source.path) throw new Error("The notes document is not a file this window can open.");
  return { path: out.source.path, title: out.title };
}

/** Opens a file of the workspace's folder in a new thread's canvas, as a file dropped on a view opens: nothing runs until he sends. */
export async function openWorkspaceFile(environmentId: string, file: { path: string; title: string }): Promise<void> {
  const { openOutside } = await import("../canvas/openOutside");
  await openOutside({ at: "new" }, [{ name: file.title, path: file.path, origin: environmentId }]);
}
