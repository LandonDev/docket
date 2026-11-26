import { useEffect, useState } from "react";
import { nameInLine } from "../hostWords";
import { registry } from "./registry";
import { useEnvironmentStatus, useEnvironments } from "./status";
import type { EnvironmentStatus, TransportState } from "./types";

/**
 * What the chrome says about an environment that is not open. A socket
 * that drops and returns inside the backoff must not flicker the thread
 * read-only, so connecting and reconnecting count only after a grace
 * period; a refused credential or a stopped environment shows at once.
 * The grace counts from when the link left open, not from when a control
 * mounted: a new draft on a host that has been away for a minute says so
 * at once (edges-38).
 */

export const DEGRADED_GRACE_MS = 1500;

export type Degraded = {
  kind: Exclude<TransportState, "open">;
  status: EnvironmentStatus;
};

export function degradedFor(status: EnvironmentStatus, sinceMs: number): Degraded | null {
  if (status.transport === "open") return null;
  if (status.transport === "unauthorized" || status.transport === "offline") return { kind: status.transport, status };
  return sinceMs >= DEGRADED_GRACE_MS ? { kind: status.transport, status } : null;
}

/** The host answered as another machine than the one this computer paired with (supervisor.ts `adopt`). */
export const identityChanged = (status: EnvironmentStatus): boolean => status.transport === "offline" && !!status.lastError?.startsWith("host identity changed");

const atStart = (name: string): string => `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
const computerOffline = (): boolean => typeof navigator !== "undefined" && navigator.onLine === false;

/**
 * The one wording of a host's link that is not open: the connection line, the tooltip of every control held
 * while the host is away and the Hosts row read it. `now` adds the retry countdown to the line; without it the
 * words hold still (a tooltip, the composer's field). The transport's own text never shows.
 */
export function linkWords(name: string, degraded: Degraded, now?: number, online = !computerOffline()): string {
  const { status } = degraded;
  switch (degraded.kind) {
    case "unauthorized":
      return `${atStart(name)} no longer accepts this key`;
    case "offline":
      if (!online) return "This computer is offline";
      if (identityChanged(status)) return `${atStart(name)} is not the host this computer paired with`;
      return `${atStart(name)} is offline`;
    case "connecting":
      return `Connecting to ${nameInLine(name)}…`;
    case "reconnecting": {
      const wait = now !== undefined && status.nextRetryAt ? Math.max(0, Math.ceil((status.nextRetryAt - now) / 1000)) : 0;
      return wait > 0 ? `Reconnecting to ${nameInLine(name)} in ${wait} s` : `Reconnecting to ${nameInLine(name)}…`;
    }
  }
}

/** When each environment's link left open, kept from the registry itself so a control that mounts late reads it. */
const downSince = new Map<string, number>();
let watching = false;
function noteDown(): void {
  const now = Date.now();
  for (const [id, status] of registry.statuses()) {
    if (status.transport === "open") downSince.delete(id);
    else if (!downSince.has(id)) downSince.set(id, now);
  }
}
function watchDown(): void {
  if (watching || typeof registry.subscribe !== "function") return;
  watching = true;
  registry.subscribe(noteDown);
  noteDown();
}

export function useEnvironmentDegraded(id: string): Degraded | null {
  watchDown();
  const status = useEnvironmentStatus(id);
  const open = status.transport === "open";
  const [, tick] = useState(0);
  if (!open && !downSince.has(id)) downSince.set(id, Date.now());
  const since = open ? null : (downSince.get(id) ?? Date.now());
  useEffect(() => {
    if (open || since === null) return;
    const left = DEGRADED_GRACE_MS - (Date.now() - since);
    if (left < 0) return;
    const t = window.setTimeout(() => tick((n) => n + 1), left + 1);
    return () => window.clearTimeout(t);
  }, [open, since]);
  return degradedFor(status, since === null ? 0 : Date.now() - since);
}

/**
 * A control a host can only refuse while its link is not open is held: `held` is the tooltip (`linkWords`, no
 * countdown), null while the link is open or inside the grace. One subscription; nothing ticks.
 */
export function useHostHeld(environmentId: string | undefined): string | null {
  const degraded = useEnvironmentDegraded(environmentId ?? "");
  // A host the registry does not hold is no host this window links to: nothing is held on a guess.
  const environment = useEnvironments().find((e) => e.id === environmentId);
  return degraded && environment ? linkWords(environment.name, degraded) : null;
}

/** A host's name for the words, its id while the registry does not know it. */
export function useEnvironmentName(environmentId: string): string {
  return useEnvironments().find((e) => e.id === environmentId)?.name ?? environmentId;
}
