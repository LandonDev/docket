import type { SectorKey } from "@shared/work";

/**
 * Start places (Settings → Work, docs/agents/work-clashes.md): where each job's
 * drives begin. The words a row says and the patch a Save sends, kept apart
 * from the screen so a test reads them whole.
 */

/** A place as LifeOS's `settings:startPlaces` gives it; `label` is the place as the map names it. */
export type StartPlace = { address?: string; label?: string; state: "none" | "looking" | "found" | "failed"; /** found only as its town's centre: drives start there */ rough?: boolean };
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
      // The map did not find the address itself: the row keeps what he typed and says where its drives start.
      if (place.rough) return { description: `${place.address ?? place.label}, using the town centre` };
      return { description: place.label || place.address };
    case "failed":
      // The address he typed stays in view, so the slip that lost it can be seen.
      return { description: place.address, error: "Not found" };
  }
}

/** The dialog's fields. */
export type StartForm = { address: string; lookups: boolean };

/** An address as LifeOS keeps it: runs of spaces as one, none at the ends. Compared and sent this way, so what comes back reads as what went. */
export const tidyAddress = (address: string): string => address.replace(/\s+/g, " ").trim();

/** Whether the form differs from what LifeOS holds; spaces LifeOS would not keep do not count. */
export function formChanged(saved: StartForm, form: StartForm): boolean {
  return tidyAddress(form.address) !== tidyAddress(saved.address) || form.lookups !== saved.lookups;
}

/** The patch a Save sends, or null when nothing changed: only what he changed, for this one place. */
export function savePatch(target: StartTarget, saved: StartForm, form: StartForm): StartPatch | null {
  if (!formChanged(saved, form)) return null;
  const address = tidyAddress(form.address);
  if (target === "home") return { homeAddress: address || null };
  const patch: StartPatch = {};
  if (address !== tidyAddress(saved.address)) patch.startFor = { sector: target, address };
  if (form.lookups !== saved.lookups) patch.lookupsFor = { sector: target, on: form.lookups };
  return patch;
}

/** The form's fields a patch set, as the reads will show them once it has landed. */
export function fieldsOf(patch: StartPatch): Partial<StartForm> {
  return {
    ...(patch.homeAddress !== undefined ? { address: patch.homeAddress ?? "" } : {}),
    ...(patch.startFor ? { address: patch.startFor.address } : {}),
    ...(patch.lookupsFor ? { lookups: patch.lookupsFor.on } : {}),
  };
}

/** Whether a field holds the value a patch sent, spaces aside. */
export const sameField = (a: string | boolean | undefined, b: string | boolean | undefined): boolean => (typeof a === "string" && typeof b === "string" ? tidyAddress(a) === tidyAddress(b) : a === b);
