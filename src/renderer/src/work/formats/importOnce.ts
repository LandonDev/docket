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
  p.catch(() => imports.delete(key));
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
