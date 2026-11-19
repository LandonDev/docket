import { IS_MAC } from "./platform";

/**
 * One key map for every platform. The command modifier is ⌘ on a Mac and
 * Ctrl everywhere else, and a hint is written the way its platform writes
 * it: ⌘⇧M on a Mac, Ctrl+Shift+M on Windows and Linux. Every handler asks
 * the predicates here and every hint goes through `keyHint` or `keyCaps`;
 * no other renderer file reads `metaKey` or types a key glyph
 * (lib/keysGuard.test.ts). The platform is the one the window runs on
 * (`IS_MAC`), so the /ui page in a Windows browser reads Ctrl too.
 */

type Mods = Pick<KeyboardEvent, "metaKey" | "ctrlKey">;
type AllMods = Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/** The command modifier, alone of the two: ⌘ without Ctrl on a Mac, Ctrl without the Windows key elsewhere. */
export function modKey(e: Mods, mac = IS_MAC): boolean {
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/**
 * Either command key, ⌘ or Ctrl, on every platform: what most chords here
 * have always taken (Ctrl+Enter submits a dialog on a Mac as ⌘Enter does).
 * `modKey` is for the few where Ctrl on a Mac means something else.
 */
export function modOrCtrl(e: Mods): boolean {
  return e.metaKey || e.ctrlKey;
}

/** Control itself, whatever the platform: the terminal's and the editor's own chords (⌃Tab, ⌃`, ⌃D). */
export function ctrlOnly(e: Mods): boolean {
  return e.ctrlKey && !e.metaKey;
}

/** ⌘ on a Mac and nothing anywhere else: for a key Windows gives to Ctrl with another meaning (⌘C copies, Ctrl+C interrupts). */
export function macCommand(e: Mods, mac = IS_MAC): boolean {
  return mac && e.metaKey && !e.ctrlKey;
}

/** Alt and nothing else. */
export function altOnly(e: AllMods): boolean {
  return e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey;
}

/** A chord modifier is down (⌘, Ctrl or Alt): the key is a command, not typing. */
export function chordKey(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey">): boolean {
  return e.metaKey || e.ctrlKey || e.altKey;
}

/** No modifier at all. */
export function bareKey(e: AllMods): boolean {
  return !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey);
}

// Each name's cap on a Mac, then elsewhere. `enter` and `return` are one key; the Mac's hints draw it both ways, so both names stay.
const CAPS: Record<string, string> = { mod: "⌘Ctrl", ctrl: "⌃Ctrl", alt: "⌥Alt", shift: "⇧Shift", enter: "⏎Enter", return: "↩Enter", delete: "⌫Delete" };

/**
 * A chord as key caps, one per key: `keyCaps("mod+shift+M")` is ["⌘", "⇧", "M"]
 * on a Mac and ["Ctrl", "Shift", "M"] elsewhere. The names are `mod`, `ctrl`,
 * `alt`, `shift`, `enter`, `return` and `delete`; anything else is the key as
 * written ("mod++" ends in the plus key).
 */
export function keyCaps(chord: string, mac = IS_MAC): string[] {
  const plus = chord.endsWith("++") || chord === "+";
  const parts = (plus ? chord.slice(0, -1) : chord).split("+").filter(Boolean);
  if (plus) parts.push("+");
  return parts.map((part) => (CAPS[part] ? (mac ? CAPS[part][0] : CAPS[part].slice(1)) : part));
}

/** Caps as one hint: run together on a Mac ("⌘⇧M"), joined by a plus elsewhere ("Ctrl+Shift+M"). */
export function joinCaps(caps: readonly string[], mac = IS_MAC): string {
  return caps.join(mac ? "" : "+");
}

/** A chord as the text of one hint: `keyHint("mod+shift+M")` is "⌘⇧M" on a Mac, "Ctrl+Shift+M" elsewhere. */
export function keyHint(chord: string, mac = IS_MAC): string {
  return joinCaps(keyCaps(chord, mac), mac);
}
