import { Layers, Sun, type IconComponent } from "../chrome/icons";
import { workPlacesChunk } from "../surfaces/chunks";
import { shell } from "../stores/shell";
import { whenIdle } from "./hoverPrefetch";
import { digestOpensPort } from "./workSwitch";

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
};

export const WORK_PLACE_ROWS: WorkPlaceRow[] = [
  // Today: one page across every job (work/today). No count on its row: the Outbox's is beside it.
  // Its key is the Go menu's; the row's hover reads it from the Work keybindings by this label.
  { id: "today", label: "Today", order: 10, icon: Sun },
  { id: "review", label: "Review", order: 20, icon: Layers },
];

// The day's digest notice opens Today (work/digest reads the port); set here, so it holds before Today's chunk has loaded.
digestOpensPort.set(() => shell.openWorkPlace("today"));

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

/**
 * Once Work is on: the places' chunk loaded and each listed place warmed in
 * an idle slot, so its first open paints rows. The chunk brings the rest of
 * what a place does by itself (a place set to open at the day's start).
 */
export function warmWorkPlacesAtIdle(): void {
  whenIdle(() => {
    for (const row of WORK_PLACE_ROWS) warmWorkPlace(row.id, "idle");
  });
}
