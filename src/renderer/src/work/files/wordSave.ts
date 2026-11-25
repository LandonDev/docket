import type { FileTab, WordBack, WordSaved } from "@shared/contract-work-files";
import type { confirmAction, confirmChoice } from "../../chrome/ConfirmDialog";
import { whenWords, type HeaderLine } from "./fileText";

/**
 * A Word file of another computer opened as its document (docs/agents/work-files.md "A Word file from another
 * computer"): his edits are kept in the document, and the Word file changes only by Save to Teams (his press, or by
 * itself once he chose so on his first press), never over a file that changed there. Nothing asks while he types.
 */

/** What Word formatting this editor does not keep (docs/agents/work-docs.md, work-formats.md "A Word file keeps its look"). */
export const WORD_LOSSES = "pictures in table cells, nested tables, fixed line heights, and first-page and even-page headers";

/** Where the Word file lies, as he names it: his own OneDrive, else Teams. */
export const serviceOf = (tab: Pick<FileTab, "key">): string => (tab.key?.startsWith("lib:mine:") ? "OneDrive" : "Teams");

/** The Word file's name, from where it lies. */
export const wordName = (tab: Pick<FileTab, "copyOf" | "name">): string => tab.copyOf?.path.split(/[\\/]/).pop() || tab.name;

/** The header's press that writes his changes into the Word file: the file is Word already, so the act is the place. */
export const wordPress = (tab: Pick<FileTab, "key">): string => `Save to ${serviceOf(tab)}`;

/**
 * What saving over the Word file loses, as one sentence: the losses this file has (what its import did not keep, and
 * what Preview counts for Word, `dropsOf`), none when it has none, and the list of what this editor never keeps when
 * the file's own count is not known in this window (`null`: another window imported it).
 */
