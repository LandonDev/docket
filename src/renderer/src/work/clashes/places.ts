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

/** The part of LifeOS's `settings:get` a Save reads: `starts` and `placeLookups` are sent whole. */
export type StartSettings = {
  homeAddress?: string;
  starts?: Partial<Record<SectorKey, string>>;
  placeLookups?: Partial<Record<SectorKey, boolean>>;
};

/** What `settings:update` takes from this screen. */
export type StartPatch = {
  homeAddress?: string | null;
  starts?: Partial<Record<SectorKey, string>>;
  placeLookups?: Partial<Record<SectorKey, boolean>>;
};

/** Home, or one job. */
export type StartTarget = "home" | SectorKey;

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

/** The patch a Save sends, or null when nothing changed. A job's maps go whole, changed at its one key; an empty address clears the start. */
export function savePatch(target: StartTarget, saved: StartForm, form: StartForm, settings: StartSettings): StartPatch | null {
  if (!formChanged(saved, form)) return null;
  const address = form.address.trim();
  if (target === "home") return { homeAddress: address || null };
  const patch: StartPatch = {};
  if (address !== saved.address.trim()) patch.starts = address ? { ...settings.starts, [target]: address } : withoutStart(target, settings);
  if (form.lookups !== saved.lookups) patch.placeLookups = { ...settings.placeLookups, [target]: form.lookups };
  return patch;
}

/** "Use home": the whole `starts` map with this job left out, so it starts from home. */
export function homePatch(sector: SectorKey, settings: StartSettings): StartPatch {
  return { starts: withoutStart(sector, settings) };
}

function withoutStart(sector: SectorKey, settings: StartSettings): Partial<Record<SectorKey, string>> {
  const starts = { ...settings.starts };
  delete starts[sector];
  return starts;
}
