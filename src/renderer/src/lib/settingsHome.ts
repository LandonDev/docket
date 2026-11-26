import type { SettingsHome } from "@server/shared/contract";
import { nameInLine } from "./hostWords";
import { useEffect, useRef } from "react";

/**
 * Where a setting's one copy lives when another host holds it: the
 * box keeps shared rules, defaults, Plans and Reviews (remote/rulesSync.ts).
 * Their getters name that host and say whether it answers now.
 */
export type { SettingsHome };

/** The host's `home` off the wire; anything else is none. */
export function readHome(raw: unknown): SettingsHome | null {
  if (!raw || typeof raw !== "object") return null;
  const { name, online } = raw as Record<string, unknown>;
  return typeof name === "string" && typeof online === "boolean" ? { name, online } : null;
}

/** How often a page that shows its home offline asks again. */
export const HOME_RECHECK_MS = 5_000;

/**
 * A home's `online` is the host's link to it at the instant of the answer:
 * one read before the link came up (a window opened at launch, before the
 * host dialed the box) would say offline for good. While a page shows its
 * home offline it asks again every HOME_RECHECK_MS, so the note and the
 * controls follow the link without a press.
 */
export function useRecheckWhileOffline(home: SettingsHome | null | undefined, recheck: () => void): void {
  const latest = useRef(recheck);
  useEffect(() => {
    latest.current = recheck;
  });
  const offline = home?.online === false;
  useEffect(() => {
    if (!offline) return;
    const timer = setInterval(() => latest.current(), HOME_RECHECK_MS);
    return () => clearInterval(timer);
  }, [offline]);
}

/** The line a settings section prints for it: "Saved on box", or "box is offline" with the controls off. */
export function homeNote(home: SettingsHome | null | undefined): { note: string | undefined; blocked: boolean } {
  if (!home) return { note: undefined, blocked: false };
  return home.online ? { note: `Saved on ${home.name}`, blocked: false } : { note: `${home.name} is offline`, blocked: true };
}

/** A host's refusal as a page says it: "refused: " dropped and the first letter raised ("Orchestration rules … live on box; it is offline"). */
export function refusalWords(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err ?? "")).trim().replace(/^refused:\s*/i, "");
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "";
}

/**
 * The line under an Everywhere page's title (docs/agents/settings.md "The pages: Everywhere"), from the `home` its
 * store answered: the box keeps the one copy ("Saved on the box, for every computer."); the box is out of reach (the
 * controls are held); no `home`, so this computer keeps its own copy (`here`: "this Mac", or the box's own name at
 * /ui). A page never claims a home its store did not name.
 */
export function everyLine(home: SettingsHome | null | undefined, here: string, name: string = home ? nameInLine(home.name) : ""): string {
  // Until the store has answered, or when it could not, the line says only what holds either way.
  if (home === undefined) return "For every computer.";
  if (!home) return `Saved on ${here}.`;
  if (home.online) return `Saved on ${name}, for every computer.`;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} is offline. These are as last saved.`;
}
