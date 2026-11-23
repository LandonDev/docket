import { Layers, type IconComponent } from "../chrome/icons";
import { workPlacesChunk } from "../surfaces/chunks";
import { whenIdle } from "./hoverPrefetch";

/**
 * The pages above the Work workspaces (docs/agents/work-today.md "The place
 * above the workspaces"): one row each under the rail's Work heading, before
 * the workspaces, while some host has Work on. It is first-paint code, so it
 * is plain data: a row's page lives in `work/places/registry.ts`, behind
 * `workPlacesChunk`, and a test there holds every row to a place of its id.
 *
 * Adding a page takes two lines: a row here and its place in the registry.
 * The icon is one the first paint already holds (chrome/icons).
 */
export type WorkPlaceRow = {
  id: string;
  label: string;
  order: number;
  icon: IconComponent;
  /** The chord that opens it (lib/keys.ts form, "mod+shift+T"), shown on the row's hover; the binding itself is the Go menu's. */
  key?: string;
};

export const WORK_PLACE_ROWS: WorkPlaceRow[] = [{ id: "review", label: "Review", order: 20, icon: Layers }];

/** The rows in the rail's order. */
export const workPlaceRows = (): WorkPlaceRow[] => [...WORK_PLACE_ROWS].sort((a, b) => a.order - b.order);

export const workPlaceRow = (id: string | null): WorkPlaceRow | null => WORK_PLACE_ROWS.find((row) => row.id === id) ?? null;

/** What a place is called before its row lands (a page may reach master first): its id, capitalized. */
export const workPlaceLabel = (id: string): string => workPlaceRow(id)?.label ?? `${id.slice(0, 1).toUpperCase()}${id.slice(1)}`;

/**
 * Warm a place: the frame's chunk, the place's own, then what the place
 * reads. `intent` is a hover or focus on its row; `idle` is the one slot
 * after launch, where a place decides for itself whether to read anything.
 */
export function warmWorkPlace(id: string, why: "intent" | "idle"): void {
  void workPlacesChunk.load().then(
    (m) => m.warmPlace(id, why),
    () => {},
  );
}

/** Once Work is on: each listed place warmed in an idle slot, so its first open paints rows. A window with no row asks for nothing. */
export function warmWorkPlacesAtIdle(): void {
  if (WORK_PLACE_ROWS.length === 0) return;
  whenIdle(() => {
    for (const row of WORK_PLACE_ROWS) warmWorkPlace(row.id, "idle");
  });
}
