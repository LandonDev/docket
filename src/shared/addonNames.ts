/** Proper product names for addon references — a connector mention reads
 *  as the product ("Linear", "GitHub"), never as a slash token. Shared: the
 *  renderer's rows and chips and the server's working line ("Using LifeOS")
 *  name a server the same way; the iOS client keeps its own copy in
 *  ActionRow.swift. */
const PROPER: Record<string, string> = {
  github: "GitHub",
  "google-drive": "Google Drive",
  googledrive: "Google Drive",
  heroui: "HeroUI",
  lifeos: "LifeOS",
  reui: "ReUI",
  node_repl: "Node REPL",
  openaideveloperdocs: "OpenAI Docs",
  pdf: "PDF",
  "computer-use": "Computer Use",
};

export function addonTitle(name: string): string {
  const known = PROPER[name.toLowerCase()];
  if (known) return known;
  return name
    .split(/[-_]/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

const ADDON_CALL_NAMES = new Set(["mcp__app__addon_call", "app.addon_call"]);

/** The add-on and its tool behind a call through the app server, so the row
 *  wears the add-on's name and mark rather than the app's: Claude's exposed
 *  `mcp__app__<addon>__<tool>`, or the bridge's `addon_call` (Codex, Muse)
 *  whose input names `<addon>__<tool>`. Add-on names hold no underscore
 *  (ADDON_NAME_RE), so the first `__` splits them. Anything else → null. */
export function addonCallOf(name: string, input: unknown): { addon: string; tool: string } | null {
  const exposed = name.startsWith("mcp__app__") && !ADDON_CALL_NAMES.has(name) ? name.slice("mcp__app__".length) : null;
  const called = ADDON_CALL_NAMES.has(name) ? (input as { tool?: unknown } | null)?.tool : null;
  const pair = exposed ?? (typeof called === "string" ? called : null);
  const cut = pair?.indexOf("__") ?? -1;
  if (!pair || cut <= 0 || cut + 2 >= pair.length) return null;
  return { addon: pair.slice(0, cut), tool: pair.slice(cut + 2) };
}
