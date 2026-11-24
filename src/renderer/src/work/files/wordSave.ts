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

/**
 * Save as Word: one confirm with what Word may lose, Replace and Keep Both. Over a file that changed there since he
 * opened it, one plain line says when, Keep Both holds the focus, and Replace still writes over it on his press. Answers
 * what was done.
 */
export async function saveAsWord(
  tab: Pick<FileTab, "copyOf" | "name" | "key">,
  deps: { choose: typeof confirmChoice; confirm: typeof confirmAction; save(keep: boolean, replace?: boolean): Promise<WordSaved>; said(text: string): void },
  now = Date.now(),
): Promise<"saved" | "kept" | null> {
  const name = wordName(tab);
  const service = serviceOf(tab);
  const kept = (got: WordSaved): "kept" | null => {
    if (!("copy" in got)) return null;
    deps.said(`Saved beside it as ${got.copy.name}`);
    return "kept";
  };
  const choice = await deps.choose({
    title: `Replace ${name} in ${service}?`,
    body: `Everyone who opens it sees your version. ${service} keeps its own version history, and the Word file as it is now is kept in your workspace's folder. Word formatting this editor does not keep may change: ${WORD_LOSSES}.`,
    action: "Replace",
    other: "Keep Both",
  });
  if (choice === null) return null;
  const got = await deps.save(choice === "other");
  if ("at" in got) return "saved";
  if ("copy" in got) return kept(got);
  if ("gone" in got.conflict) {
    const keep = await deps.confirm({ title: `${name} was moved or deleted in ${service}.`, body: "Keep Both puts your version where it was.", action: "Keep Both" });
    return keep ? kept(await deps.save(true)) : null;
  }
  const again = await deps.choose({
    title: `${name} changed in ${service} ${whenWords(got.conflict.changed, now)}, after you opened it.`,
    body: `Replace puts your version over that change; ${service} keeps its own version history. Keep Both puts yours beside it.`,
    action: "Replace",
    other: "Keep Both",
    focusOther: true,
  });
  if (again === null) return null;
  if (again === "other") return kept(await deps.save(true));
  return "at" in (await deps.save(false, true)) ? "saved" : null;
}
