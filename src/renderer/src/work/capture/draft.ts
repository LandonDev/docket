import type { SectorKey } from "@shared/work";

/**
 * The capture window's pure parts (docs/agents/work-capture.md): the
 * sector choices in their order, which one a key picks, and whether a
 * draft can be filed where it is pointed.
 */

export const CAPTURE_SECTORS: readonly SectorKey[] = ["cosmic", "hypixel", "purdue", "ref", "unify", "life"];
/** Unsorted first: ⌘1 leaves it for LifeOS's bot, ⌘2 to ⌘7 pick a sector. */
export type SectorChoice = "unsorted" | SectorKey;
export const SECTOR_CHOICES: readonly SectorChoice[] = ["unsorted", ...CAPTURE_SECTORS];

export const choiceLabel = (c: SectorChoice): string => (c === "unsorted" ? "Unsorted" : c.charAt(0).toUpperCase() + c.slice(1));

/** Tab and Shift+Tab step through the choices, round. */
export function stepChoice(c: SectorChoice, by: 1 | -1): SectorChoice {
  const i = SECTOR_CHOICES.indexOf(c);
  return SECTOR_CHOICES[(i + by + SECTOR_CHOICES.length) % SECTOR_CHOICES.length]!;
}

/** The choice ⌘1 to ⌘7 names, by the digit's key; null for any other key. */
export function choiceOfDigit(code: string): SectorChoice | null {
  const n = /^Digit([1-7])$/.exec(code)?.[1];
  return n ? SECTOR_CHOICES[Number(n) - 1]! : null;
}

/** Where its files are kept: an unsorted capture waits in Life. */
export const homeSector = (c: SectorChoice): SectorKey => (c === "unsorted" ? "life" : c);

export interface DraftFile {
  id: string;
  name: string;
  path: string;
}

/** Why the draft cannot be filed as it is, in words for the window; null when it can. */
export function draftRefusal(d: { text: string; files: readonly DraftFile[]; sector: SectorChoice }, homes: readonly SectorKey[]): string | null {
  if (!d.text.trim() && !d.files.length) return "";
  const home = homeSector(d.sector);
  if (d.files.length && !homes.includes(home)) return `No ${choiceLabel(home)} workspace on this computer to keep the file in`;
  return null;
}

/** A fresh key for a capture: a retry of the same one files nothing twice. */
export const captureKey = (): string => crypto.randomUUID();
