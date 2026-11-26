import { useEffect, useSyncExternalStore } from "react";
import type { SettingsHome } from "../settingsHome";

/**
 * Where an Everywhere page's set is kept, as its own store last answered (docs/agents/settings.md "The pages:
 * Everywhere"). The page reads its store as it always has and tells this what `home` came back (`usePublishHome`);
 * the line under the title (`HomeLine`) reads it here, so the frame asks nothing a second time and loads no store of
 * its own. `undefined` until the store has answered; `null` when it answered with no home (this computer keeps it).
 */
export const HOME_PAGES = ["defaults", "reviews", "orchestration", "addons", "skills"] as const;
export type HomePage = (typeof HOME_PAGES)[number];

export const isHomePage = (page: string): page is HomePage => (HOME_PAGES as readonly string[]).includes(page);

const homes = new Map<HomePage, SettingsHome | null>();
const listeners = new Set<() => void>();

function publish(page: HomePage, home: SettingsHome | null | undefined): void {
  const was = homes.get(page);
  if (home === undefined ? !homes.has(page) : homes.has(page) && sameHome(was, home)) return;
  if (home === undefined) homes.delete(page);
  else homes.set(page, home);
  for (const listener of listeners) listener();
}

const sameHome = (a: SettingsHome | null | undefined, b: SettingsHome | null): boolean =>
  a === b || (!!a && !!b && a.name === b.name && a.online === b.online);

/** A page says where its set is kept, once its store has answered; the line goes back to waiting when it unmounts. */
export function usePublishHome(page: HomePage, home: SettingsHome | null | undefined): void {
  const name = home?.name;
  const online = home?.online;
  const known = home !== undefined;
  useEffect(() => {
    publish(page, known ? (name === undefined ? null : { name, online: online === true }) : undefined);
  }, [page, known, name, online]);
  useEffect(() => () => publish(page, undefined), [page]);
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** What the page last said of its home: undefined while it has not. */
export function usePageHome(page: HomePage): SettingsHome | null | undefined {
  return useSyncExternalStore(subscribe, () => homes.get(page));
}

/** For tests: forget every page's home. */
export function resetPageHomesForTests(): void {
  homes.clear();
  for (const listener of listeners) listener();
}

/** The linked computer that keeps a set, by the name its store gave for it (a home carries no id); null when this
 *  window has no link of that name. */
export function homeEnvironmentId(home: { name: string } | null | undefined, environments: readonly { id: string; name: string }[]): string | null {
  if (!home) return null;
  const said = home.name.trim().toLowerCase();
  return environments.find((environment) => environment.name.trim().toLowerCase() === said)?.id ?? null;
}
