import { Calendar } from "../icons";
import { defineChunk } from "../../lib/lazyChunk";
import type { WorkViewDef } from "../views/registry";

/**
 * A meeting's page (docs/agents/work-prep.md): a view of the workspace with no row of its own.
 * It is reached from an event (`openWorkView({ workspaceId, view: "prep", event })`), stands
 * inside Agenda, and Agenda's row reads as open while it shows.
 */
export const prepView: WorkViewDef = {
  id: "prep",
  label: "Meeting",
  icon: Calendar,
  order: 2.1,
  fact: () => null,
  readsLifeos: true,
  inside: "agenda",
  chunk: defineChunk("work-prep-view", () => import("./PrepView")),
};
