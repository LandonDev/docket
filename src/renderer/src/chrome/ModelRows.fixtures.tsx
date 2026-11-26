import { modelsFor } from "../lib/models";
import { HARNESS_TITLE, type HarnessId } from "../lib/session";

/** `bun run ui:preview src/renderer/src/chrome/ModelRows.tsx#ModelRows`: the
 *  model picker's open body (the field and its list): the Claude and Codex
 *  tabs with Meta's group, from the built-in rows, a search across providers
 *  and no match. Keys, the still pointer and picks are DOM-tested
 *  (ModelPicker.dom.test.tsx). */
const base = {
  query: "",
  available: () => true,
  harnessTitle: (id: HarnessId) => HARNESS_TITLE[id],
  unavailableHint: () => "Not installed on this host",
  favorites: [] as string[],
  grouped: true,
  emptyLabel: "No matching models",
  onQuery: () => {},
  onPick: () => {},
  onToggleFavorite: () => {},
};

const claude = modelsFor("claude").filter((m) => !m.vendor).slice(0, 3);
const claudeMeta = modelsFor("claude").filter((m) => m.vendor);
const codexMeta = modelsFor("codex").filter((m) => m.vendor);
const gpt = [
  { id: "codex:gpt-6.1-sol", harness: "codex" as const, name: "GPT-6.1 Sol", nativeId: "gpt-6.1-sol" },
  { id: "codex:gpt-5.5", harness: "codex" as const, name: "GPT-5.5", nativeId: "gpt-5.5" },
];

export default [
  { name: "Claude tab", props: { ...base, models: [...claude, ...claudeMeta], currentId: claude[0].id } },
  { name: "Codex tab, Wonder picked", props: { ...base, models: [...gpt, ...codexMeta], currentId: codexMeta[0].id } },
  { name: "Muse Code tab", props: { ...base, models: modelsFor("muse"), currentId: modelsFor("muse")[0].id } },
  { name: "Search: muse", props: { ...base, query: "muse", grouped: false, models: [...claudeMeta, ...codexMeta], currentId: "", favorites: [claudeMeta[0].id] } },
  { name: "No match", props: { ...base, query: "zzz", grouped: false, models: [], currentId: "" } },
];
