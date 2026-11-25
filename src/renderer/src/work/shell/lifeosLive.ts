import { useEffect, useRef, useState } from "react";
import type { LifeosStateName, LifeosStatus } from "@shared/contract-work-lifeos";
import { errorText } from "@shared/work";
import { isSilence, lifeosStateOf, useLifeosStatusHeard, useLifeosUnanswered, type LifeosSession } from "./lifeos";
import { downOf, type LifeosDown } from "./lifeosDown";

/**
 * The live-status clause of the LifeOS rule (docs/DESIGN.md "Loading and empty states"), built once: a reader that
 * keeps the cause of a failed read (Waiting on's days, a held mail's read, Review's week, Capture's state, Files'
 * LifeOS place, Voice, a dashboard's tile) says what the host's LIVE status says now, never what an older read saved.
 * A status that changes changes the line and its press at once; one that says connected again reads again.
 *
 * `saved` is the cause the reader's last read gave (`savedOf` reads it from an error): a down state, "connecting", or
 * null when the read did not fail for LifeOS. The answer is `down` (the state to word, with `downWords`, `useDownPress`
 * and `useDownAction`), or `waits` (LifeOS on its way: `connectingWords`, no press), or neither (nothing to say).
 */
export type SavedDown = LifeosDown | "connecting" | null;

export interface LiveDown {
  down: LifeosDown | null;
  waits: boolean;
}

const WAITS: LiveDown = { down: null, waits: true };
const NONE: LiveDown = { down: null, waits: false };

/** A cause in a reader's hands, from the error its read gave: the host's silence, a LifeOS state the host named, or null. */
export function savedOf(err: unknown): SavedDown {
  if (isSilence(err)) return "unanswered";
  const state = lifeosStateOf(errorText(err));
  return state === "connecting" ? "connecting" : state && state !== "connected" ? state : null;
}

/**
 * The cause a reader kept as words alone (a failed open's message, a host's saved `failed`): the LifeOS state the host's
 * own sentence names ("This host is not signed in to LifeOS", "LifeOS is unreachable", "Work is off on this host"), else
 * null. Only a sentence that names LifeOS or Work counts: a wait of the window's that ran out, or a fetch of the kind's
 * own that failed, is the reader's failure to say, never "LifeOS did not answer".
 */
export const savedOfReason = (reason: string | null | undefined): SavedDown => (reason && /lifeos|work is off on this host/i.test(reason) ? savedOf(reason) : null);

/** A status by its state, as the reader's line reads it: a down state, "connecting", or null for connected. */
export const savedOfState = (state: LifeosStateName | null | undefined): SavedDown => (!state || state === "connected" ? null : state);

/**
 * What to say now, from the saved cause and the live status. A computer kept from LifeOS stays so; the host's own
 * silence while it says nothing connected is its silence; a status that is not connected wins (connecting is a wait),
 * except over a silence the reader heard after that status, until a newer status comes (`heard`); else the saved cause.
 */
export function liveDownOf(saved: SavedDown, status: LifeosStatus | null, silent: boolean, heard: boolean): LiveDown {
  if (saved === "withheld") return { down: "withheld", waits: false };
  const state = status?.lifeos.state;
  if (silent && state !== "connected") return { down: "unanswered", waits: false };
  const savedSilence = saved === "unanswered" || saved === "unreachable";
  if (state && state !== "connected" && (heard || !savedSilence)) return state === "connecting" ? WAITS : { down: state, waits: false };
  if (saved === "connecting") return WAITS;
  return saved ? { down: saved, waits: false } : NONE;
}

const isDownStatus = (status: LifeosStatus | null): boolean => !!status && status.lifeos.state !== "connected";

/**
 * `liveDownOf` on the host's status as this window hears it (asking nothing: the reader's page or the rail watches the
 * host). `onBack` is the reader's read: asked once each time a status heard since the saved cause, or since a status
 * that was down, says connected. The newest `onBack` is kept in a ref, so nothing a render makes anew is handed in.
 */
export function useLiveDown(saved: SavedDown, environmentId: string | null | undefined, onBack?: () => void): LiveDown {
  const status = useLifeosStatusHeard(environmentId);
  const silent = useLifeosUnanswered(environmentId);
  // What the hook last saw: the saved cause, the status then, whether a status came since the cause, and whether a read is owed.
  const [seen, setSeen] = useState(() => ({ saved, status, heard: false, owe: saved !== null || isDownStatus(status) }));
  let now = seen;
  if (seen.saved !== saved) now = { saved, status, heard: false, owe: saved !== null || isDownStatus(status) };
  else if (seen.status !== status) now = { ...seen, status, heard: true, owe: seen.owe || isDownStatus(status) };
  if (now !== seen) setSeen(now);
  const back = useRef(onBack);
  back.current = onBack;
  const due = now.heard && now.owe && status?.lifeos.state === "connected";
  useEffect(() => {
    if (!due) return;
    setSeen((s) => ({ ...s, owe: false }));
    back.current?.();
  }, [due]);
  return liveDownOf(saved, status, silent, now.heard);
}

/**
 * The host's own LifeOS, as this window last heard it, shaped as a session that cannot read (for `DownLine`), or null
 * while it reads, is on its way, or is not known: for a control whose act runs on the host through the host's session
 * (a clash's Decline, a recording's Accept), whatever this window's own session does.
 */
export function useHostDown(environmentId: string): LifeosSession | null {
  // Heard, never asked: the reader's page already watches the host.
  const status = useLifeosStatusHeard(environmentId);
  const silent = useLifeosUnanswered(environmentId) && status?.lifeos.state !== "connected";
  if (!status && !silent) return null;
  const host: LifeosSession = { environmentId, sector: null, client: null, state: silent ? "unreachable" : status!.lifeos.state, ...(silent ? { unanswered: true as const } : {}) };
  return downOf(host) ? host : null;
}
