import { startOfDay } from "work-kit/views/lib/agenda";
import { shared } from "../tasks/store";
import { keepPlace, keptPlace } from "../shell/place";

/**
 * Where a visit to Agenda stands: the view (List, Week, Month), the day it is on, and the New event dialog
 * (null: closed; a slot's start or `now`). A module of its own, so a view that stands inside Agenda (a
 * meeting's page, work/prep) can leave it be on the way there and back, and put it back to today when he
 * leaves for somewhere else, without loading Agenda's screen.
 */
export type AgendaShow = "list" | "week" | "month";
export const agendaPlace = shared<{ view: AgendaShow; day: number; adding: number | "now" | null }>({ view: "list", day: startOfDay(Date.now()), adding: null });

/** Leaving Agenda for anywhere but a page inside it puts the place back to today's list; the next visit then takes its workspace's own (`restoreAgendaPlace`). */
export function resetAgendaPlace(): void {
  visit = null;
  agendaPlace.set({ view: "list", day: startOfDay(Date.now()), adding: null });
}

/** The workspace whose visit the place is: set by the first restore of a visit (the header or the view, whichever mounts first), cleared when the visit ends. */
let visit: string | null = null;
const SHOWS: readonly AgendaShow[] = ["list", "week", "month"];
type Kept = { view: AgendaShow; day: number; on: number };

/**
 * A visit starts where the workspace's last one stood (lib/workReturn.ts): its view, and its day when that visit was
 * today; a day left on another day is stale, so the visit opens on today.
 */
export function restoreAgendaPlace(workspaceId: string, now = Date.now()): void {
  if (visit === workspaceId) return;
  visit = workspaceId;
  const kept = keptPlace<Kept>(workspaceId, "agenda", { view: "string", day: "number", on: "number" });
  const today = startOfDay(now);
  agendaPlace.set({ view: kept.view && SHOWS.includes(kept.view) ? kept.view : "list", day: kept.on === today && kept.day !== undefined ? kept.day : today, adding: null });
}

/** Keeps where the visit stands now as the workspace's. */
export function keepAgendaPlace(workspaceId: string, now = Date.now()): void {
  const { view, day } = agendaPlace.get();
  keepPlace(workspaceId, "agenda", { view, day, on: startOfDay(now) });
}
