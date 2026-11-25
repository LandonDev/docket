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

/**
 * What each editor keeps of an edit, by kind: a text file's words; a sheet's mutations the host has not answered (sent
 * and queued, in order), made on the file's revision; a deck's open typing box: the shape it is on, that shape's words
 * as the box opened on them (the host's check, as a commit's), and the box's model (words, runs and the looks they
 * carry); a document's sync updates the service has not said it applied, each a frame as its socket sends it (base64).
 */
export type DraftBody =
  | { kind: "text"; text: string; bom: boolean; crlf: boolean }
  | { kind: "sheet"; mutations: { id: string; params: unknown }[] }
  | { kind: "deck"; slideId: number; shapeId: number; /** a table's cell the box typed in */ cell?: { row: number; col: number }; words: string[][]; model: unknown }
  | { kind: "document"; frames: string[] };
export type DraftKind = DraftBody["kind"];

export interface Draft extends DraftKey {
  /** the file's name when the edit was made */
  name: string;
  /** epoch ms of the edit */
  at: number;
  body: DraftBody;
}

/** The longest draft kept, in characters (a body's JSON for the kinds that are not words): a text editor holds no more (`FILE_TEXT_MAX`, 2 MB). */
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
  const body = bodyOf(d.body);
  return body ? { ...key, name: d.name, at: d.at, body } : null;
}

const fits = (v: unknown): boolean => {
  try {
    return JSON.stringify(v).length <= DRAFT_MAX_CHARS;
  } catch {
    return false;
  }
};

/** A body of a kind this build keeps, within the size kept; null for anything else. */
function bodyOf(v: unknown): DraftBody | null {
  const b = v as { kind?: unknown } | null | undefined;
  if (!b || typeof b !== "object") return null;
  if (b.kind === "text") {
    const t = b as Partial<Extract<DraftBody, { kind: "text" }>>;
    return typeof t.text === "string" && t.text.length <= DRAFT_MAX_CHARS ? { kind: "text", text: t.text, bom: t.bom === true, crlf: t.crlf === true } : null;
  }
  if (b.kind === "sheet") {
    const m = (b as { mutations?: unknown }).mutations;
    if (!Array.isArray(m) || m.length === 0 || !m.every((x) => x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string") || !fits(m)) return null;
    return { kind: "sheet", mutations: m.map((x: { id: string; params?: unknown }) => ({ id: x.id, params: x.params ?? null })) };
  }
  if (b.kind === "deck") {
    const d = b as Partial<Extract<DraftBody, { kind: "deck" }>>;
    const words = Array.isArray(d.words) && d.words.every((p) => Array.isArray(p) && p.every((r) => typeof r === "string"));
    if (!Number.isInteger(d.slideId) || !Number.isInteger(d.shapeId) || !words || !Array.isArray(d.model) || !fits(d)) return null;
    const cell = d.cell && Number.isInteger(d.cell.row) && Number.isInteger(d.cell.col) && d.cell.row >= 0 && d.cell.col >= 0 ? { row: d.cell.row, col: d.cell.col } : undefined;
    return { kind: "deck", slideId: d.slideId!, shapeId: d.shapeId!, ...(cell ? { cell } : {}), words: d.words!, model: d.model };
  }
  if (b.kind === "document") {
    const f = (b as { frames?: unknown }).frames;
    if (!Array.isArray(f) || f.length === 0 || !f.every((x) => typeof x === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(x)) || !fits(f)) return null;
    return { kind: "document", frames: f as string[] };
  }
  return null;
}
