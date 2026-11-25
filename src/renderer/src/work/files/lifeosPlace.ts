import type { FilePlace } from "@shared/work/files";
import { savedOfReason } from "../shell/DownEmpty";
import { savedOfState, useLiveDown, type LiveDown, type SavedDown } from "../shell/lifeosLive";
import type { PlaceCopy } from "./model";
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
 * nothing. When that host says connected again the folder is listed again, with no press.
 */
export function useLifeosPlace(copy: PlaceCopy | null, listing: (Pick<Listing, "loaded" | "loading" | "error"> & { retry(): void }) | null): LiveDown {
  return useLiveDown(lifeosSaved(copy, listing), readsLifeos(copy) ? copy.link : null, () => listing?.retry());
}
