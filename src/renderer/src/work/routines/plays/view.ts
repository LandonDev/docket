import { Play } from "../../../chrome/icons";
import { defineChunk } from "../../../lib/lazyChunk";
import type { WorkViewDef } from "../../views/registry";

/**
 * The Plays row of a linked Work workspace and its view
 * (docs/agents/work-plays.md): the work he repeats in this job, each one
 * press from a thread. Before Routines, which may run one on a clock.
 */
export const playsView: WorkViewDef = {
  id: "plays",
  label: "Plays",
  icon: Play,
  order: 3.75,
  fact: () => null,
  // The plays are the Work host's: signed out of LifeOS, he can still start one.
  readsLifeos: false,
  chunk: defineChunk("work-plays-view", () => import("./PlaysView")),
};
