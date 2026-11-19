import { defineChunk } from "../../lib/lazyChunk";
import { Calendar } from "../icons";
import type { WorkViewDef } from "../views/registry";

/**
 * The Agenda row of a linked Work workspace and its view (docs/agents/work-agenda.md).
 * A stub: its view says "Not built yet" and its row has no fact until the
 * agenda pillar's milestone (25) points `chunk` at its own module and fills `fact`.
 */
export const agendaView: WorkViewDef = {
  id: "agenda",
  label: "Agenda",
  icon: Calendar,
  order: 2,
  fact: () => null,
  chunk: defineChunk("work-agenda-view", () => import("../views/NotBuilt")),
};
