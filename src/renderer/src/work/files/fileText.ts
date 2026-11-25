import type { CloudBack, CopyBack } from "@shared/contract-work-files";
import { extOf, FILE_TEXT_MAX, kindOfEntry, PROSE_EXTS } from "@shared/work/files";
import type { SavedLine } from "../canvas/kind";

/**
 * A text file as the `file` kind edits it (docs/agents/work-files.md "The file kind"), and the words of the save
 * line. A file's bytes are kept as they were where the editor does not show them: its byte order mark and its
 * line ends go back on a save, so opening a file and changing one word changes that word alone.
 */

export interface TextFile {
  /** as the editor shows it: no mark, `\n` line ends */
  text: string;
  /** it began with a UTF-8 byte order mark */
  bom: boolean;
  /** its lines end `\r\n` */
  crlf: boolean;
}

/** A file's bytes as text; null when they are not text this editor can keep whole (not UTF-8, or a NUL in them). */
export function decodeText(bytes: Uint8Array): TextFile | null {
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  if (raw.includes("\0")) return null;
  const bom = raw.startsWith("﻿");
  const body = bom ? raw.slice(1) : raw;
  // Mixed line ends are kept as they are: only a file that is `\r\n` throughout is shown, and saved, as one.
  const crlf = body.includes("\r\n") && !/(^|[^\r])\n/.test(body) && !/\r(?!\n)/.test(body);
  return { text: crlf ? body.replaceAll("\r\n", "\n") : body, bom, crlf };
}

/** The editor's text as the file keeps it. */
export const encodeText = (text: string, file: Pick<TextFile, "bom" | "crlf">): string => `${file.bom ? "﻿" : ""}${file.crlf ? text.replaceAll("\n", "\r\n") : text}`;

