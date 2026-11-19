import { useEffect, useSyncExternalStore } from "react";
import type { Meeting, MeetingVoice } from "@shared/contract-work-meetings";
import type { CanvasSource } from "@shared/work";
import { registry } from "../../lib/connection";

/**
 * The renderer's copy of each meeting (the host's `work_meetings`,
 * src/main/server/work/meetings): fetched on first use and fetched again
 * whenever the `work.meetings` push says its `rev` moved (the push carries
 * no transcript). One copy per item, read by the kind's body and its bar.
 */

export interface MeetingView {
  meeting: Meeting | null;
  /** the first answer has come */
  loaded: boolean;
  /** the last fetch failed: why */
  error: string | null;
}

interface Entry extends MeetingView {
  environmentId: string;
  /** a fetch is running; `again`: a push came while it ran */
  fetching: boolean;
  again: boolean;
}

type Listener = () => void;
const EMPTY: MeetingView = { meeting: null, loaded: false, error: null };
const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<Listener>>();

const tell = (itemId: string): void => {
  for (const listener of listeners.get(itemId) ?? []) listener();
};
function put(itemId: string, patch: Partial<Entry>): void {
  const prev = entries.get(itemId);
  if (!prev) return;
  entries.set(itemId, { ...prev, ...patch });
  tell(itemId);
}

/** Fetch an item's meeting from its host; a push while it runs fetches once more after it. */
export function loadMeeting(environmentId: string, itemId: string): void {
  const entry = entries.get(itemId) ?? { ...EMPTY, environmentId, fetching: false, again: false };
  if (!entries.has(itemId) || entry.environmentId !== environmentId) entries.set(itemId, { ...entry, environmentId });
  if (entry.fetching) {
    put(itemId, { again: true });
    return;
  }
  put(itemId, { fetching: true, again: false });
  void registry
    .linkOf(environmentId)
    .request<{ meeting: Meeting | null }>("work.meetings.get", { itemId })
    .then(
      ({ meeting }) => {
        const now = entries.get(itemId);
        // An answer older than what is held (a later push's fetch won the race) is dropped.
        if (now?.meeting && meeting && meeting.rev < now.meeting.rev) put(itemId, { loaded: true, error: null });
        else put(itemId, { meeting, loaded: true, error: null });
      },
      (error: unknown) => put(itemId, { loaded: true, error: error instanceof Error ? error.message : String(error) }),
    )
    .finally(() => {
      const now = entries.get(itemId);
      put(itemId, { fetching: false });
      if (now?.again) loadMeeting(now.environmentId, itemId);
    });
}

/** The `work.meetings` push, and a test's seam for it: a meeting on screen whose rev moved is fetched again. */
export function applyMeetingPush(push: { itemId: string; rev: number }): void {
  const entry = entries.get(push.itemId);
  if (!entry || !listeners.has(push.itemId)) return;
  if (entry.meeting && entry.meeting.rev >= push.rev && !entry.fetching) return;
  loadMeeting(entry.environmentId, push.itemId);
}

export const meetingOf = (itemId: string): MeetingView => entries.get(itemId) ?? EMPTY;

/** Put an answer in place at once, so the canvas does not wait for the push that follows it. */
export function holdMeeting(meeting: Meeting): void {
  const entry = entries.get(meeting.itemId);
  if (!entry || (entry.meeting && entry.meeting.rev > meeting.rev)) return;
  put(meeting.itemId, { meeting, loaded: true, error: null });
}

/** An item's meeting, live. Fetches on first use. */
export function useMeeting(environmentId: string, itemId: string): MeetingView {
  const view = useSyncExternalStore(
    (listener) => {
      const set = listeners.get(itemId) ?? new Set<Listener>();
      listeners.set(itemId, set);
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0 && listeners.get(itemId) === set) listeners.delete(itemId);
      };
    },
    () => meetingOf(itemId),
  );
  useEffect(() => {
    // Every mount asks once more: a push that came while nothing showed the meeting was not heard.
    const entry = entries.get(itemId);
    if (!entry || entry.environmentId !== environmentId || !entry.fetching) loadMeeting(environmentId, itemId);
  }, [environmentId, itemId]);
  return view;
}

const ask = <T,>(environmentId: string, method: string, params: unknown): Promise<T> => registry.linkOf(environmentId).request<T>(method, params);

/** Makes the meeting from its file, or from `source`; answers the meeting as it stands (transcribing, or ready from a transcript). */
export async function startMeeting(environmentId: string, itemId: string, source?: CanvasSource): Promise<Meeting> {
  const { meeting } = await ask<{ meeting: Meeting }>(environmentId, "work.meetings.start", { itemId, ...(source ? { source } : {}) });
  holdMeeting(meeting);
  return meeting;
}

/** Items whose file was handed to the host already this window: a body that mounts again never starts it twice. */
const started = new Set<string>();
export function startOnce(environmentId: string, itemId: string): Promise<Meeting> | null {
  if (started.has(itemId)) return null;
  started.add(itemId);
  // A start the host never answered may be asked again.
  return startMeeting(environmentId, itemId).catch((error: unknown) => {
    started.delete(itemId);
    throw error;
  });
}

export async function decideTasks(environmentId: string, itemId: string, actionIds: string[], decision: "accept" | "reject"): Promise<{ id: string; error: string }[]> {
  const out = await ask<{ meeting: Meeting; failed: { id: string; error: string }[] }>(environmentId, "work.meetings.decide", { itemId, actionIds, decision });
  holdMeeting(out.meeting);
  return out.failed;
}

export async function nameSpeaker(environmentId: string, itemId: string, speakerId: string, name: string | null): Promise<void> {
  holdMeeting((await ask<{ meeting: Meeting }>(environmentId, "work.meetings.speaker", { itemId, speakerId, name })).meeting);
}

export async function undoNotes(environmentId: string, itemId: string): Promise<void> {
  holdMeeting((await ask<{ meeting: Meeting }>(environmentId, "work.meetings.undoNotes", { itemId })).meeting);
}

export const listVoices = async (environmentId: string): Promise<MeetingVoice[]> => (await ask<{ voices: MeetingVoice[] }>(environmentId, "work.meetings.voices", {})).voices;

/** Forgets a kept voice; the meeting on screen is fetched again, since its offers may have gone. */
export async function forgetVoice(environmentId: string, itemId: string, name: string): Promise<void> {
  await ask(environmentId, "work.meetings.forgetVoice", { name });
  loadMeeting(environmentId, itemId);
}

/** Preview and test seam: an item's meeting as if the host had answered. */
export function seedMeeting(environmentId: string, meeting: Meeting): void {
  entries.set(meeting.itemId, { meeting, loaded: true, error: null, environmentId, fetching: false, again: false });
  tell(meeting.itemId);
}

/** Test seam: forget everything (a module-level store). */
export function resetMeetings(): void {
  entries.clear();
  started.clear();
}

registry.onLink((link, event) => {
  if (event === "removed") return;
  link.onPush((push) => {
    if (push.push === "work.meetings") applyMeetingPush(push);
  });
  // A socket that came back may have missed a push: the meetings on screen ask again.
  link.onOpen(() => {
    for (const [itemId, entry] of entries) if (entry.environmentId === link.environmentId && listeners.has(itemId)) loadMeeting(link.environmentId, itemId);
  });
});
