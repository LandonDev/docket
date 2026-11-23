import { useEffect, useSyncExternalStore } from "react";
import type { PrepAddedPerson, PrepPage } from "@shared/contract-work-prep";
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
