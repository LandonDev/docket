import { useSyncExternalStore } from "react";
import { shortHostName } from "@shared/hostNames";
import { LOCAL_ENVIRONMENT_ID, WEB_ENVIRONMENT_ID, registry, useEnvironmentStatus, useEnvironments } from "../connection";
import { nameInLine } from "../hostWords";
import { isWebMode } from "../nativeWeb";
import { thisDesktopInLine, thisDesktopName } from "../native";

/**
 * A computer's one name (docs/agents/settings.md "A computer has one name"). Where computers stand side by side (rows,
 * or headings in parallel) each is its own name, the same in every window: this window's own computer by what it calls
 * itself (its host label, "MacBook Pro"), with `own` so the row says "this Mac" after it in the muted tone; a computer
 * this window is linked to by the name it is saved under here (the computer's own label until he renames it); any
 * other by the name whoever listed it gave, shortened as every host label is. Where only this computer is meant, the
 * words are "this Mac" (`thisDesktopInLine`).
 */
export type ComputerName = {
  name: string;
  /** This window's own computer: its row carries "this Mac" after the name. */
  own: boolean;
};

export type ComputerNames = {
  /** This window's own computer: the id it answers its hello with, and what it calls itself. Null until it has said. */
  own: { id: string | null; name: string | null };
  /** The computers this window reaches, as the registry lists them. */
  environments: readonly { id: string; name: string }[];
  /** The box's web page: the window is a browser, so no computer is "this Mac". */
  web: boolean;
};

/** `said` is the name the lister gave (a host's `work.desktops`, the bridge's row), for a computer this window has no link to. */
export function computerNameOf(id: string, known: ComputerNames, said?: string | null): ComputerName {
  const own = !known.web && (id === LOCAL_ENVIRONMENT_ID || (known.own.id !== null && id === known.own.id));
  if (own) return { name: known.own.name ?? (said ? shortHostName(said) : thisDesktopName()), own: true };
  const saved = known.environments.find((environment) => environment.id === id);
  if (saved && saved.id !== LOCAL_ENVIRONMENT_ID) return { name: saved.name, own: false };
  // The box's web page: the computer that serves it, by the page's own id for it or by the id its hello gave.
  if ((id === WEB_ENVIRONMENT_ID || id === known.own.id) && known.own.name) return { name: known.own.name, own: false };
  return { name: said ? shortHostName(said) : id, own: false };
}

/** A computer's name inside a sentence: this window's own is "this Mac"; "The box" reads "the box". */
export const computerInLine = (computer: ComputerName): string => (computer.own ? thisDesktopInLine() : nameInLine(computer.name));

// ── This window's own computer ───────────────────────────────────────

let ownName: string | null = null;
let asked = false;
const listeners = new Set<() => void>();

/** What this computer calls itself, asked of it once (`remote.status` is the window's own to ask). */
function askOwnName(): void {
  if (asked || isWebMode()) return;
  asked = true;
  registry
    .primary()
    .request<{ name?: string }>("remote.status", {})
    .then(
      (status) => {
        if (!status.name) return;
        ownName = shortHostName(status.name);
        for (const listener of listeners) listener();
      },
      () => {
        // Asked again by the next page that needs it.
        asked = false;
      },
    );
}

const subscribeOwn = (listener: () => void): (() => void) => {
  listeners.add(listener);
  askOwnName();
  return () => listeners.delete(listener);
};

/** For tests: forget what this computer said. */
export function resetOwnComputerForTests(name: string | null = null): void {
  ownName = name;
  asked = name !== null;
}

/** Every computer's name in this window, asked per row: `names(id, said)`. */
export function useComputerNames(): (id: string, said?: string | null) => ComputerName {
  const environments = useEnvironments();
  const hello = useEnvironmentStatus(registry.primaryEnvironmentId).lastHello;
  const name = useSyncExternalStore(subscribeOwn, () => ownName);
  const web = isWebMode();
  const known: ComputerNames = {
    own: { id: hello?.environmentId ?? null, name: web ? (environments.find((environment) => environment.id === WEB_ENVIRONMENT_ID)?.name ?? null) : name },
    environments,
    web,
  };
  return (id, said) => computerNameOf(id, known, said);
}

/** One computer's name in this window. */
export function useComputerName(id: string, said?: string | null): ComputerName {
  return useComputerNames()(id, said);
}
