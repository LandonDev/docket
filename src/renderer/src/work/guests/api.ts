import type { GuestCreated, GuestLinkRow, GuestRole, GuestSource } from "@shared/contract-work-guests";
import { SHARE_REFUSALS } from "@shared/work/guestRoles";
export { guestRolesOf, isShareRefusal, SHARE_REFUSALS } from "@shared/work/guestRoles";
import type { CanvasSource } from "@shared/work";
import type { OfficeLiveAddress } from "@shared/contract-work-office";
import { registry } from "../../lib/connection";
import { clockTime } from "../../lib/duration";
import { guestRolesOf } from "@shared/work/guestRoles";

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

/** A canvas item's source as a link can be for: a LifeOS document or sheet, or a `.tcdoc` or `.tcsheet` kept as a file; else null. */
export function guestSource(source: CanvasSource): GuestSource | null {
  if (source.at === "lifeos" && (source.table === "docs" || source.table === "sheets")) return { at: "lifeos", table: source.table, id: source.id };
  if (source.at === "file" && /\.tc(doc|sheet)$/i.test(source.path)) return { at: "file", host: source.host, path: source.path };
  return null;
}


/**
 * What Share offers for a document's or a sheet's item: the link's source, or the one line that says what to do
 * instead; null where Share is not drawn at all (a mail's attachment, which is not his yet).
 */
export function shareTargetOf(source: CanvasSource, kind: "document" | "sheet"): { source: GuestSource } | { why: string } | null {
  const got = guestSource(source);
  if (got) return { source: got };
  if (source.at === "mail") return null;
  if (source.at === "google") return { why: SHARE_REFUSALS.google };
  // A Word file or a workbook whose truth is a Teams file (its address, or a library on a disk) is shared where it lives.
  if (source.at === "microsoft") return { why: source.ref.kind === "url" ? SHARE_REFUSALS.teams : kind === "sheet" ? SHARE_REFUSALS.excel : SHARE_REFUSALS.word };
  if (source.at === "file") return { why: /\.(docx?|odt|rtf)$/i.test(source.path) ? SHARE_REFUSALS.word : /\.(xlsx?|xlsm|ods|csv|tsv)$/i.test(source.path) ? SHARE_REFUSALS.excel : SHARE_REFUSALS.other };
  return { why: SHARE_REFUSALS.other };
}

/** The files a library can show on its own web page: Office's, and a TempCode document kept for a Word file there. */
export const mayHavePage = (path: string): boolean => /\.(docx|xlsx|xlsm|pptx|tcdoc)$/i.test(path);

/** Where a file others open is shared from, by its page's address: his own OneDrive's (`-my.sharepoint.com`), else Teams. */
export function shareHomeOf(url: string): "Teams" | "OneDrive" {
  try {
    return /-my\.sharepoint\.com$/i.test(new URL(url).hostname) ? "OneDrive" : "Teams";
  } catch {
    return "Teams";
  }
}

/**
 * A library file's own web page in his tenant, as the workspace's host knows it (`work.office.live.address`: the
 * library's web folder from its sync, or the address he gave), for Share in Teams; the Word file's for a document kept
 * for one. Null where the host knows none: Share in Teams is then greyed, never a guess. Undefined where the ask did
 * not get an answer: nothing is known, so a caller keeps nothing and asks again.
 */
export async function filePageOf(env: string, workspaceId: string, source: CanvasSource): Promise<string | null | undefined> {
  const got = await fileShareOf(env, workspaceId, source);
  return got === undefined ? undefined : got.url;
}

/**
 * `filePageOf` with where the file is shared from when its page is not known (`home`: a library's file, so Share is
 * greyed with "Share it from Teams.", never a sheet that only says no). Undefined where the ask got no answer.
 */
export async function fileShareOf(env: string, workspaceId: string, source: CanvasSource): Promise<{ url: string | null; home?: "Teams" | "OneDrive" } | undefined> {
  if (source.at !== "file" || !mayHavePage(source.path)) return { url: null };
  try {
    const got = await registry.linkOf(env).request<OfficeLiveAddress>("work.office.live.address", { workspaceId, ref: source });
    return { url: got.address ?? null, ...(got.home ? { home: got.home } : {}) };
  } catch {
    return undefined;
  }
}

export const ROLE_WORDS: Record<GuestRole, string> = { view: "View", comment: "Comment", edit: "Edit" };

/** The end a new link is offered, in days; thirty unless he picks. */
export const ENDS = [1, 7, 30, 90] as const;
export const dayOf = (at: number): string => new Date(at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
export const shortDay = (at: number): string => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export const isLive = (l: Pick<GuestLinkRow, "revokedAt" | "expiresAt">, now = Date.now()): boolean => l.revokedAt === null && l.expiresAt > now;

/** The folder a file is in, by its name alone: two files of one name are told apart, and no path is ever shown. */
export const folderNameOf = (source: GuestSource): string | undefined => (source.at === "file" ? source.path.replace(/[\\/][^\\/]*$/, "").split(/[\\/]/).pop() || undefined : undefined);

/** What a link is to: a project named as one, so it is not taken for a document, and a file with its folder. */
export function linkItem(l: Pick<GuestLinkRow, "source" | "title">): string {
  if (l.source.table === "projects") return `${l.title} project`;
  const folder = folderNameOf(l.source);
  return folder ? `${l.title} in ${folder}` : l.title;
}

/**
 * A link's facts, the one way they are said (docs/DESIGN.md "Share"): one comma sentence, never a run set apart by
 * dots. What the guest may do (only where the item offers a choice), what it is to (`item`: a list of every item's
 * links), when it was made, when it was last opened, and until when; an ended link says when it ended or was revoked.
 */
export function linkFacts(l: GuestLinkRow, o: { item?: boolean; now?: number } = {}): string {
  const roles = guestRolesOf(l.source.at === "file" ? l.source : { at: "lifeos", table: l.source.table });
  const seen = l.open > 0 ? "in it now" : l.lastOpenedAt ? `opened ${shortDay(l.lastOpenedAt)} ${clockTime(l.lastOpenedAt)}` : "not opened yet";
  const end = isLive(l, o.now) ? [seen, `until ${shortDay(l.expiresAt)}`] : [l.revokedAt ? `revoked ${shortDay(l.revokedAt)}` : `ended ${shortDay(l.expiresAt)}`];
  return [roles.length > 1 ? ROLE_WORDS[l.role] : null, o.item ? linkItem(l) : null, `made ${shortDay(l.createdAt)}`, ...end].filter(Boolean).join(", ");
}

export type { GuestCreated, GuestLinkRow, GuestRole, GuestSource };