export function bytesOfBase64(data: string): Uint8Array {
  const raw = atob(data);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Whether a file is tried as text: one the table calls text, and one it does not know at all (a `Makefile`, a
 * `.env`, a `LICENSE`), which is shown as text when its bytes are. A file past the size an editor keeps is not.
 */
export function triedAsText(name: string, size: number | undefined): boolean {
  if (size !== undefined && size > FILE_TEXT_MAX) return false;
  const kind = kindOfEntry(name).kind;
  return kind === "text" || kind === "other";
}

/** Prose wraps and has no line numbers; code keeps its lines. */
export const isProse = (name: string): boolean => (PROSE_EXTS as readonly string[]).includes(extOf(name)) || extOf(name) === "";

const clock = (at: number): string => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString();
/** "1:52 PM" today, "Nov 21, 1:52 PM" before. */
export function whenWords(at: number, now = Date.now()): string {
  return sameDay(at, now) ? clock(at) : `${new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${clock(at)}`;
}

/**
 * The save line's words, without its presses (docs/DESIGN.md "The Files place"): what saved means now, in one
 * line. `where` is the folder the file is kept in, as the trail names it, for a kind that did not say.
 */
export function savedWords(line: SavedLine, where: string | null, now = Date.now()): string {
  const place = line.where ?? where;
  switch (line.state) {
    case "saved":
      return line.at ? `Saved ${whenWords(line.at, now)}${place ? ` in ${place}` : ""}` : place ? `Saved in ${place}` : "Saved";
    case "saving":
      return "Saving…";
    case "offline": {
      const n = line.pending ?? 0;
      return n > 0 ? `Offline. ${n} ${n === 1 ? "change waits" : "changes wait"} here` : "Offline";
    }
    case "conflict":
      return line.detail ?? "This file changed somewhere else";
    case "readonly":
      // A whole sentence stands beside the words; a few words follow them after a comma, never a label's colon.
      return !line.detail ? "Read only" : line.detail.endsWith(".") ? `Read only. ${line.detail.slice(0, -1)}` : `Read only, ${line.detail}`;
    case "copy":
      return line.detail ? `A copy from ${line.detail}. Changes stay here` : "A copy. Changes stay here";
    case "downloading":
      return line.detail ? `Downloading ${line.detail}` : "Downloading…";
    case "asleep":
      return line.at ? `${line.detail ?? "Its computer"} is asleep. This is the copy from ${whenWords(line.at, now)}` : `${line.detail ?? "Its computer"} is asleep`;
  }
}

/** The line reads as trouble: drawn in the foreground, not muted, so it is not missed. Only a conflict and waiting changes are. */
export const savedNeedsHim = (line: SavedLine): boolean => line.state === "conflict" || (line.state === "offline" && (line.pending ?? 0) > 0);

/** A header line whose words the frame wrote itself (a copy's), and whether it needs him when its state alone would not say. */
export type HeaderLine = SavedLine & { words?: string; needs?: boolean };

/** What his window knows of its own ask for a send (FileTabView.tsx): one under way, or the host's refusal of it. */
export interface CopyAsk {
  owed?: boolean;
  failed?: string;
  /** the copy's writes as known when his edit began saving: a save that wrote none after them is not called Saved */
  base?: number;
}

/** Of the tab's word and his ask's answer on how sending stands, the one that knows more of the copy's writes and of what the file holds. */
export function newestBack(tab: CopyBack, answer: CopyBack | undefined): CopyBack {
  if (answer?.writes === undefined || answer.held === undefined) return tab;
  if (tab.writes === undefined || tab.held === undefined) return answer;
  return answer.writes > tab.writes || (answer.writes === tab.writes && answer.held > tab.held) ? answer : tab;
}

/**
 * The line of a copy whose edits go nowhere (docs/DESIGN.md "A document opened as a copy"): they stay in this tab, not
 * on the computer that holds the file; Save As… where its kind has one, and Open on that computer where it can.
 */
export function staysLine(host: string, saveAs?: () => void, openThere?: () => void): HeaderLine {
  const actions = [...(saveAs ? [{ id: "save-as", label: "Save As…", run: saveAs }] : []), ...(openThere ? [{ id: "there", label: `Open on ${host}`, run: openThere }] : [])];
  return { state: "copy", detail: host, words: `Edits stay in this tab, not on ${host}`, ...(actions.length ? { actions } : {}) };
}

/** Whether a send's answer is how sending stands (an older frame's send answers nothing). */
export const isCopyBack = (x: unknown): x is CopyBack => !!x && typeof x === "object" && typeof (x as { is?: unknown }).is === "string";

/**
 * The line of a copy that saves back to its file on another computer (docs/DESIGN.md "The Files place"): where the
 * file is and whether it holds his changes, in the computer's own name. What the kind says of the copy itself
 * comes first where it is trouble here (its own conflict, read only, offline); its saving and saved are about the
 * copy, so the line says the file's instead. The presses are the frame's (FileTabView.tsx).
 */
export function copyLine(kind: SavedLine | null, back: CopyBack, host: string, now = Date.now(), ask: CopyAsk = {}): HeaderLine {
  if (kind && kind.state !== "saved" && kind.state !== "saving" && kind.state !== "copy") return kind;
  // A save of his the host has not answered yet is no change in the file: it never reads as saved.
  if (kind?.state === "saving" || back.is === "sending" || (ask.owed && back.is === "ok")) return { state: "saving", words: `Saving to ${host}…` };
  if (ask.failed && back.is === "ok") {
    const why = ask.failed.trim().replace(/\.$/, "");
    return { state: "conflict", words: why ? `Not saved to ${host}. ${why[0]!.toUpperCase()}${why.slice(1)}` : `Not saved to ${host}` };
  }
  switch (back.is) {
    case "changed":
      return { state: "conflict", words: `This file changed on ${host}` };
    case "gone":
      return { state: "conflict", words: `This file was moved or deleted on ${host}` };
    case "away":
      return { state: "offline", words: `${host} is not answering. Changes wait here`, needs: true };
    case "refused": {
      const why = back.detail?.trim().replace(/\.$/, "");
      return { state: "conflict", words: why ? `${host} refused the save. ${why[0]!.toUpperCase()}${why.slice(1)}` : `${host} refused the save` };
    }
    default:
      // Saved is said of a write of the copy the file holds (an older host says neither count): a write it does not
      // hold yet is still saving, and a save of his that wrote nothing into the copy saved nothing there.
      if (back.writes !== undefined && back.held !== undefined) {
        if (back.held < back.writes) return { state: "saving", words: `Saving to ${host}…` };
        if (ask.base !== undefined && back.writes <= ask.base) return { state: "saved", words: `On ${host}` };
      }
      return { state: "saved", words: back.at ? `Saved to ${host} ${whenWords(back.at, now)}` : `On ${host}` };
  }
}

/** Why an upload is late, as the line says it, with what he can do about it. */
const LATE_WHY: Record<NonNullable<CloudBack["why"]> | "paused", (computer: string) => string> = {
  asleep: (computer) => `${computer[0]!.toUpperCase()}${computer.slice(1)} is asleep. It uploads when it wakes`,
  stopped: (computer) => `OneDrive is not running on ${computer}. Start it there`,
  "signed-out": (computer) => `OneDrive is signed out on ${computer}. Sign in there`,
  paused: (computer) => `OneDrive on ${computer} may be paused. Resume it there`,
};

/**
 * A saved line of a file in a Teams or OneDrive library, told by what OneDrive has done with our save (docs/DESIGN.md
 * "The Files place"): the computer holding the bytes is not yet the file in Teams. `service` is Teams or OneDrive,
 * `computer` the one that holds the file ("the Windows VM"). Any other line stands as it is.
 */
export function cloudLine(line: HeaderLine, cloud: CloudBack | undefined, service: string, computer: string, now = Date.now()): HeaderLine {
  if (line.state !== "saved" || !cloud) return line;
  switch (cloud.is) {
    case "uploading":
      return { ...line, state: "saving", words: `Saved, uploading to ${service}…` };
    case "uploaded":
      return { ...line, state: "saved", words: `In ${service} ${whenWords(cloud.at, now)}` };
    case "late":
      return { ...line, state: "offline", words: `Not uploaded to ${service} yet. ${LATE_WHY[cloud.why ?? "paused"](computer)}`, needs: true };
    default:
      return { ...line, state: "saved", words: `Saved to ${computer}. OneDrive uploads it` };
  }
}

/**
 * Whether a copy's kind has just saved, so its tab asks the host to send the copy back: it went from saving to
 * saved, or it says a newer save time. A line read at open (a file's own change time) is no save of his.
 */
export function copyBackDue(was: SavedLine | null, now: SavedLine | null): boolean {
  if (now?.state !== "saved") return false;
  if (was?.state === "saving") return true;
  return was?.state === "saved" && !!was.at && !!now.at && now.at !== was.at;
}

