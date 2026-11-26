import { saveThemePreference, type ThemePreference } from "../../lib/appearance";
import { saveDefaultModel } from "../../lib/models";
import type { HarnessId } from "../../lib/session";

/**
 * The computer's side of the setup link, as rules apart from the screens
 * (docs/agents/pc-setup.md "The screens"): when the first screen opens by
 * itself, and the seeds the giver's window sent, written into this window's
 * storage once.
 */

/** Set once the first screen was shown and closed, so it never opens by itself again. */
export const SETUP_OFFERED_KEY = "docket.setupOffered";
/** Set once the seeds landed, so a second read of the state never writes them over his own choices. */
export const SETUP_SEEDED_KEY = "docket.setupSeeded";

/** A fresh install: no saved hosts, no workspaces and no accounts, each known (null is not yet read). */
export function isFreshInstall(p: { savedHosts: number | null; workspaces: number | null; accounts: number | null }): boolean {
  return p.savedHosts === 0 && p.workspaces === 0 && p.accounts === 0;
}

const THEMES: readonly ThemePreference[] = ["dark", "light", "system"];

/**
 * The seeds into this window's storage, once: the theme per kind of place
 * (lib/appearance.ts) and the default models (lib/models.ts). Answers whether
 * it wrote; nothing of this syncs afterwards.
 */
export function writeSeedsOnce(seeds: { appearance?: unknown; defaultModels?: unknown } | null): boolean {
  try {
    if (!seeds || localStorage.getItem(SETUP_SEEDED_KEY)) return false;
    // The giver's window sent them; each value is checked here before it lands.
    const appearance = isRecord(seeds.appearance) ? seeds.appearance : {};
    for (const kind of ["code", "work"] as const) {
      const theme = appearance[kind];
      if (typeof theme === "string" && (THEMES as readonly string[]).includes(theme)) saveThemePreference(kind, theme as ThemePreference);
    }
    // A provider this build does not know is dropped on read (loadDefaultModels).
    const models = isRecord(seeds.defaultModels) ? seeds.defaultModels : {};
    for (const [harness, model] of Object.entries(models)) if (typeof model === "string" && model) saveDefaultModel(harness as HarnessId, model);
    localStorage.setItem(SETUP_SEEDED_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** "docket.landonhale.com" from the box's origin, as the confirm names it. */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}