export function lossesLine(losses: readonly string[] | null): string {
  if (losses === null) return `Word formatting this editor does not keep may change: ${WORD_LOSSES}.`;
  if (losses.length === 0) return "";
  const said = losses.map((line, i) => (i === 0 ? line : `${line.charAt(0).toLowerCase()}${line.slice(1)}`));
  return `The Word file loses what this editor did not keep: ${said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said.at(-1)}` : said[0]}.`;
}

/** ⌘S on a Word file whose save is his press: his edits are kept in the document, and the Word file waits for that press. */
export const wordWaitsWords = (tab: Pick<FileTab, "copyOf" | "name" | "key">): string => `${wordName(tab)} changes when you press ${wordPress(tab)}.`;

/**
 * The header's line: whether the Word file holds his changes. A save is said of the computer that holds the file
 * (`computer`, as a copy's line names it, fileText.ts `copyLine`): that is all a save knows. It reads as in Teams only
 * once OneDrive there says it has the file (`cloudLine`, laid over this line).
 */
export function wordLine(word: WordBack, service: string, computer: string, now = Date.now(), saving = word.since): HeaderLine {
  // Stopped: an autosave met a change made there; nothing goes until his press.
  if (word.stopped) return { state: "conflict", words: `This file changed in ${service} ${whenWords(word.stopped, now)}` };
  // Refused: the holder said no to the last save (its policy, the fence), in its own words; never still saving.
  if (word.refused) {
    const who = `${computer[0]!.toUpperCase()}${computer.slice(1)}`;
    const why = word.refused.trim().replace(/\.$/, "");
    return { state: "conflict", words: why ? `${who} refused the save. ${why[0]!.toUpperCase()}${why.slice(1)}` : `${who} refused the save` };
  }
  // Its computer or drive not answering: his edits wait in the document, and it is tried again on each look.
  if (word.away && word.since) return { state: "offline", words: `${computer[0]!.toUpperCase()}${computer.slice(1)} is not answering. Changes wait here`, needs: true };
  // Saving by itself: Saving… once his newest words have waited past Word's pause (`saving`, canvas/calm.ts); inside
  // it the last save stays, and a file never saved here says it is unchanged, never Saving with nothing typed.
  if (word.auto) {
    if (word.since && saving) return { state: "saving", words: `Saving to ${computer}…` };
    return word.at ? { state: "saved", words: `Saved to ${computer} ${whenWords(word.at, now)}` } : { state: "copy", words: `The Word file in ${service} has not changed` };
  }
  if (!word.since && word.at) return { state: "saved", words: `Saved to ${computer} as Word ${whenWords(word.at, now)}` };
  if (word.at) return { state: "copy", words: `Changes since ${whenWords(word.at, now)} are not in the Word file` };
  return { state: "copy", words: `The Word file in ${service} has not changed` };
}

/** The Word file's save as every press reaches the host: Keep Both, and Replace over the change a question named, by its version. */
export type WordSave = (keep: boolean, replace?: boolean, version?: string) => Promise<WordSaved>;

/**
 * Save to Teams on the way to Live (liveSwitch.ts `saveWord`): the header's question over the same save, so Replace
 * after a change there goes over that change by its version, as the header's press does. Answers whether the Word file
 * holds his edits now.
 */
export const saveForLive = (tab: Pick<FileTab, "copyOf" | "name" | "key">, save: WordSave, ui: Pick<Parameters<typeof saveAsWord>[1], "choose" | "confirm" | "said">): Promise<boolean> =>
  saveAsWord(tab, { ...ui, save }).then((done) => done === "saved");

/**
 * Save to Teams: one question, naming only the losses this file has (`lossesLine`). His first press on a file
 * (`first`, no choice kept for it yet) asks once whether to save it as he works from then on, and either answer saves
 * it now; after "Ask me each time", each press asks Replace or Keep Both. Over a file that changed there since he
 * opened it, one plain line says when, Keep Both holds the focus, and Replace still writes over it on his press.
 * Answers what was done.
 */
export async function saveAsWord(
  tab: Pick<FileTab, "copyOf" | "name" | "key">,
  deps: {
    choose: typeof confirmChoice;
    confirm: typeof confirmAction;
    save: WordSave;
    said(text: string): void;
    /** what saving over the Word file loses, counted for this file; null where this window does not know */
    losses?: readonly string[] | null;
    /** his first press on the file: his choice from then on is kept for it */
    first?: { set(on: boolean): Promise<unknown> };
  },
  now = Date.now(),
): Promise<"saved" | "kept" | null> {
  const name = wordName(tab);
  const service = serviceOf(tab);
  const losses = lossesLine(deps.losses === undefined ? null : deps.losses);
  const kept = (got: WordSaved): "kept" | null => {
    if (!("copy" in got)) return null;
    deps.said(`Saved beside it as ${got.copy.name}`);
    return "kept";
  };
  let keep = false;
  if (deps.first) {
    const choice = await deps.choose({
      title: `Save ${name} to ${service} as you work?`,
      body: `Everyone who opens it sees your version, and ${service} keeps its own version history.${losses ? ` ${losses}` : ""}`,
      action: "Save automatically",
      other: "Ask me each time",
    });
    if (choice === null) return null;
    await deps.first.set(choice === "action");
  } else {
    const choice = await deps.choose({
      title: `Replace ${name} in ${service}?`,
      body: `Everyone who opens it sees your version.${losses ? ` ${losses}` : ""}`,
      action: "Replace",
      other: "Keep Both",
    });
    if (choice === null) return null;
    keep = choice === "other";
  }
  const got = await deps.save(keep);
  if ("at" in got) return "saved";
  if ("copy" in got) return kept(got);
  if ("gone" in got.conflict) {
    const again = await deps.confirm({ title: `${name} was moved or deleted in ${service}.`, body: "Keep Both puts your version where it was.", action: "Keep Both" });
    return again ? kept(await deps.save(true)) : null;
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
  // Replace goes over the change the line named, by its version, and no later one: a newer change there is said again.
  return "at" in (await deps.save(false, true, got.conflict.version)) ? "saved" : null;
}
