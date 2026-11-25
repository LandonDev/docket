/**
 * A draft: an edit his window made that the file's host has not acknowledged yet (docs/agents/work-files.md "Drafts
 * survive a crash"). The window journals each one while he edits into a store this computer's main process writes
 * (src/main/drafts.ts), under the app's own data, never in a synced folder, a guest page or anything a thread or a
 * remote key can read. On the next open of the file it is offered back, through the same version checks as a live
 * edit: a draft whose base is no longer the file's version is kept beside it, never written over it.
 */

/** Where a draft belongs: the workspace, the host the window asked, the file as its item names it, and the version it was made on. */
export interface DraftKey {
  workspaceId: string;
  /** the host the window asked for the file (the link's environment) */
  holder: string;
  /** the file's identity: its canvas source, as `draftFileOf` writes it */
  file: string;
  /** the file's version the edit was made on */
  base: string;
}

/** What each editor keeps of an edit, by kind. */
export type DraftBody = { kind: "text"; text: string; bom: boolean; crlf: boolean };

export interface Draft extends DraftKey {
  /** the file's name when the edit was made */
  name: string;
  /** epoch ms of the edit */
  at: number;
  body: DraftBody;
}

/** The longest draft kept, in characters: a text editor holds no more (`FILE_TEXT_MAX`, 2 MB). */
export const DRAFT_MAX_CHARS = 4 * 1024 * 1024;

/** A canvas source as one string, its keys sorted, so the same file is the same identity from any window. */
export function draftFileOf(source: object): string {
  const sorted = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sorted(source));
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096;

/** A key from the window, checked: four strings, each short. */
export function draftKeyOf(v: unknown): DraftKey | null {
  const k = v as Partial<DraftKey> | null;
  if (!k || !isStr(k.workspaceId) || !isStr(k.holder) || !isStr(k.file) || !isStr(k.base)) return null;
  return { workspaceId: k.workspaceId, holder: k.holder, file: k.file, base: k.base };
}

/** A draft from the window, checked: its key, a name, a time and a body of a kind this build keeps. */
export function draftOf(v: unknown): Draft | null {
  const d = v as Partial<Draft> | null;
  const key = draftKeyOf(d);
  if (!key || !d || !isStr(d.name) || typeof d.at !== "number" || !Number.isFinite(d.at)) return null;
  const b = d.body as Partial<Extract<DraftBody, { kind: "text" }>> | undefined;
  if (!b || b.kind !== "text" || typeof b.text !== "string" || b.text.length > DRAFT_MAX_CHARS) return null;
  return { ...key, name: d.name, at: d.at, body: { kind: "text", text: b.text, bom: b.bom === true, crlf: b.crlf === true } };
}
