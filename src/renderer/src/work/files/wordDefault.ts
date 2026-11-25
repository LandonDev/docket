/**
 * How a Teams or OneDrive Word file saves before he has chosen for it (decision 4; Settings → Work, "Word files"):
 * `ask`, the default, asks once on his first Save to Teams; `auto` saves it as he works; `press` saves it only on his
 * press. A file he has chosen for keeps its own choice (`WordBack.auto`). Kept in this window.
 */
export type WordDefault = "ask" | "auto" | "press";

const KEY = "tc.work.wordSave";

export const WORD_DEFAULTS: readonly { value: WordDefault; label: string }[] = [
  { value: "ask", label: "Ask the first time" },
  { value: "auto", label: "As I work" },
  { value: "press", label: "When I press Save" },
];

export function wordDefault(): WordDefault {
  try {
    const kept = globalThis.localStorage?.getItem(KEY);
    return kept === "auto" || kept === "press" ? kept : "ask";
  } catch {
    return "ask";
  }
}

export function setWordDefault(value: WordDefault): void {
  try {
    globalThis.localStorage?.setItem(KEY, value);
  } catch {
    // A window that keeps nothing asks the first time.
  }
}
