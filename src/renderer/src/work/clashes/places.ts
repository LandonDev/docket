import type { SectorKey } from "@shared/work";

/**
 * Start places (Settings → Work, docs/agents/work-clashes.md): where each job's
 * drives begin. The words a row says and the patch a Save sends, kept apart
 * from the screen so a test reads them whole.
 */

/** A place as LifeOS's `settings:startPlaces` gives it; `label` is the place as the map names it. */
export type StartPlace = { address?: string; label?: string; state: "none" | "looking" | "found" | "failed" };
export type JobStart = StartPlace & { sector: SectorKey; lookups: boolean };
export type StartPlaces = { home: StartPlace; jobs: JobStart[] };

/**
 * What `settings:update` takes from this screen: home's address, or one job
 * set alone. LifeOS lays a job's start and its lookups over the maps it
 * holds in the one write, so two windows that each change a job keep each
 * other's change; an empty address clears the start.
 */
export type StartPatch = {
  homeAddress?: string | null;
  startFor?: { sector: SectorKey; address: string };
  lookupsFor?: { sector: SectorKey; on: boolean };
};

/** Home, or one job. */
export type StartTarget = "home" | SectorKey;

/** What a row's button is called: its verb, whose place, and what the row says of it, so the row reads whole on focus. */
export function rowLabel(name: string, words: { description?: string; error?: string }): string {
  const said = [words.description, words.error].filter(Boolean).join(", ");
  return said ? `Change ${name}: ${said}` : `Change ${name}`;
}

/** A row's lines: its muted description and, when the map did not find it, its red line. */
export function placeWords(place: StartPlace, target: StartTarget): { description?: string; error?: string } {
  switch (place.state) {
    case "none":
      return { description: target === "home" ? "Not set" : "Home" };
    case "looking":
      return { description: "Looking up…" };
    case "found":
      return { description: place.label || place.address };
    case "failed":
      // The address he typed stays in view, so the slip that lost it can be seen.
      return { description: place.address, error: "Not found" };
  }
}

/** The dialog's fields. */
export type StartForm = { address: string; lookups: boolean };

/** Whether the form differs from what LifeOS holds; spaces at the ends do not count. */
export function formChanged(saved: StartForm, form: StartForm): boolean {
  return form.address.trim() !== saved.address.trim() || form.lookups !== saved.lookups;
}

/** The patch a Save sends, or null when nothing changed: only what he changed, for this one place. */
export function savePatch(target: StartTarget, saved: StartForm, form: StartForm): StartPatch | null {
  if (!formChanged(saved, form)) return null;
  const address = form.address.trim();
  if (target === "home") return { homeAddress: address || null };
  const patch: StartPatch = {};
  if (address !== saved.address.trim()) patch.startFor = { sector: target, address };
  if (form.lookups !== saved.lookups) patch.lookupsFor = { sector: target, on: form.lookups };
  return patch;
}
