import { Layers } from "../../chrome/icons";
import { defineChunk } from "../../lib/lazyChunk";
import type { WorkViewDef } from "../views/registry";

/**
 * The Templates row of a linked Work workspace and its view
 * (docs/agents/work-templates.md "The Templates view"): the job's shelf, his
 * templates and our starters, each one press from a new file. After Files.
 */
export const templatesView: WorkViewDef = {
  id: "templates",
  label: "Templates",
  icon: Layers,
  order: 3.6,
  fact: () => null,
  // The shelf is the Work host's own: no LifeOS sign-in stands over it.
  readsLifeos: false,
  chunk: defineChunk("work-templates-view", () => import("./TemplatesView")),
};
