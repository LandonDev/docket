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
      // A whole sentence stands beside the words; a few words follow them.
      return !line.detail ? "Read only" : line.detail.endsWith(".") ? `Read only. ${line.detail.slice(0, -1)}` : `Read only: ${line.detail}`;
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
