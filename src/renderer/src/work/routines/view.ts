import { Clock } from "../../chrome/icons";
import { defineChunk } from "../../lib/lazyChunk";
import type { WorkViewDef } from "../views/registry";

/**
 * The Routines row of a linked Work workspace and its view
 * (docs/agents/work-routines.md): the workspace's routines, watches and an
 * agent's proposals, list and detail, after the four LifeOS views.
 */
export const routinesView: WorkViewDef = {
  id: "routines",
  label: "Routines",
  icon: Clock,
  order: 4,
  fact: () => null,
  // Its schedules and watches are the Work host's: signed out of LifeOS, he can still pause a run.
  readsLifeos: false,
  chunk: defineChunk("work-routines-view", () => import("./RoutinesView")),
};
