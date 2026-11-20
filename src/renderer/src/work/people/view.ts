import { Users } from "../../chrome/icons";
import { defineChunk } from "../../lib/lazyChunk";
import type { WorkViewDef } from "../views/registry";

/**
 * The People row of a linked Work workspace and its view (docs/agents/work-people.md):
 * the sector's people from LifeOS, and a page for each. No trailing fact: a count of
 * people says nothing he acts on.
 */
export const peopleView: WorkViewDef = {
  id: "people",
  label: "People",
  icon: Users,
  order: 2.5,
  fact: () => null,
  readsLifeos: true,
  chunk: defineChunk("work-people-view", () => import("./PeopleView")),
};
