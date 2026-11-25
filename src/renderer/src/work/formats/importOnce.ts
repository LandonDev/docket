import type { ImportAnswer } from "@shared/contract-work-formats";
import type { CanvasItem } from "@shared/work";
import { registry } from "../../lib/connection";
import { importsFirst } from "./model";

/** How long an import may take on the host. */
export const IMPORT_MS = 5 * 60_000;

/**
 * One import per key: an effect run again (React's dev check, a remount, a new shell before the host's
 * push closes the item) gets the same answer and makes no second document. A key that failed is
 * forgotten, so Retry asks again. Settled ones go once the item they made is the document's.
 */
const imports = new Map<string, Promise<ImportAnswer>>();

export function importOnce(env: string, key: string, params: Record<string, unknown>): Promise<ImportAnswer> {
  const known = imports.get(key);
  if (known) return known;
  const p = registry.linkOf(env).request<ImportAnswer>("work.formats.import", params, { timeoutMs: IMPORT_MS });
  p.then(keepLosses, () => imports.delete(key));
  imports.set(key, p);
  return p;
}

/**
 * The import that makes a Word (or OpenDocument, RTF, markdown, text) file's item a document: one key for every way it
 * starts, so the Files row that opened it and the item's body share the one import. `attempt` is the body's Retry.
 */
export function importItem(env: string, item: Pick<CanvasItem, "id" | "sessionId" | "source">, attempt = 0): Promise<ImportAnswer> {
  return importOnce(env, `${env}#${item.id}#${JSON.stringify(item.source)}#${attempt}`, { sessionId: item.sessionId, itemId: item.id, from: { at: "source", source: item.source } });
}

/** Starts the import of an item just opened when its kind makes it a document first: right after the open, beside the editor's code. */
export function importAhead(env: string, item: Pick<CanvasItem, "id" | "sessionId" | "source" | "kind">): boolean {
  if (item.kind !== "document" || !importsFirst(item.source)) return false;
  importItem(env, item).catch(() => undefined);
  return true;
}

/** For tests: every import forgotten. */
export function resetImports(): void {
  imports.clear();
}

/**
 * What each import did not keep, by the document it made (its file on its host): Save to Teams names these, and only
 * these, as what the Word file loses (wordSave.ts `lossesLine`). Kept in this window across a reload; a document this
 * window never imported is not known here (null), and its question names what this editor never keeps.
 */
const LOSSES = "tc.work.importLosses";
const KEPT_LOSSES = 100;
// An answer with no source (an older host, a stand-in) keeps no losses.
const lossKey = (source: ImportAnswer["source"] | undefined): string | null => (source?.at === "file" ? `${source.host}\n${source.path}` : null);

function readLosses(): [string, string[]][] {
  try {
    const kept = JSON.parse(globalThis.localStorage?.getItem(LOSSES) ?? "[]") as unknown;
    return Array.isArray(kept) ? (kept as [string, string[]][]) : [];
  } catch {
    return [];
  }
}

function keepLosses(answer: ImportAnswer): void {
  const key = lossKey(answer.source);
  if (!key) return;
  const rows = readLosses().filter(([k]) => k !== key);
  rows.push([key, answer.warnings ?? []]);
  try {
    globalThis.localStorage?.setItem(LOSSES, JSON.stringify(rows.slice(-KEPT_LOSSES)));
  } catch {
    // A window that keeps nothing asks with the list of what this editor never keeps.
  }
}

/** What the import that made this document did not keep; null where this window did not import it. */
export function importLosses(source: ImportAnswer["source"]): string[] | null {
  const key = lossKey(source);
  return key ? (readLosses().find(([k]) => k === key)?.[1] ?? null) : null;
}
