import { startOfDay } from "work-kit/views/lib/agenda";
import { shared } from "../tasks/store";

/**
 * Where a visit to Agenda stands: the view (List, Week, Month), the day it is on, and the New event dialog
 * (null: closed; a slot's start or `now`). A module of its own, so a view that stands inside Agenda (a
 * meeting's page, work/prep) can leave it be on the way there and back, and put it back to today when he
 * leaves for somewhere else, without loading Agenda's screen.
 */
export type AgendaShow = "list" | "week" | "month";
export const agendaPlace = shared<{ view: AgendaShow; day: number; adding: number | "now" | null }>({ view: "list", day: startOfDay(Date.now()), adding: null });

/** Each visit opens on today's list. */
export const resetAgendaPlace = (): void => agendaPlace.set({ view: "list", day: startOfDay(Date.now()), adding: null });
