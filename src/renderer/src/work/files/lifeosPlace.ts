import type { FilePage, FileSearchFilter } from "@shared/contract-work-files";
import { kindOk, wants } from "@shared/work/fileSearch";
import { PLACE, type FileEntry, type FilePlace } from "@shared/work/files";
import { savedOfReason } from "../shell/DownEmpty";
import { savedOfState, useLiveDown, type LiveDown, type SavedDown } from "../shell/lifeosLive";
import type { PlaceCopy, Sidebar } from "./model";
import type { Listing } from "./store";

/** The places Files reads through its host's LifeOS session: the LifeOS place, From mail and a project's folder. */
const LIFEOS_KINDS: ReadonlySet<FilePlace["kind"]> = new Set(["lifeos", "mail", "project"]);

export const readsLifeos = (copy: PlaceCopy | null): copy is PlaceCopy => !!copy && LIFEOS_KINDS.has(copy.place.kind);

/**
 * The cause a LifeOS place's page last heard: the session's state the host sent with the place, else the cause its
 * listing failed with; none once the folder listed (a place read before the session came back is old news). A host a
 * release behind sent `signed-out` alone for every state: the live status words it once the window hears it.
 */
export function lifeosSaved(copy: PlaceCopy | null, listing: Pick<Listing, "loaded" | "loading" | "error"> | null): SavedDown {
  if (!readsLifeos(copy)) return null;
  if (listing?.loaded && !listing.loading && !listing.error) return null;
  const { state, lifeos } = copy.place.state;
  if (state !== "ok") return savedOfState(lifeos ?? "signed-out");
  return savedOfReason(listing?.error);
}

/**
 * What a LifeOS place's page says now, by the host's live status (`useLiveDown`): the state to word, or a wait, or
 * `again` (connected heard since, and the folder is listed again with no press: the page draws the list's bones until
 * that read lands, never the old cause), or nothing.
 */
export function useLifeosPlace(copy: PlaceCopy | null, listing: (Pick<Listing, "loaded" | "loading" | "error"> & { retry(): void | Promise<void> }) | null): LiveDown {
  return useLiveDown(lifeosSaved(copy, listing), readsLifeos(copy) ? copy.link : null, () => listing?.retry());
}

/** Whether a search with this filter reads LifeOS (its documents and sheets), as the host's own LifeOS source asks. */
export const searchReadsLifeos = (filter: FileSearchFilter): boolean => wants(filter, PLACE.lifeos) && (kindOk(filter, "document") || kindOk(filter, "sheet"));

/** A row the host opens through its LifeOS session: a LifeOS document or sheet, a mail's file (a held change opens its Outbox item). */
export const readsSession = (entry: Pick<FileEntry, "ref" | "held">): boolean => !entry.held && (entry.ref?.at === "lifeos" || entry.ref?.at === "mail");

/** The place a LifeOS row or a mail's file opens from, as its own place's page opens it: LifeOS, or From mail. */
export function sessionCopyOf(sidebar: Pick<Sidebar, "lifeos" | "lenses">, entry: Pick<FileEntry, "ref">): PlaceCopy | null {
  if (entry.ref?.at === "lifeos") return sidebar.lifeos;
  if (entry.ref?.at === "mail") return sidebar.lenses.find((c) => c.place.kind === "mail") ?? null;
  return null;
}

/** The folder Show in Its Folder goes to for a LifeOS row or a mail's file: its project, else the top of LifeOS; From mail. */
export function sessionFolderOf(sidebar: Pick<Sidebar, "lifeos" | "lenses">, entry: Pick<FileEntry, "ref" | "project">): FilePage | null {
  const copy = sessionCopyOf(sidebar, entry);
  if (!copy) return null;
  if (entry.ref?.at === "lifeos" && entry.project) return { at: { at: "project", id: entry.project.id }, name: entry.project.name };
  return { at: copy.place.root, name: copy.place.name };
}
