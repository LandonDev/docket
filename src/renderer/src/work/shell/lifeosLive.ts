import { useEffect, useMemo, useRef, useState } from "react";
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
 * and `useDownAction`), or `waits` (LifeOS on its way: `connectingWords`, no press), or `again` (connected heard since
 * the saved cause, and the read it owes is out: the reader draws its own loading state, never the saved cause), or none
 * of them (nothing to say).
 */
export type SavedDown = LifeosDown | "connecting" | null;

export interface LiveDown {
  down: LifeosDown | null;
  waits: boolean;
  /** Connected heard since the saved cause, its read again out: the reader's own loading state, never the saved cause. */
  again?: true;
}

const WAITS: LiveDown = { down: null, waits: true };
const NONE: LiveDown = { down: null, waits: false };
const AGAIN: LiveDown = { down: null, waits: false, again: true };

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
 * except over a silence the reader heard after that status, until a newer status comes (`heard`); connected heard since
 * the saved cause while the read it owes is out (`reading`) is a read again, never the saved cause; else the saved cause.
 */
export function liveDownOf(saved: SavedDown, status: LifeosStatus | null, silent: boolean, heard: boolean, reading = false): LiveDown {
  if (saved === "withheld") return { down: "withheld", waits: false };
  const state = status?.lifeos.state;
  if (silent && state !== "connected") return { down: "unanswered", waits: false };
  const savedSilence = saved === "unanswered" || saved === "unreachable";
  if (state && state !== "connected" && (heard || !savedSilence)) return state === "connecting" ? WAITS : { down: state, waits: false };
  if (saved && state === "connected" && heard && reading) return AGAIN;
  if (saved === "connecting") return WAITS;
  return saved ? { down: saved, waits: false } : NONE;
}

const isDownStatus = (status: LifeosStatus | null): boolean => !!status && status.lifeos.state !== "connected";

/**
 * `liveDownOf` on the host's status as this window hears it (asking nothing: the reader's page or the rail watches the
 * host). `onBack` is the reader's read: asked once each time a status heard since the saved cause, or since a status
 * that was down, says connected. The newest `onBack` is kept in a ref, so nothing a render makes anew is handed in.
 *
 * From that connected status until the read settles (the promise `onBack` returns), or until the reader's saved cause
 * changes, the answer is `again`: the reader draws its loading state in the saved cause's place. An `onBack` that
 * returns nothing reads as settled at once, so the saved cause shows again unless the reader cleared it; a saved cause
 * the read gives again, once it settles, is said again.
 */
export function useLiveDown(saved: SavedDown, environmentId: string | null | undefined, onBack?: () => void | Promise<unknown>): LiveDown {
  const status = useLifeosStatusHeard(environmentId);
  const silent = useLifeosUnanswered(environmentId);
  // What the hook last saw: the saved cause, the status then, whether a status came since the cause, whether a read is
  // owed, and whether the read it asked is out.
  const [seen, setSeen] = useState(() => ({ saved, status, heard: false, owe: saved !== null || isDownStatus(status), out: false }));
  let now = seen;
  if (seen.saved !== saved) now = { saved, status, heard: false, owe: saved !== null || isDownStatus(status), out: false };
  else if (seen.status !== status) now = { ...seen, status, heard: true, owe: seen.owe || isDownStatus(status) };
  if (now !== seen) setSeen(now);
  const back = useRef(onBack);
  back.current = onBack;
  const savedNow = useRef(saved);
  savedNow.current = saved;
  const due = now.heard && now.owe && status?.lifeos.state === "connected";
  useEffect(() => {
    if (!due) return;
    const read = back.current?.();
    const asked = savedNow.current;
    if (!read || typeof (read as Promise<unknown>).then !== "function") return setSeen((s) => ({ ...s, owe: false }));
    setSeen((s) => ({ ...s, owe: false, out: true }));
    // Settled: the read's own answer (a new saved cause, or none) is the reader's to say. A saved cause that changed
    // meanwhile has reset what the hook saw, and is left as it is.
    const settle = (): void => setSeen((s) => (s.saved === asked && s.out ? { ...s, out: false } : s));
    (read as Promise<unknown>).then(settle, settle);
  }, [due]);
  return liveDownOf(saved, status, silent, now.heard, now.owe || now.out);
}

/** The host's own LifeOS for a press it runs (`useHostLive`): a session that cannot read, or a wait, or neither. */
export interface HostLive {
  environmentId: string;
  /** Down, shaped as a session that cannot read (for `DownLine`); null while it reads, is on its way, or is not known. */
  down: LifeosSession | null;
  /** The host said its LifeOS is on its way: `connectingWords`, no press, and every control that needs the session held. */
  waits: boolean;
}


/**
 * The host's own LifeOS, as this window last heard it, for a control whose act runs on the host through the host's
 * session (a clash's Decline, a recording's Accept, Files' search and Home), whatever this window's own session does:
 * down (a session for `DownLine`), a wait while the host says it is connecting (one line, no press, the control held),
 * or neither while it reads or is not known yet.
 */
export function useHostLive(environmentId: string): HostLive {
  // Heard, never asked: the reader's page already watches the host.
  const status = useLifeosStatusHeard(environmentId);
  const silent = useLifeosUnanswered(environmentId) && status?.lifeos.state !== "connected";
  return useMemo(() => {
    if (!status && !silent) return { environmentId, down: null, waits: false };
    if (!silent && status!.lifeos.state === "connecting") return { environmentId, down: null, waits: true };
    const host: LifeosSession = { environmentId, sector: null, client: null, state: silent ? "unreachable" : status!.lifeos.state, ...(silent ? { unanswered: true as const } : {}) };
    return { environmentId, down: downOf(host) ? host : null, waits: false };
  }, [environmentId, status, silent]);
}
