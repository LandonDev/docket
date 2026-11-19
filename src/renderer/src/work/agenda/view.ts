import { defineChunk } from "../../lib/lazyChunk";
import { Calendar } from "../icons";
import type { WorkViewDef } from "../views/registry";
import { useNextEvent } from "../tasks/facts";

/**
 * The Agenda row of a linked Work workspace and its view (docs/agents/work-agenda.md):
 * the sector's next two weeks from LifeOS, through the shared agenda client.
 */
export const agendaView: WorkViewDef = {
  id: "agenda",
  label: "Agenda",
  icon: Calendar,
  order: 2,
  fact: () => null,
  useFact: useNextEvent,
  chunk: defineChunk("work-agenda-view", () => import("./AgendaView")),
};
