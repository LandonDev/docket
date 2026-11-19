import type { GuestCreated, GuestLinkRow, GuestRole, GuestSource } from "@shared/contract-work-guests";
import type { CanvasSource } from "@shared/work";
import { registry } from "../../lib/connection";

/**
 * The guests pillar's calls from the renderer (docs/agents/work-guests.md).
 * The rows live on the host that serves LifeOS's documents (the box): a
 * call goes to the host the item's thread is on, and one that answers
 * `served elsewhere: <env>` is asked again there (§19). Type imports only:
 * the contract's zod stays out of this chunk.
 */

const served = (err: unknown): string | null => /served elsewhere: (\S+)/.exec(err instanceof Error ? err.message : String(err))?.[1] ?? null;

export async function guestsCall<T>(env: string, method: string, params: Record<string, unknown>): Promise<{ env: string; value: T }> {
  try {
    return { env, value: await registry.linkOf(env).request<T>(method, params) };
  } catch (err) {
    const there = served(err);
    if (!there || there === env) throw err;
    return { env: there, value: await registry.linkOf(there).request<T>(method, params) };
  }
}

/** A canvas item's source as a link can be for: a LifeOS document or sheet, else null (a file is moved to LifeOS first). */
export function guestSource(source: CanvasSource): GuestSource | null {
  return source.at === "lifeos" && (source.table === "docs" || source.table === "sheets") ? { at: "lifeos", table: source.table, id: source.id } : null;
}

export const ROLE_WORDS: Record<GuestRole, string> = { view: "View", comment: "Comment", edit: "Edit" };

/** The end a new link is offered, in days; thirty unless he picks. */
export const ENDS = [1, 7, 30, 90] as const;
export const dayOf = (at: number): string => new Date(at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
export const shortDay = (at: number): string => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export const isLive = (l: Pick<GuestLinkRow, "revokedAt" | "expiresAt">, now = Date.now()): boolean => l.revokedAt === null && l.expiresAt > now;

export type { GuestCreated, GuestLinkRow, GuestRole, GuestSource };
