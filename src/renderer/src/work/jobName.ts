import { useCallback } from "react";
import type { WorkspaceMeta } from "../lib/tcserver/types";
import { useWorkspaces, workspaceStore } from "../lib/tcserver/workspaces";
import { sectorName } from "./shell/actions";

/**
 * A job as a person reads it (docs/DESIGN.md "Work", one name a thing): its Work workspace's name ("Purdue Esports",
 * "Refereeing"), never the sector's own word. Where two hosts hold one for the sector, the one on `home`, else the
 * first; the sector's word only where no workspace holds the sector.
 */
export function jobNameOf(sector: string, workspaces: readonly Pick<WorkspaceMeta, "kind" | "sector" | "name" | "environmentId">[], home?: string | null): string {
  const held = workspaces.filter((w) => w.kind === "work" && w.sector === sector && w.name.trim());
  return (held.find((w) => w.environmentId === home) ?? held[0])?.name ?? sectorName(sector);
}

/** `jobNameOf` against the catalog as it stands now, for words made outside a render (a toast, a notice). */
export const jobNameNow = (sector: string, home?: string | null): string => jobNameOf(sector, workspaceStore.getSnapshot().workspaces, home);

/** `jobNameOf` that follows the catalog: a renamed workspace renames its job everywhere it is read. */
export function useJobName(home?: string | null): (sector: string) => string {
  const workspaces = useWorkspaces();
  return useCallback((sector: string) => jobNameOf(sector, workspaces, home), [workspaces, home]);
}
