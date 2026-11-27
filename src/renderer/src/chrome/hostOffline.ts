import { useSyncExternalStore } from "react";
import { registry } from "../lib/connection/registry";
import { degradedNow, linkWords } from "../lib/connection/degraded";
import type { MenuRow } from "./menuRows";

/**
 * The offline tint's rule: with two or more hosts registered, a row whose
 * every host's link is not open is dimmed (`opacity-50`,
 * `data-host-offline`), as the master board's rows are. One host never
 * tints: its rows are all there is. Reads a boolean, so a status change
 * re-renders only the rows it flips.
 */
export function hostsOffline(hosts: readonly (string | undefined)[]): boolean {
  const known = hosts.filter((id): id is string => !!id);
  if (known.length === 0 || registry.environmentsSnapshot().length < 2) return false;
  return known.every((id) => registry.statusOf(id).transport !== "open");
}

export function useHostsOffline(hosts: readonly (string | undefined)[]): boolean {
  const key = hosts.join("\n");
  return useSyncExternalStore(registry.subscribe.bind(registry), () => hostsOffline(key.split("\n")));
}

/**
 * Why a row's host verbs are held (docs/DESIGN.md "Loading and empty states": no control the host would refuse),
 * read when a menu opens: the first host's link words while every host of the row is held as `degradedFor` holds
 * it (a drop past the 1.5 s grace, a refused key, a stopped host), else null. Unlike the tint, one host counts:
 * with the only host away every verb would be refused.
 */
export function hostsHeld(hosts: readonly (string | undefined)[]): string | null {
  // A host the registry does not hold is no host this window links to: nothing is held on a guess.
  const known = hosts.filter((id): id is string => !!id && !!registry.environment(id));
  const held = known.map((id) => degradedNow(id));
  if (known.length === 0 || held.some((d) => !d)) return null;
  return linkWords(registry.environment(known[0])?.name ?? known[0], held[0]!);
}

/** Menu rows with every verb but `keep` held: disabled, the host's state their reason. */
export function heldRows(rows: MenuRow[], reason: string | null, keep: ReadonlySet<string> = new Set()): MenuRow[] {
  if (!reason) return rows;
  return rows.map((row) => ((row.kind === "item" || row.kind === "sub") && !keep.has(row.id) ? { ...row, disabled: true, reason } : row));
}
