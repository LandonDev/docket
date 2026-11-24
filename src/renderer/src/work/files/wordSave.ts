import type { FileTab, WordBack, WordSaved } from "@shared/contract-work-files";
import type { confirmAction, confirmChoice } from "../../chrome/ConfirmDialog";
import { whenWords, type HeaderLine } from "./fileText";

/**
 * A Word file of another computer opened as its document (docs/agents/work-files.md "A Word file from another
 * computer"): his edits are kept in the document, and the Word file changes only by Save as Word, asked once with what
 * Word may lose, never over a file that changed there.
 */

/** What Word formatting this editor does not keep (docs/agents/work-docs.md, work-formats.md "A Word file keeps its look"). */
export const WORD_LOSSES = "pictures in table cells, nested tables, fixed line heights, and first-page and even-page headers";

/** Where the Word file lies, as he names it: his own OneDrive, else Teams. */
export const serviceOf = (tab: Pick<FileTab, "key">): string => (tab.key?.startsWith("lib:mine:") ? "OneDrive" : "Teams");

/** The Word file's name, from where it lies. */
export const wordName = (tab: Pick<FileTab, "copyOf" | "name">): string => tab.copyOf?.path.split(/[\\/]/).pop() || tab.name;

/** The header's line: whether the Word file holds his changes. */
export function wordLine(word: WordBack, service: string, now = Date.now()): HeaderLine {
  if (!word.since && word.at) return { state: "saved", words: `Saved to ${service} as Word ${whenWords(word.at, now)}` };
  if (word.at) return { state: "copy", words: `Changes since ${whenWords(word.at, now)} are not in the Word file` };
  return { state: "copy", words: `The Word file in ${service} has not changed` };
}

/** Save as Word: one confirm with what Word may lose and Keep Both beside Replace; over a file that changed there, Keep Both alone. Answers what was done. */
export async function saveAsWord(
  tab: Pick<FileTab, "copyOf" | "name" | "key">,
  deps: { choose: typeof confirmChoice; confirm: typeof confirmAction; save(keep: boolean): Promise<WordSaved>; said(text: string): void },
): Promise<"saved" | "kept" | null> {
  const name = wordName(tab);
  const service = serviceOf(tab);
  const choice = await deps.choose({
    title: `Replace ${name} in ${service}?`,
    body: `Everyone who opens it sees your version. Word formatting this editor does not keep may change: ${WORD_LOSSES}.`,
    action: "Replace",
    other: "Keep Both",
  });
  if (choice === null) return null;
  const got = await deps.save(choice === "other");
  if ("at" in got) return "saved";
  if ("copy" in got) {
    deps.said(`Saved beside it as ${got.copy.name}`);
    return "kept";
  }
  const gone = "gone" in got.conflict;
  const keep = await deps.confirm({
    title: gone ? `${name} was moved or deleted in ${service}.` : `${name} changed in ${service} since you opened it.`,
    body: "Nothing was written over it. Keep Both puts your version beside it.",
    action: "Keep Both",
  });
  if (!keep) return null;
  const kept = await deps.save(true);
  if ("copy" in kept) deps.said(`Saved beside it as ${kept.copy.name}`);
  return "copy" in kept ? "kept" : null;
}
