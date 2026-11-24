import { ListChecks } from "../../chrome/icons";
import { defineChunk } from "../../lib/lazyChunk";
import type { WorkViewDef } from "../views/registry";

/**
 * The Forms row of a Work workspace and its view (docs/agents/work-msforms.md "Forms view"): one list of the job's
 * forms, ours and Microsoft's, newest first; a row opens its form. After Files.
 */
export const formsView: WorkViewDef = {
  id: "forms",
  label: "Forms",
  icon: ListChecks,
  order: 3.55,
  fact: () => null,
  // The forms are the Work host's own rows: no LifeOS sign-in stands over them.
  readsLifeos: false,
  chunk: defineChunk("work-forms-view", () => import("./FormsView")),
};
